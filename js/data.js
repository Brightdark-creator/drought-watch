/**
 * data.js — the ONLY place where the app gets data.
 *
 * Version 1 reads static files from the /data folder:
 *   data/fields.json   list of fields (name, position, outline, file name, years)
 *   data/<file>.csv    one file per field with columns date, year, NDVI, NDMI
 *                      (the format of the Google Earth Engine export script)
 *
 * To switch to a live source later (Copernicus Data Space, a small Python
 * backend, …) only this file has to change. The rest of the app uses just
 * these three functions and expects the same shapes back:
 *
 *   listFields()            -> Promise<Field[]>
 *   loadSeries(field)       -> Promise<[{ date: Date, ndvi: number|null, ndmi: number|null }]>
 *   findField(fields, lat, lon) -> Promise<{ field, km, exact }|null>
 *   readUploadedFile(file)  -> Promise<{ field, rows }>   (a CSV/JSON the user picked)
 *
 * Example for a backend later:
 *   loadSeries = (field) => fetch(`https://my-api/series?lat=${field.lat}&lon=${field.lon}`)...
 */

import { seasonAndPeriod, periodStart } from './analysis.js';

const DATA_URL = 'data/';

/** A click or search result closer than this to a test field selects it. */
export const NEAR_KM = 10;

/** Load the list of fields. */
export async function listFields() {
  const response = await fetch(DATA_URL + 'fields.json');
  if (!response.ok) throw new Error(`fields.json: HTTP ${response.status}`);
  const json = await response.json();
  return json.fields;
}

const seriesCache = new Map(); // field id -> Promise (each file is loaded only once)

/** An error the app can translate: code = 'columns' | 'tooFew' | 'unreadable' | 'live' | 'liveEmpty'. */
export class DataError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

/* ---------- Files the user uploads ---------- */

const uploads = new Map(); // field id -> rows (kept in memory only, never sent anywhere)
let uploadCount = 0;
// A unique id, also across page reloads (kept files keep their id).
const newUploadId = () => `upload-${Date.now().toString(36)}-${++uploadCount}`;

/** A file needs at least this many pictures: several years of a few pictures each. */
export const MIN_UPLOAD_ROWS = 30;

/**
 * Read a CSV or JSON file the user picked or dropped on the page.
 * The file is read in the browser and never leaves the device.
 * Returns a new field object (like the entries in fields.json) and its rows.
 */
export async function readUploadedFile(file) {
  const text = await file.text();
  const isJson = /\.json$/i.test(file.name) || text.trim().startsWith('[');
  let rows;
  try {
    rows = isJson ? parseJsonRows(JSON.parse(text)) : parseCsv(text);
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError('unreadable');
  }
  if (rows.length < MIN_UPLOAD_ROWS) throw new DataError('tooFew', { n: rows.length });
  const name = file.name.replace(/\.(csv|json)$/i, '');
  const field = {
    id: newUploadId(),
    uploaded: true,
    name: { en: name },
    short: { en: name },
    ...(isJson ? {} : readLocation(text)), // lat, lon, polygon if the file has them
  };
  uploads.set(field.id, rows);
  return { field, rows };
}

export function removeUploadedField(id) {
  uploads.delete(id);
  seriesCache.delete(id);
  forgetUpload(id);
}

/* ---------- Keeping uploaded files on this device (only if the user ticks it) ---------- */

const KEPT_KEY = 'dw.uploads';
// The settings of a field that are worth keeping (not the map pin or the rows).
const KEPT_PROPS = ['id', 'uploaded', 'name', 'short', 'lat', 'lon', 'polygon', 'season', 'seasonStartMonth', 'normalYears'];

function readKept() {
  try { return JSON.parse(localStorage.getItem(KEPT_KEY) || '[]'); } catch { return []; }
}

/** Is this uploaded field kept on the device? */
export function isUploadKept(id) {
  return readKept().some((k) => k.field.id === id);
}

/**
 * Save an uploaded field and its pictures in this browser's storage
 * (localStorage, about 25 KB per field). Returns false if the browser
 * refuses (private window, storage full).
 */
