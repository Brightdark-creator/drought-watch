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

/** An error the app can translate: code = 'columns' | 'tooFew' | 'unreadable' | 'live' | 'liveEmpty' | 'liveBusy' | 'areaTooBig'. */
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

// NDVI and NDMI are ratios between −1 and 1. Anything outside is a broken
// picture (e.g. almost no light in winter, so it divides by nearly zero): dropped.
const usable = (v) => Number.isFinite(v) && v >= -1 && v <= 1;

function makeRow(dateText, ndviText, ndmiText) {
  const ndvi = parseFloat(ndviText);
  const ndmi = parseFloat(ndmiText);
  return {
    date: parseDate(dateText),
    ndvi: usable(ndvi) ? ndvi : null,
    ndmi: usable(ndmi) ? ndmi : null,
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
    const promise = remembered(`era.${id}`, () => fetchEra(lat, lon))
      // ERA5 busy (only a few places per minute) or unreachable: carry on with NASA's soil data
      .catch((error) => (error.code === 'liveEmpty' ? Promise.reject(error) : powerSoil(lat, lon)));
    promise.catch(() => liveCache.delete(id));
    liveCache.set(id, promise);
  }
  const body = await liveCache.get(id);
  const startMonth = lat < 0 ? 7 : 1; // southern hemisphere: seasons run July to June
  const rows = body.rows;
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
    model: body.model, // 'era' normally, 'merra' when ERA5 was busy
    sdFloor: 0.005,    // m³/m³: below this the soil-water swings are model noise
    gridKm: body.model === 'merra' ? 50 : 9,
    sources: [
      { title: 'Open-Meteo Historical Weather API (ERA5-Land)', url: 'https://open-meteo.com/en/docs/historical-weather-api' },
      { title: 'ERA5-Land, Copernicus Climate Change Service', url: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land' },
    ],
    elevation: body.elevation,
    // The model cell (about 9 km) as an outline on the map: the value is for this whole square
    polygon: square(body.latitude ?? lat, body.longitude ?? lon, body.model === 'merra' ? 50 : 9),
    rows,
  };
}

async function fetchEra(lat, lon) {
  const today = new Date();
  const start = `${today.getUTCFullYear() - LIVE_YEARS}-01-01`;
  const url = `${OPEN_METEO}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${start}`
    + `&end_date=${today.toISOString().slice(0, 10)}&daily=soil_moisture_0_to_7cm_mean,soil_moisture_0_to_100cm_mean&timezone=GMT`;
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new DataError(response.status === 429 ? 'liveBusy' : 'live', { reason: body.reason || `HTTP ${response.status}` });
  const rows = liveRows(body.daily, 1);
  if (rows.length < 36 * 4) throw new DataError('liveEmpty');
  return { model: 'era', rows, latitude: body.latitude, longitude: body.longitude, elevation: body.elevation };
}

/** NASA MERRA-2 surface and root-zone wetness in the same two slots (the fallback). */
async function powerSoil(lat, lon) {
  const power = await loadPower(lat, lon);
  if (power.soilPair.length < 36 * 4) throw new DataError('liveEmpty');
  return { model: 'merra', rows: power.soilPair, latitude: lat, longitude: lon };
}

/**
 * Keeps a download on this device for 12 hours (localStorage), so opening the
 * same place again, or sharing its link, costs nothing. Rows are stored with
 * their dates as numbers. If storage is full or blocked, it simply downloads.
 */
