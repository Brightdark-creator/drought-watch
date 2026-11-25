/**
 * analysis.js — the science part of the app.
 *
 * Input:  a list of satellite measurements for one field
 *         [{ date: Date, ndvi: number|null, ndmi: number|null }, ...]
 * Output: for every 10-day period of the chosen season: the value, the
 *         field's normal value (average of its normal years), the normal
 *         variation (standard deviation), the anomaly (z-score) and a
 *         traffic-light level.
 *
 * Key idea: every field is compared ONLY WITH ITSELF on the same dates.
 * There is no fixed NDVI limit and no fixed crop calendar, because what is
 * "normal" depends on the crop, the soil and the climate.
 *
 * This file does no drawing and no loading, so it is easy to test and to
 * explain on its own.
 */

/* ---------- Settings (all in one place so they are easy to explain) ---------- */

/** A season is split into 36 periods of about 10 days (1st–10th, 11th–20th, 21st–end of each month). */
export const PERIODS = 36;

/** Yellow ("watch") when the value is more than 1 standard deviation below normal. */
export const YELLOW_Z = -1;

/** Red ("drought stress") when more than 2 standard deviations below normal… */
export const RED_Z = -2;
/** …in this many periods in a row. */
export const RED_PERIODS_IN_A_ROW = 2;

/**
 * Smallest standard deviation we allow. With only a few normal years the
 * measured SD can by chance be almost zero, and then a tiny difference would
 * look like a huge anomaly. 0.02 is about the measurement noise of
 * Sentinel-2 NDVI/NDMI. This is a noise limit, not a fixed drought threshold.
 */
export const SD_FLOOR = 0.02;

/** We need at least this many normal years to say what "normal" is. */
export const MIN_NORMAL_YEARS = 3;

/** A normal year needs at least this many periods with pictures to be used. */
export const MIN_PERIODS_PER_YEAR = 9;

/**
 * Gaps of up to 3 cloudy periods (30 days) in a normal year are filled by
 * drawing a straight line between the pictures before and after.
 */
export const MAX_GAP_FILL = 3;

/**
 * Growing season = periods where the field's average NDVI in normal years is
 * in the upper half between its own lowest and highest value. It comes from
 * the field's own data, so it works for any crop and hemisphere.
 */
export const SEASON_SHARE = 0.5;

/** A symbol for every level, so the warning never depends on colour alone. */
export const SYMBOLS = { green: '✓', yellow: '!', red: '✕', off: '–', unknown: '?' };

const RANK = { green: 1, yellow: 2, red: 3 };
const INDICES = ['ndvi', 'ndmi'];
const range = (n) => Array.from({ length: n }, (_, i) => i);

/* ---------- Calendar helpers ---------- */

/**
 * Which season and which 10-day period a date belongs to.
 * startMonth lets a season start in another month (e.g. 7 = July for fields
 * in the southern hemisphere, where the season crosses New Year).
 */
export function seasonAndPeriod(date, startMonth = 1) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1..12
  const day = date.getUTCDate();
  const monthInSeason = (month - startMonth + 12) % 12; // 0..11
  const season = month >= startMonth ? year : year - 1;
  const period = monthInSeason * 3 + Math.min(2, Math.floor((day - 1) / 10));
  return { season, period };
}

/** First day of a period (used for the chart's date axis). */
export function periodStart(season, period, startMonth = 1) {
  const monthIndex = startMonth - 1 + Math.floor(period / 3);
  const year = season + Math.floor(monthIndex / 12);
  const day = 1 + (period % 3) * 10;
  return new Date(Date.UTC(year, monthIndex % 12, day));
}

/* ---------- Step 1: one value per 10-day period ("compositing") ---------- */

/**
 * Clouds and haze make NDVI too LOW, never too high. So within each period we
 * keep the picture with the highest NDVI ("maximum value composite", a
 * standard method in remote sensing) and take its NDMI from the same picture.
 */
function composite(rows, startMonth) {
  const seasons = new Map(); // season -> array of 36 rows (or null)
  for (const row of rows) {
    const { season, period } = seasonAndPeriod(row.date, startMonth);
    if (!seasons.has(season)) seasons.set(season, new Array(PERIODS).fill(null));
    const periods = seasons.get(season);
    const best = periods[period];
    if (!best || (row.ndvi ?? -Infinity) > (best.ndvi ?? -Infinity)) periods[period] = row;
  }
  return seasons;
}

/** Fill short gaps in a series with a straight line (only used for normal years). */
function fillGaps(values, maxGap = MAX_GAP_FILL) {
  const out = values.slice();
  let last = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    const gap = i - last - 1;
    if (last >= 0 && gap > 0 && gap <= maxGap) {
      for (let j = last + 1; j < i; j++) {
        out[j] = values[last] + (values[i] - values[last]) * (j - last) / (i - last);
      }
    }
    last = i;
  }
  return out;
}

/** Average and sample standard deviation of a list of numbers. */
function meanAndSd(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, sd: Math.sqrt(variance) };
}

/* ---------- Step 3: the warning rule ---------- */