export function keepUpload(field) {
  const rows = uploads.get(field.id);
  if (!rows) return false;
  const kept = readKept().filter((k) => k.field.id !== field.id);
  const slim = Object.fromEntries(KEPT_PROPS.filter((p) => field[p] !== undefined).map((p) => [p, field[p]]));
  // Compact rows: [date, NDVI, NDMI]
  kept.push({ field: slim, rows: rows.map((r) => [r.date.toISOString().slice(0, 10), r.ndvi, r.ndmi]) });
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

export function forgetUpload(id) {
  const kept = readKept().filter((k) => k.field.id !== id);
  try { localStorage.setItem(KEPT_KEY, JSON.stringify(kept)); } catch { /* nothing to do */ }
}

/** Load the kept uploads (after a reload, or on the results page). Returns their fields. */
export function restoreKeptUploads() {
  return readKept().map(({ field, rows }) => {
    uploads.set(field.id, clean(rows.map(([date, ndvi, ndmi]) => makeRow(date, ndvi, ndmi))));
    return field;
  });
}

/**
 * Where is the field? Earth Engine CSVs have a ".geo" column with GeoJSON
 * (a Point, or a Polygon for the field outline). Columns lat/lon also work.
 * Returns { lat, lon, polygon? } or {} if the file has no position.
 */
export function readLocation(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const first = lines[1] ? splitCsvLine(lines[1]) : [];
  const geoCol = header.indexOf('.geo');
  if (geoCol >= 0 && first[geoCol]) {
    try {
      const geo = JSON.parse(first[geoCol]);
      if (geo.type === 'Point') return { lat: geo.coordinates[1], lon: geo.coordinates[0] };
      const ring = geo.type === 'Polygon' ? geo.coordinates[0] : geo.type === 'MultiPolygon' ? geo.coordinates[0][0] : null;
      if (ring) {
        const pts = ring.slice(0, -1); // the last point repeats the first
        const lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
        const lon = pts.reduce((s, c) => s + c[0], 0) / pts.length;
        return { lat, lon, polygon: ring.map((c) => [c[1], c[0]]) }; // Leaflet wants [lat, lon]
      }
    } catch { /* no usable position */ }
  }
  const latCol = header.findIndex((h) => h === 'lat' || h === 'latitude');
  const lonCol = header.findIndex((h) => h === 'lon' || h === 'lng' || h === 'longitude');
  if (latCol >= 0 && lonCol >= 0) {
    const lat = parseFloat(first[latCol]);
    const lon = parseFloat(first[lonCol]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return {};
}

/** Load all measurements of one field, sorted by date. */
export function loadSeries(field) {
  if (field.uploaded) return Promise.resolve(uploads.get(field.id) || []);
  if (field.live) return Promise.resolve(field.rows);
  if (!seriesCache.has(field.id)) {
    const promise = fetch(DATA_URL + field.file)
      .then((response) => {
        if (!response.ok) throw new Error(`${field.file}: HTTP ${response.status}`);
        return field.file.endsWith('.json')
          ? response.json().then(parseJsonRows)
          : response.text().then(parseCsv);
      });
    promise.catch(() => seriesCache.delete(field.id)); // allow a retry after an error
    seriesCache.set(field.id, promise);
  }
  return seriesCache.get(field.id);
}

/**
 * Which field belongs to a clicked/searched point?
 * Version 1: the nearest test field. `exact` is true when it is close enough.
 * A live API could instead create a new field for any point on Earth.
 */
export async function findField(fields, lat, lon) {
  let best = null;
  for (const field of fields.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon))) {
    const km = distanceKm(lat, lon, field.lat, field.lon);
    if (!best || km < best.km) best = { field, km };
  }
  return best && { ...best, exact: best.km <= NEAR_KM };
}

/** Distance between two points on Earth in kilometres (haversine formula). */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- File parsing ---------- */

/**
 * Read a CSV file. Column names are found by name (any order, any case), so
 * extra Earth Engine columns like "system:index" or ".geo" do no harm.
 * The "year" column is not needed: the season is worked out from the date.
 */
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = { date: header.indexOf('date'), ndvi: header.indexOf('ndvi'), ndmi: header.indexOf('ndmi') };
  if (col.date < 0 || col.ndvi < 0 || col.ndmi < 0) {
    throw new DataError('columns'); // the file needs the columns date, NDVI and NDMI
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    rows.push(makeRow(cells[col.date], cells[col.ndvi], cells[col.ndmi]));
  }
  return clean(rows);
}

/** Same as parseCsv, for a JSON file: [{ "date": "2018-05-01", "NDVI": 0.8, "NDMI": 0.3 }, …] */
export function parseJsonRows(list) {
  return clean(list.map((r) => makeRow(r.date, r.NDVI ?? r.ndvi, r.NDMI ?? r.ndmi)));
}

function makeRow(dateText, ndviText, ndmiText) {
  const ndvi = parseFloat(ndviText);
  const ndmi = parseFloat(ndmiText);
  return {
    date: parseDate(dateText),
    ndvi: Number.isFinite(ndvi) ? ndvi : null,
    ndmi: Number.isFinite(ndmi) ? ndmi : null,
  };
}

/** Drop rows without a date or without any value, then sort by date. */
function clean(rows) {
  return rows
    .filter((r) => r.date && (r.ndvi != null || r.ndmi != null))
    .sort((a, b) => a.date - b.date);
}