const KEEP_MS = 12 * 3600 * 1000;
async function remembered(key, load) {
  const storeKey = `dw.c.${key}`;
  try {
    const kept = JSON.parse(localStorage.getItem(storeKey) || 'null');
    if (kept && Date.now() - kept.t < KEEP_MS) {
      return { ...kept.v, rows: kept.v.rows.map(([d, a, b, f]) => ({ date: new Date(d), ndvi: a, ndmi: b, ...(f != null ? { flow: f } : {}) })) };
    }
  } catch { /* private window or damaged entry: download */ }
  const value = await load();
  try {
    const rows = value.rows.map((r) => [r.date.getTime(), +r.ndvi.toFixed(5), +r.ndmi.toFixed(5), r.flow != null ? +r.flow.toFixed(4) : null]);
    localStorage.setItem(storeKey, JSON.stringify({ t: Date.now(), v: { ...value, rows } }));
  } catch {
    // Storage full: drop our old entries and carry on without keeping this one
    try { Object.keys(localStorage).filter((k) => k.startsWith('dw.c.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  }
  return value;
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

/* ---------- Live data for an AREA (dragged on the map) ---------- */

/**
 * An area is sampled at up to 4 points, one per part of the rectangle, each
 * at least one model square (9 km) apart. Why only 4: the free service allows
 * about 600 "units" per minute and 16 years at one point cost about 90, so 4
 * points stay well inside one minute. The area's value per period is the mean
 * of its points; the card also says how many points are red or yellow.
 */
export const AREA_MAX_POINTS = 4;
export const AREA_MAX_KM = 300;

/** Width and height of a { south, west, north, east } box in km. */
export function areaSizeKm(b) {
  const midLat = ((b.south + b.north) / 2) * (Math.PI / 180);
  return { w: (b.east - b.west) * 111.32 * Math.cos(midLat), h: (b.north - b.south) * 111.32 };
}

/** Sample points: a cols × rows grid (cols·rows ≤ 4) with one point in the middle of each cell. */
export function areaPoints(b) {
  const { w, h } = areaSizeKm(b);
  let cols = Math.min(4, Math.max(1, Math.round(w / 9)));
  let rows = Math.min(4, Math.max(1, Math.round(h / 9)));
  while (cols * rows > AREA_MAX_POINTS) { if (cols >= rows) cols -= 1; else rows -= 1; }
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        lat: b.south + ((r + 0.5) * (b.north - b.south)) / rows,
        lon: b.west + ((c + 0.5) * (b.east - b.west)) / cols,
      });
    }
  }
  return points;
}

export function areaId(b) {
  return `area-${[b.south, b.west, b.north, b.east].map((v) => v.toFixed(2)).join('_')}`;
}

/** Downloads every sample point (cached per point) and builds one field for the whole area. */
export async function loadLiveArea(b, name = null) {
  const { w, h } = areaSizeKm(b);
  if (Math.max(w, h) > AREA_MAX_KM) throw new DataError('areaTooBig', { km: AREA_MAX_KM });
  const points = await Promise.all(areaPoints(b).map((p) => loadLivePlace(p.lat, p.lon)));
  // Mean of the points, only for periods every point has (sea points have no data and fail above)
  const byDate = new Map();
  for (const point of points) {
    for (const row of point.rows) {
      const key = row.date.getTime();
      const s = byDate.get(key) || { date: row.date, ndvi: 0, ndmi: 0, n: 0 };
      s.ndvi += row.ndvi; s.ndmi += row.ndmi; s.n += 1;
      byDate.set(key, s);
    }
  }
  const rows = [...byDate.values()].filter((s) => s.n === points.length)
    .map((s) => ({ date: s.date, ndvi: s.ndvi / s.n, ndmi: s.ndmi / s.n }))
    .sort((x, y) => x.date - y.date);
  const lat = (b.south + b.north) / 2;
  const lon = (b.west + b.east) / 2;
  const label = name || `${Math.round(w)} × ${Math.round(h)} km`;
  return {
    ...points[0], // same season, start month, normal years and sources as a single place
    id: areaId(b),
    area: true,
    bounds: b,
    lat, lon,
    name: { en: label },
    short: { en: label.split(',')[0] },
    sizeKm: { w, h },
    points,
    polygon: [[b.south, b.west], [b.south, b.east], [b.north, b.east], [b.north, b.west]],
    rows,
  };
}

/* ---------- More sources for the same place: NASA POWER ---------- */

/**
 * A second, independent opinion for any place: NASA's MERRA-2 model (via the
 * free NASA POWER service, about 50 km squares, 1981 to two days ago).
 *   soil: root-zone soil wetness (0 = dry, 1 = full), 10-day mean
 *   rain: rain in the last 90 days (mm), the classic "meteorological drought"
 *         measure (like the SPI used by weather services)
 * Both come as rows in the same shape as the other data (value in both slots),
 * so the same analysis judges them against the same normal years.
 */
const POWER = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const powerCache = new Map();

export async function loadPower(lat, lon) {
  const id = liveId(lat, lon);
  if (!powerCache.has(id)) {
    const today = new Date();
    const day = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
    const url = `${POWER}?parameters=GWETROOT,GWETTOP,PRECTOTCORR,T2M_MAX,T2M_MIN&community=AG&latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&start=${today.getUTCFullYear() - LIVE_YEARS}0101&end=${day(today)}&format=JSON`;
    const promise = fetch(url).then((r) => {
      if (!r.ok) throw new DataError('live', { reason: `NASA POWER HTTP ${r.status}` });
      return r.json();
    });
    promise.catch(() => powerCache.delete(id));
    powerCache.set(id, promise);
  }
  const body = await powerCache.get(id);
  const p = body.properties.parameter;
  const fill = body.header?.fill_value ?? -999;
  const ok = (v) => v != null && v !== fill;

  // Day by day: rain and the water the air "asks for" (reference evaporation, Hargreaves)
  const days = [];
  for (const ymd of Object.keys(p.PRECTOTCORR)) {
    const date = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
    const tmax = p.T2M_MAX[ymd];
    const tmin = p.T2M_MIN[ymd];
    days.push({
      date,
      wet: ok(p.GWETROOT[ymd]) ? p.GWETROOT[ymd] : null,
      top: ok(p.GWETTOP[ymd]) ? p.GWETTOP[ymd] : null,
      rain: ok(p.PRECTOTCORR[ymd]) ? p.PRECTOTCORR[ymd] : null,
      tmax: ok(tmax) ? tmax : null,
      et0: ok(tmax) && ok(tmin) ? hargreaves(lat, date, tmax, tmin) : null,
    });
  }

  // Per 10-day period (calendar thirds, the same periods for every season start)
  const periods = new Map();
  for (const d of days) {
    const third = Math.min(2, Math.floor((d.date.getUTCDate() - 1) / 10));
    const key = `${d.date.getUTCFullYear()}-${d.date.getUTCMonth()}-${third}`;
    const s = periods.get(key) || { date: new Date(Date.UTC(d.date.getUTCFullYear(), d.date.getUTCMonth(), 1 + third * 10)), days: 0, wet: [], top: [], rain: [], et0: [], tmax: [] };
    s.days += 1;
    for (const k of ['wet', 'top', 'rain', 'et0', 'tmax']) if (d[k] != null) s[k].push(d[k]);
    periods.set(key, s);
  }
  const list = [...periods.values()].sort((a, b) => a.date - b.date);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const total = (s, k) => mean(s[k]) * s.days; // period total, gaps filled with the period's mean
  const full = (s, k) => s[k].length >= Math.min(8, s.days);
  const row = (date, v) => ({ date, ndvi: v, ndmi: v });

  const soil = list.filter((s) => s.wet.length >= 5).map((s) => row(s.date, mean(s.wet)));
  // Surface (top 5 cm) and root zone, like ERA5's topsoil and root zone: used when ERA5 is busy
  const soilPair = list.filter((s) => s.wet.length >= 5 && s.top.length >= 5).map((s) => ({ date: s.date, ndvi: mean(s.wet), ndmi: mean(s.top) }));
  const rain = [];
  const balance = [];
  const heat = [];
  list.forEach((s, i) => {
    const w90 = list.slice(Math.max(0, i - 8), i + 1);   // ≈ 90 days: this period and the 8 before
    const w30 = list.slice(Math.max(0, i - 2), i + 1);   // ≈ 30 days
    if (w90.length === 9 && w90.every((w) => full(w, 'rain'))) {
      const mm = w90.reduce((sum, w) => sum + total(w, 'rain'), 0);
      rain.push(row(s.date, mm));
      if (w90.every((w) => full(w, 'et0'))) balance.push(row(s.date, mm - w90.reduce((sum, w) => sum + total(w, 'et0'), 0)));
    }
    // Heat: hotter is worse, but the analysis warns when a value is LOW, so the
    // mean daily maximum is stored with a minus sign (and shown as °C again).
    if (w30.length === 3 && w30.every((w) => full(w, 'tmax'))) heat.push(row(s.date, -mean(w30.flatMap((w) => w.tmax))));
  });

  /** Normal rain for the same calendar days (e.g. the next 16 days) in the given years: mean total in mm. */
  const rainByDay = new Map(days.filter((d) => d.rain != null).map((d) => [d.date.toISOString().slice(0, 10), d.rain]));
  const normalRain = (from, nDays, years) => {
    const totals = years.map((y) => {
      let sum = 0;
      for (let k = 0; k < nDays; k++) {
        const d = new Date(Date.UTC(y, from.getUTCMonth(), from.getUTCDate() + k));
        const v = rainByDay.get(d.toISOString().slice(0, 10));
        if (v == null) return null;
        sum += v;
      }
      return sum;
    }).filter((v) => v != null);
    return totals.length ? mean(totals) : null;
  };

  return { soil, soilPair, rain, balance, heat, normalRain, lastDate: list.filter((s) => s.wet.length).at(-1)?.date ?? null };
}

/**
 * Reference evaporation (mm/day) from the daily highest and lowest temperature:
 * the Hargreaves formula, which FAO recommends when only temperature is known
 * (FAO Irrigation and Drainage Paper 56, equations 21–25 and 52).
 */
export function hargreaves(lat, date, tmax, tmin) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const J = Math.round((date - start) / 86400000);           // day of the year
  const phi = (lat * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * J) / 365);   // Earth–Sun distance
  const delta = 0.409 * Math.sin((2 * Math.PI * J) / 365 - 1.39); // Sun's declination
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta)))); // sunset angle
  const Ra = ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
  const tmean = (tmax + tmin) / 2;
  return Math.max(0, 0.0023 * 0.408 * Ra * (tmean + 17.8) * Math.sqrt(Math.max(0, tmax - tmin)));
}