/**
 * Level of one index (NDVI or NDMI) in period p.
 * Uses only period p and the period before, so it gives the same answer as
 * the app would have given on that day (no peeking into the future).
 */
function indexLevel(z, p) {
  if (z[p] == null) return null;
  if (z[p] < RED_Z) {
    // Find the previous period with a picture (allow one cloudy period between).
    let q = p - 1;
    while (q >= 0 && z[q] == null && p - q <= 2) q--;
    const previousAlsoRed = q >= 0 && p - q <= 2 && z[q] != null && z[q] < RED_Z;
    // RED_PERIODS_IN_A_ROW is 2: this period and the previous one.
    return previousAlsoRed ? 'red' : 'yellow';
  }
  if (z[p] < YELLOW_Z) return 'yellow';
  return 'green';
}

/** Overall level = the worse of NDVI and NDMI. */
function overallLevel(result, p) {
  const hasPicture = INDICES.some((k) => result[k].values[p] != null);
  if (!hasPicture) return null;
  // No normal values to compare with (too few normal years): say so honestly.
  if (INDICES.every((k) => result[k].mean[p] == null)) return 'unknown';
  if (!result.inSeason[p]) return 'off';
  const levels = INDICES.map((k) => result[k].level[p]).filter(Boolean);
  if (levels.length === 0) return 'unknown';
  return levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/* ---------- Main function ---------- */

/**
 * Analyse one field.
 * @param field  entry from fields.json (season, normalYears, seasonStartMonth are optional)
 * @param rows   measurements from data.js
 */
export function analyseField(field, rows) {
  const startMonth = field.seasonStartMonth || 1;
  const bySeason = composite(rows, startMonth);
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  const season = field.season ?? seasons[seasons.length - 1];
  const pictureCount = (s) => (bySeason.get(s) || []).filter(Boolean).length;

  // Normal years: from fields.json if given, otherwise every other season.
  const normalYears = (field.normalYears ?? seasons)
    .filter((y) => y !== season && pictureCount(y) >= MIN_PERIODS_PER_YEAR);

  // Step 1: one value per period for the normal years (gaps filled) …
  const normals = {};
  for (const y of normalYears) {
    const periods = bySeason.get(y);
    normals[y] = {};
    for (const k of INDICES) normals[y][k] = fillGaps(periods.map((r) => r?.[k] ?? null));
  }
  // … and for this season (gaps NOT filled: we only judge real pictures).
  const current = bySeason.get(season) || new Array(PERIODS).fill(null);

  const result = {
    field,
    season,
    startMonth,
    normalYears,
    normals,
    labels: range(PERIODS).map((p) => periodStart(season, p, startMonth)),
    dates: current.map((r) => r?.date ?? null), // real picture date per period
  };

  // Step 2: normal value, normal variation and anomaly for each index.
  for (const k of INDICES) {
    const mean = [];
    const sd = [];
    const n = []; // how many normal years have a value in this period
    for (const p of range(PERIODS)) {
      const vals = normalYears.map((y) => normals[y][k][p]).filter((v) => v != null);
      n.push(vals.length);
      if (vals.length >= MIN_NORMAL_YEARS) {
        const s = meanAndSd(vals);
        mean.push(s.mean);
        sd.push(Math.max(s.sd, SD_FLOOR));
      } else {
        mean.push(null);
        sd.push(null);
      }
    }
    const values = current.map((r) => r?.[k] ?? null);
    // z-score: how many standard deviations above (+) or below (−) normal.
    const z = values.map((v, p) => (v == null || mean[p] == null ? null : (v - mean[p]) / sd[p]));
    result[k] = { values, mean, sd, n, z, level: z.map((_, p) => indexLevel(z, p)) };
  }

  // Growing season from the field's own normal NDVI curve.
  const known = result.ndvi.mean.filter((v) => v != null);
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const cut = lo + SEASON_SHARE * (hi - lo);
  result.inSeason = result.ndvi.mean.map((v) => known.length > 0 && v != null && v >= cut);

  // Step 3: overall traffic light per period.
  result.overall = range(PERIODS).map((p) => overallLevel(result, p));
  result.dataPeriods = range(PERIODS).filter((p) => result.overall[p] != null);

  // Default view: the latest picture inside the growing season.
  const inSeasonPeriods = result.dataPeriods.filter((p) => result.inSeason[p]);
  result.defaultPeriod = inSeasonPeriods.at(-1) ?? result.dataPeriods.at(-1) ?? null;
  result.typicalYear = mostTypicalYear(result);
  return result;
}

/** The normal year closest to the average (used for "compare with a normal year"). */
function mostTypicalYear(result) {
  let best = null;
  let bestError = Infinity;
  for (const y of result.normalYears) {
    let sum = 0;
    let n = 0;
    result.ndvi.mean.forEach((m, p) => {
      const v = result.normals[y].ndvi[p];
      if (result.inSeason[p] && m != null && v != null) { sum += (v - m) ** 2; n++; }
    });
    if (n > 0 && sum / n < bestError) { bestError = sum / n; best = y; }
  }
  return best;
}

/* ---------- Whole-season summary (for the results page) ---------- */

/**
 * Key numbers of a whole season:
 *  warningStart  first period of the warning that led to the first red (or the first yellow)
 *  firstRed      first red period
 *  lead          early-warning lead time (see leadTime)
 *  lowestNdmi / lowestNdvi   most negative z-score in the growing season and when
 *  redPeriods    how many periods were red
 */
export function seasonSummary(result) {
  const inSeason = result.dataPeriods.filter((p) => result.inSeason[p]);
  const isWarning = (p) => result.overall[p] === 'yellow' || result.overall[p] === 'red';
  const firstRed = inSeason.find((p) => result.overall[p] === 'red') ?? null;
  const firstWarning = inSeason.find(isWarning) ?? null;
  const lowest = (key) => {
    let best = null;
    for (const p of inSeason) {
      const z = result[key].z[p];
      if (z != null && (best == null || z < best.z)) best = { z, period: p };
    }
    return best;
  };
  const worst = inSeason.some((p) => result.overall[p] === 'red') ? 'red' : firstWarning != null ? 'yellow' : 'green';
  return {
    worst,
    firstRed,
    warningStart: firstRed != null ? warningSince(result, firstRed) : firstWarning,
    lead: leadTime(result, PERIODS - 1),
    lowestNdmi: lowest('ndmi'),
    lowestNdvi: lowest('ndvi'),
    redPeriods: inSeason.filter((p) => result.overall[p] === 'red').length,
    pictures: inSeason.length,
  };
}

/* ---------- How sure is the result? ---------- */

/** Rules for the confidence label (all in one place so they are easy to explain). */
export const CONFIDENCE = {
  goodNormalYears: 5,   // 5+ normal years: "normal" is well known
  maxGapDays: 20,       // previous picture at most 20 days earlier (needed for "2 in a row")
  nearLimit: 0.25,      // within 0.25 SD of the −1 or −2 limit = close call
};

/**
 * Confidence of the result in period p: 'high', 'medium' or 'low', with the reasons.
 *  - low:    only the minimum of normal years, or no picture in the 30 days before
 *  - high:   5+ normal years, a recent previous picture and not a close call
 *  - medium: everything in between
 */
export function confidence(result, p) {
  if (p == null || result.overall[p] == null) return null;
  const counts = INDICES.map((k) => result[k].n[p]).filter((c) => c > 0);
  const normalYears = counts.length ? Math.min(...counts) : 0;
  const previous = result.dataPeriods.filter((q) => q < p).at(-1);
  const gapDays = previous == null ? null : Math.round((result.dates[p] - result.dates[previous]) / 86400000);
  const zs = INDICES.map((k) => result[k].z[p]).filter((z) => z != null);
  const nearLimit = result.inSeason[p] && zs.some((z) => [YELLOW_Z, RED_Z].some((lim) => Math.abs(z - lim) < CONFIDENCE.nearLimit));

  const fewYears = normalYears <= MIN_NORMAL_YEARS;
  const longGap = gapDays == null || gapDays > 30;
  let level = 'medium';
  if (fewYears || longGap) level = 'low';
  else if (normalYears >= CONFIDENCE.goodNormalYears && gapDays <= CONFIDENCE.maxGapDays && !nearLimit) level = 'high';
  return { level, normalYears, gapDays, nearLimit };
}

/**
 * Early-warning lead time — the main result for the science fair.
 * Leaves lose water before they lose colour. So: when greenness (NDVI) first
 * fell far below normal (red), how many days earlier had leaf water (NDMI)
 * already been below normal without a break? Uses only pictures up to `upTo`.
 * Returns { ndmiStart, ndviRed, days } or null.
 */
export function leadTime(result, upTo) {
  const periods = result.dataPeriods.filter((p) => p <= upTo && result.inSeason[p]);
  const ndviRed = periods.find((p) => result.ndvi.level[p] === 'red');
  if (ndviRed == null) return null;
  const before = periods.filter((q) => q <= ndviRed).reverse(); // newest first
  const ndmiLow = (q) => result.ndmi.z[q] != null && result.ndmi.z[q] < YELLOW_Z;
  // The last NDMI warning at or before the NDVI red (leaf water may already
  // have started to recover by then), then back to the start of that run.
  const last = before.findIndex(ndmiLow);
  if (last < 0) return null;
  let start = before[last];
  for (const q of before.slice(last + 1)) {
    if (!ndmiLow(q)) break;
    start = q;
  }
  if (start === ndviRed) return null;
  const days = Math.round((result.dates[ndviRed] - result.dates[start]) / 86400000);
  return { ndmiStart: start, ndviRed, days };
}

/**
 * When did the current warning start? Walks back from period `p` through the
 * pictures as long as they are yellow or red. Returns null if `p` is not a
 * warning. Example: green, yellow, red, red (= p) -> the yellow period.
 */
export function warningSince(result, p) {
  const isWarning = (q) => result.overall[q] === 'yellow' || result.overall[q] === 'red';
  if (!isWarning(p)) return null;
  const earlier = result.dataPeriods.filter((q) => q <= p).reverse();
  let start = p;
  for (const q of earlier) {
    if (!isWarning(q)) break;
    start = q;
  }
  return start;
}