/** Accepts "2018-05-01", "2018-05-01T10:30:00" or milliseconds since 1970. */
function parseDate(value) {
  const text = String(value ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  if (/^\d{11,}$/.test(text)) {
    const d = new Date(Number(text));
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  return null;
}

/** Split one CSV line, respecting "quoted, values" (Earth Engine quotes the .geo column). */
function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/* ---------- Live data for ANY place (weather model, updated daily) ---------- */

/**
 * Anywhere on Earth, without satellite files: soil water from ERA5-Land, the
 * European weather model's land reanalysis (it blends in real measurements;
 * about 9 km grid, back to 1950, up to a few days ago), served free and
 * without a key by Open-Meteo. One request returns 16 years of daily values.
 *
 * The two values take the places of the satellite indices, with the same
 * roles: topsoil water (0–7 cm) dries out first, like leaf water (NDMI), and
 * root-zone water (0–100 cm) follows, like greenness (NDVI). Daily values are
 * averaged per 10-day period, the analysis then works exactly as for fields.
 */
const OPEN_METEO = 'https://archive-api.open-meteo.com/v1/archive';
export const LIVE_YEARS = 16;          // years downloaded: the season to check + 15 normal years (Open-Meteo counts long requests as several calls)
export const LIVE_NORMAL_YEARS = 15;   // normal years = the 15 seasons before the one checked
const liveCache = new Map();

export function liveId(lat, lon) {
  return `live-${lat.toFixed(2)}_${lon.toFixed(2)}`; // ~1 km: same click, same place
}

/** Builds the field for a place and downloads its data. Returns the field. */
export async function loadLivePlace(lat, lon, name = null) {
  const id = liveId(lat, lon);
  if (!liveCache.has(id)) {
    const today = new Date();
    const start = `${today.getUTCFullYear() - LIVE_YEARS}-01-01`;
    const url = `${OPEN_METEO}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${start}`
      + `&end_date=${today.toISOString().slice(0, 10)}&daily=soil_moisture_0_to_7cm_mean,soil_moisture_0_to_100cm_mean&timezone=GMT`;
    const promise = fetch(url).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new DataError(response.status === 429 ? 'liveBusy' : 'live', { reason: body.reason || `HTTP ${response.status}` });
      return body;
    });
    promise.catch(() => liveCache.delete(id));
    liveCache.set(id, promise);
  }
  const body = await liveCache.get(id);
  const startMonth = lat < 0 ? 7 : 1; // southern hemisphere: seasons run July to June
  const rows = liveRows(body.daily, startMonth);
  if (rows.length < 36 * 4) throw new DataError('liveEmpty');
  const seasons = [...new Set(rows.map((r) => seasonAndPeriod(r.date, startMonth).season))].sort((a, b) => a - b);
  const season = seasons[seasons.length - 1];
  return {
    id, live: true, lat, lon,
    name: { en: name || formatCoords(lat, lon) },
    short: { en: name ? name.split(',')[0] : formatCoords(lat, lon) },
    crop: 'unknown',
    season,
    seasonStartMonth: startMonth,
    normalYears: seasons.filter((s) => s < season).slice(-LIVE_NORMAL_YEARS),
    allYear: true,     // a soil drought counts in every month, not only in the growing season
    sdFloor: 0.005,    // m³/m³: below this the soil-water swings are model noise
    gridKm: 9,
    sources: [
      { title: 'Open-Meteo Historical Weather API (ERA5-Land)', url: 'https://open-meteo.com/en/docs/historical-weather-api' },
      { title: 'ERA5-Land, Copernicus Climate Change Service', url: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land' },
    ],
    elevation: body.elevation,
    // The model cell (about 9 km) as an outline on the map: the value is for this whole square
    polygon: square(body.latitude ?? lat, body.longitude ?? lon, 9),
    rows,
  };
}

/** Daily values -> one row per 10-day period (mean), in the shape the analysis expects. */
function liveRows(daily, startMonth) {
  const sums = new Map();
  daily.time.forEach((day, i) => {
    const top = daily.soil_moisture_0_to_7cm_mean[i];
    const root = daily.soil_moisture_0_to_100cm_mean[i];
    if (top == null || root == null) return;
    const { season, period } = seasonAndPeriod(new Date(`${day}T00:00:00Z`), startMonth);
    const key = `${season}:${period}`;
    const s = sums.get(key) || { season, period, top: 0, root: 0, n: 0 };
    s.top += top; s.root += root; s.n += 1;
    sums.set(key, s);
  });
  return [...sums.values()]
    .filter((s) => s.n >= 5) // at least half a period of days
    .map((s) => ({
      date: periodStart(s.season, s.period, startMonth),
      ndvi: s.root / s.n,   // slot 1: root-zone water (confirms, like greenness)
      ndmi: s.top / s.n,    // slot 2: topsoil water (warns first, like leaf water)
    }))
    .filter((r) => r.ndvi > 0.005) // all-zero cells are ice, rock or sea
    .sort((a, b) => a.date - b.date);
}

function square(lat, lon, km) {
  const dLat = km / 2 / 111.32;
  const dLon = km / 2 / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [[lat - dLat, lon - dLon], [lat - dLat, lon + dLon], [lat + dLat, lon + dLon], [lat + dLat, lon - dLon]];
}

function formatCoords(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}