/* ---------- River flow (GloFAS, via Open-Meteo) ---------- */

/**
 * Daily river discharge from GloFAS, the Copernicus global flood model (5 km
 * river network, 1984 to today). Low flow is "hydrological drought", the last
 * stage after the soil. River flows are very uneven (a flood is 100 × a dry
 * month), so the analysis compares the logarithm of the 10-day mean flow.
 */
const FLOOD = 'https://flood-api.open-meteo.com/v1/flood';
const riverCache = new Map();

export async function loadRiver(lat, lon) {
  const id = liveId(lat, lon);
  if (!riverCache.has(id)) {
    const promise = remembered(`river.${id}`, () => fetchRiver(lat, lon));
    promise.catch(() => riverCache.delete(id));
    riverCache.set(id, promise);
  }
  return (await riverCache.get(id)).rows;
}

async function fetchRiver(lat, lon) {
  const today = new Date();
  const url = `${FLOOD}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=river_discharge`
    + `&start_date=${today.getUTCFullYear() - LIVE_YEARS}-01-01&end_date=${today.toISOString().slice(0, 10)}`;
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new DataError(r.status === 429 ? 'liveBusy' : 'live', { reason: body.reason || `HTTP ${r.status}` });
  const sums = new Map();
  body.daily.time.forEach((day, i) => {
    const q = body.daily.river_discharge[i];
    if (q == null) return;
    const date = new Date(`${day}T00:00:00Z`);
    const third = Math.min(2, Math.floor((date.getUTCDate() - 1) / 10));
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${third}`;
    const s = sums.get(key) || { date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1 + third * 10)), q: 0, n: 0 };
    s.q += q; s.n += 1;
    sums.set(key, s);
  });
  const rows = [...sums.values()].filter((s) => s.n >= 5)
    .map((s) => { const v = Math.log10(s.q / s.n + 0.01); return { date: s.date, ndvi: v, ndmi: v, flow: s.q / s.n }; })
    .sort((a, b) => a.date - b.date);
  if (rows.length < 36 * 4 || rows.every((r) => r.flow < 0.001)) throw new DataError('liveEmpty');
  return { rows };
}

/* ---------- The next 16 days (weather forecast, via Open-Meteo) ---------- */

/** Forecast rain and evaporation demand for the next 16 days (one cheap request). */
export async function loadOutlook(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + '&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max&forecast_days=16&timezone=GMT';
  const r = await fetch(url);
  if (!r.ok) throw new DataError(r.status === 429 ? 'liveBusy' : 'live');
  const d = (await r.json()).daily;
  const sum = (a) => a.reduce((x, y) => x + (y ?? 0), 0);
  return {
    from: new Date(`${d.time[0]}T00:00:00Z`),
    days: d.time.length,
    rain: sum(d.precipitation_sum),
    et0: sum(d.et0_fao_evapotranspiration),
    tmax: Math.max(...d.temperature_2m_max.filter((v) => v != null)),
  };
}
