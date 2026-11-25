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
 *
 * Example for a backend later:
 *   loadSeries = (field) => fetch(`https://my-api/series?lat=${field.lat}&lon=${field.lon}`)...
 */

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

/** Load all measurements of one field, sorted by date. */
export function loadSeries(field) {
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
  for (const field of fields) {
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
    throw new Error('The CSV file needs the columns date, NDVI and NDMI');
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
