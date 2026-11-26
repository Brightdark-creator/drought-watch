/**
 * app.js — connects everything: user input -> data -> analysis -> screen.
 *
 *   data.js      loads fields and measurements
 *   analysis.js  computes normal range, anomaly and traffic light
 *   map.js       world map        charts.js  line charts
 *   i18n.js / lang.js  all texts, dates and numbers
 */
import * as Data from './data.js';
import { analyseField, combineLevels, availableSeasons, checkNormalYears, peakPeriod, warningSince, leadTime, confidence, MIN_NORMAL_YEARS, SYMBOLS } from './analysis.js';
import { plantSvg, meterHtml, timelineHtml, gaugeSvg, evidenceGridHtml } from './visuals.js';
import {
  t, setVariant, pick, setLanguage, getLanguage, initialLanguage, applyStaticTexts, LANGUAGES, locale,
  formatDate, formatShortDate, formatNumber, formatSigned, formatKm, formatHectares, formatList,
} from './i18n.js';
import { STRINGS } from './lang.js';
import * as MapView from './map.js';
import { IndexChart, loadChartJs } from './charts.js';
import { drawLiteChart } from './charts-lite.js';
import { searchPlace, reversePlace } from './geocode.js';

/* ---------- App state (everything the screen shows comes from here) ---------- */
const state = {
  fields: [],
  analyses: new Map(), // field id -> Promise of analysis result
  selectedId: null,
  period: null,        // the 10-day period chosen with the slider
  compare: false,
  compareYear: null,
  spaceKind: 'rgb',    // "Seen from space": true colour or greenness map
  light: false,        // light mode = no map
};
const charts = {};

const $ = (id) => document.getElementById(id);
const currentField = () => state.fields.find((f) => f.id === state.selectedId) || null;

/* Small helpers for saved preferences (may fail in private windows). */
function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not important */ }
}

/** Escape text before putting it into HTML. */
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Start ---------- */
async function init() {
  setLanguage(readPref('dw.lang', null) || initialLanguage());
  buildLanguageMenu();
  applyStaticTexts();

  // Slow connection or "data saver" switched on? Then start in light mode.
  const net = navigator.connection;
  const slow = !!net && (net.saveData || /(^|-)2g$/.test(net.effectiveType || ''));
  state.light = readPref('dw.light', slow ? '1' : '0') === '1';
  renderLightToggle();
  wireControls();
  renderCard();

  try {
    // The map shows the CURRENT year. The past droughts (2018–2023) that prove the
    // method are only loaded when one is opened from the results page (?field=…).
    const wanted = new URLSearchParams(location.search).get('field');
    state.fields = (await Data.listFields()).filter((f) => f.id === wanted);
    state.fields.push(...Data.restoreKeptUploads()); // files the user chose to keep
  } catch (error) {
    console.error(error);
    showMessage(t('loadError'));
    return;
  }
  renderChips();
  if (!navigator.onLine) showMessage(t('offline'));
  if (!state.light) await startMap();

  // Analyse every field in the background so pins and buttons show their light.
  for (const field of state.fields) {
    analysisFor(field).then((a) => updateFieldLevel(field.id, a)).catch((e) => console.error(e));
  }

  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('field');
  if (fromUrl && state.fields.some((f) => f.id === fromUrl)) selectField(fromUrl);
  // A shared link to any place: ?lat=52.95&lon=10.63
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  // From the home page: a place name to search for, or "use my location"
  if (params.get('q')) { $('search-input').value = params.get('q'); $('search').requestSubmit(); }
  if (params.get('locate') === '1') onLocate();
  // A shared area: ?area=south,west,north,east
  const area = (params.get('area') || '').split(',').map(Number);
  if (area.length === 4 && area.every(Number.isFinite)) openLiveArea({ south: area[0], west: area[1], north: area[2], east: area[3] });
  if (params.has('lat') && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) openLivePlace(lat, lon);
}

/** Load and analyse a field once; later calls reuse the result. */
function analysisFor(field) {
  if (!state.analyses.has(field.id)) {
    const promise = Data.loadSeries(field).then((rows) => analyseField(field, rows));
    promise.catch(() => state.analyses.delete(field.id));
    state.analyses.set(field.id, promise);
  }
  return state.analyses.get(field.id);
}

/**
 * Which picture a field opens on. Historic drought examples (with an "event"
 * in fields.json) open at the worst moment of the season; everything else
 * (e.g. your own file) at the latest picture in the growing season.
 */
function startPeriod(field, a) {
  return (field.event && peakPeriod(a)) ?? a.defaultPeriod;
}

/** Level shown on a field's pin and button: the level of the picture it opens on. */
function latestLevel(a) {
  const p = startPeriod(a.field, a);
  return p == null ? 'unknown' : a.overall[p];
}

function updateFieldLevel(id, a) {
  const level = latestLevel(a);
  MapView.setFieldLevel(id, level);
  const chip = document.querySelector(`.chip[data-id="${id}"] .chip-symbol`);
  if (chip) {
    chip.className = `chip-symbol lvl-${level}`;
    chip.textContent = SYMBOLS[level];
  }
}

/* ---------- Choosing a field ---------- */
async function selectField(id) {
  const field = state.fields.find((f) => f.id === id);
  if (!field) return;
  hideMessage();
  state.selectedId = id;
  // Live places show soil water instead of satellite indices: switch every label at once
  setVariant(field.live ? 'live' : '');
  applyStaticTexts();
  renderChips();
  renderCard({ loading: true });
  if (!state.light) MapView.focusField(field);
  // Shareable link for test fields; an uploaded file only exists on this device.
  history.replaceState(null, '', field.uploaded ? location.pathname
    : field.area ? `?area=${[field.bounds.south, field.bounds.west, field.bounds.north, field.bounds.east].map((v) => v.toFixed(3)).join(',')}`
    : field.live ? `?lat=${field.lat.toFixed(4)}&lon=${field.lon.toFixed(4)}` : `?field=${encodeURIComponent(id)}`);

  let a;
  try {
    a = await analysisFor(field);
  } catch (error) {
    console.error(error);
    showMessage(t('loadError'));
    renderCard();
    return;
  }
  if (state.selectedId !== id) return; // the user picked another field meanwhile
  state.period = startPeriod(field, a);
  state.compareYear = a.typicalYear;
  renderSelected(a);
  playEntrance();
}

/**
 * The page's one orchestrated moment, only when a field opens (not on every
 * slider move): the card rises, the meter needles sweep from "normal" to the
 * field's value and the season bars grow left to right. CSS turns it off for
 * people who ask for reduced motion.
 */
function playEntrance() {
  const parts = [$('card'), $('timeline')];
  parts.forEach((el) => el.classList.remove('is-entering'));
  void $('card').offsetWidth; // restart the animation when the same class comes back
  parts.forEach((el) => el.classList.add('is-entering'));
  clearTimeout(playEntrance.timer);
  playEntrance.timer = setTimeout(() => parts.forEach((el) => el.classList.remove('is-entering')), 1400);
}

/** A point on the map or a search result: select the field there, if we have one. */
async function chooseLocation(lat, lon, name = null) {
  // A satellite case study right here? Open it. Anywhere else: live soil-water data.
  const found = await Data.findField(state.fields.filter((f) => !f.live), lat, lon);
  if (found?.exact) selectField(found.field.id);
  else openLivePlace(lat, lon, name);
}

/** Any place on Earth: download its soil-water history and open it like a field. */
function openLivePlace(lat, lon, name = null) {
  return openLive(t('liveLoading'), async () => {
    const [placeName] = await Promise.all([name ?? reversePlace(lat, lon, getLanguage()), Data.loadLivePlace(lat, lon)]);
    return Data.loadLivePlace(lat, lon, placeName); // cached: no second download
  });
}

/** A dragged area: up to 4 sample points, averaged. */
function openLiveArea(box) {
  const n = Data.areaPoints(box).length;
  return openLive(t('areaLoading', { n }), async () => {
    const lat = (box.south + box.north) / 2;
    const lon = (box.west + box.east) / 2;
    const [placeName] = await Promise.all([reversePlace(lat, lon, getLanguage()), Data.loadLiveArea(box)]);
    return Data.loadLiveArea(box, placeName ? t('areaAround', { name: placeName }) : null);
  });
}

async function openLive(loadingText, load) {
  showMessage(loadingText);
  try {
    const field = await load();
    MapView.clearDraft();
    // One live place or area at a time on the map and in the list
    for (const old of state.fields.filter((f) => f.live && f.id !== field.id)) {
      state.analyses.delete(old.id);
      MapView.removeField(old.id);
    }
    state.fields = [...state.fields.filter((f) => !f.live), field];
    if (!state.light) MapView.addField(field, (f) => pick(f.name));
    hideMessage();
    await selectField(field.id);
    analysisFor(field).then((a) => updateFieldLevel(field.id, a)).catch(() => {});
  } catch (error) {
    console.error(error);
    MapView.clearDraft();
    showMessage(t(['liveEmpty', 'liveBusy', 'areaTooBig'].includes(error.code) ? error.code : 'liveError', error.params || {}));
  }
}

async function onSearch(event) {
  event.preventDefault();
  const query = $('search-input').value.trim();
  if (!query) return;

  // 1) A test field whose name contains the text?
  const q = query.toLowerCase();
  const local = state.fields.find((f) =>
    [...Object.values(f.name || {}), ...Object.values(f.short || {})].some((n) => n.toLowerCase().includes(q)));
  if (local) { selectField(local.id); return; }

  // 2) Otherwise ask the place search.
  showMessage(t('searching'));
  try {
    const place = await searchPlace(query, getLanguage());
    if (!place) { showMessage(t('notFound', { query })); return; }
    MapView.flyTo(place.lat, place.lon, 11);
    hideMessage();
    chooseLocation(place.lat, place.lon, place.name.split(',').slice(0, 3).join(',').trim());
  } catch (error) {
    console.error(error);
    showMessage(t('searchError'));
  }
}

/* ---------- Drawing the screen ---------- */
function renderSelected(a) {
  $('details').hidden = false;
  renderUploadSettings(a);
  renderSpace();
  renderSlider(a);
  renderTimeline(a);
  renderCompare(a);
  renderCard();
  renderCharts(a);
  renderTable(a);
}

async function rerender() {
  const field = currentField();
  if (!field) { renderCard(); return; }
  const a = await analysisFor(field);
  renderSelected(a);
}

/** The warning card: big symbol + one word + one sentence, details below. */
async function renderCard({ loading = false } = {}) {
  const card = $('card');
  const field = currentField();
  if (!field || loading) {
    card.className = `card${loading ? ' loading' : ''}`;
    card.innerHTML = `
      <div class="card-head">
        <div class="card-visual">${plantSvg(loading ? 'off' : 'green')}</div>
        <div class="card-body">
          <h2 class="level">${esc(loading ? t('loading') : t('chooseTitle'))}</h2>
          ${loading ? '' : `<p class="advice">${esc(t('chooseText'))}</p>`}
        </div>
      </div>
      ${loading ? '' : `
      <ol class="start-steps">
        ${[1, 2, 3].map((n) => `<li><b>${esc(t(`step${n}Title`))}</b><span>${esc(t(`step${n}Text`))}</span></li>`).join('')}
      </ol>
      <p class="start-fact">${esc(t('chooseFact'))} <a href="summary.html">${esc(t('chooseFactLink'))}</a></p>`}`;
    return;
  }
  const a = await analysisFor(field);
  const p = state.period;
  // All sources together: the headline is their combined verdict once they are in
  const sources = evidenceReady(field, a);
  if (!sources) evidenceFor(field, a).then(() => { if (currentField() === field) renderCard(); }).catch(() => {});
  const signs = sources ? sources.filter((src) => src.group === 'sign') : null;
  const combined = signs && p != null ? combineLevels(signs.map((src) => sourceAt(src, p).level)) : null;
  const level = p == null ? 'unknown' : combined || a.overall[p] || 'unknown';
  // The gauge needle: the median anomaly of the signs (or of this field's own data until they are in)
  const gaugeZ = p == null ? null : median((signs || [{ a }]).map((src) => sourceAt(src, p)).filter((x) => x.z != null && ['green', 'yellow', 'red'].includes(x.level)).map((x) => x.z));
  const inSeason = p != null && a.inSeason[p];

  // One meter per index: how many standard deviations from normal.
  const meter = (key) => {
    const lv = p == null ? null : a[key].level[p];
    const z = p == null ? null : a[key].z[p];
    const symbolLevel = inSeason && lv ? lv : 'off'; // outside the season: no judgement
    const word = lv == null ? t('idx_none') : inSeason ? t(`idx_${lv}`) : t('idx_off');
    const zText = z == null ? '' : t('sdValue', { z: formatSigned(z) });
    const head = `<span class="mini lvl-${symbolLevel}" aria-hidden="true">${SYMBOLS[symbolLevel]}</span>`
      + `<b>${esc(t(`${key}Name`))}</b><span class="word">${esc(word)}</span>`
      + (zText ? `<span class="z" title="${esc(t('sdExplain'))}">${esc(zText)}</span>` : '');
    return meterHtml({
      z, level: lv, inSeason, head,
      ariaLabel: esc(t('meterAria', { name: t(`${key}Name`), z: z == null ? '–' : formatSigned(z), word })),
      formatTick: (v) => (v === 0 ? esc(t('idx_green')) : esc(t('sdValue', { z: formatSigned(v, 0) }))),
    });
  };

  const since = p == null ? null : warningSince(a, p);
  const lead = p == null ? null : leadTime(a, p);
  const crop = t(`crop_${field.crop}`);
  const meta = [
    `<b>${esc(pick(field.name))}</b>`,
    field.area
      ? esc(t('areaKind', { w: Math.round(field.sizeKm.w), h: Math.round(field.sizeKm.h) }))
      : field.live
      ? esc(t('liveKind', { km: field.gridKm }))
      : field.uploaded
      ? `<em>${esc(t('fromYourFile'))}</em>`
      : `${esc(crop.startsWith('crop_') ? t('crop_unknown') : crop)}${field.areaHa ? ' · ' + esc(formatHectares(field.areaHa)) : ''}${field.simulated ? ` · <em>${esc(t('simulated'))}</em>` : ''}`,
  ];
  const short = (d) => formatDate(d, { day: 'numeric', month: 'short', year: 'numeric' });

  card.className = `card ${level}`;
  card.innerHTML = `
    <div class="card-head">
      <div class="card-visual card-gauge">
        ${gaugeSvg(gaugeZ, level)}
        <span class="gauge-value">${gaugeZ == null ? '' : esc(t('sdValue', { z: formatSigned(gaugeZ) }))}</span>
      </div>
      <div class="card-body">
        <p class="field-name">${meta.join(' · ')}</p>
        <h2 class="level">${esc(t(`level_${level}`))}</h2>
        <p class="advice">${esc(t(`advice_${level}`))}</p>
      </div>
    </div>
    <div class="kpis">
      ${kpi(t('kpiPicture'), p != null && a.dates[p] ? esc(short(a.dates[p])) : '–')}
      ${kpi(t('kpiSince'), since != null ? esc(short(a.dates[since])) : '–', since != null ? sinceNote(a.dataPeriods.filter((q) => q >= since && q <= p).length) : t('kpiNoWarning'), since != null ? 'warn' : '')}
      ${kpi(t('kpiLead'), lead ? esc(t('leadDays', { days: lead.days })) : '–', lead ? t('kpiLeadNote') : t('kpiLeadNone'), lead ? 'highlight' : '')}
      ${confidenceKpi(confidence(a, p))}
    </div>
    ${sourcesPanel(sources, p, a)}
    ${outlookPanel(field, a, p, level)}
    ${calcPanel(sources, p, a, level)}
    <p class="meta">${field.area ? `${esc(areaSpread(field, p))}<br>` : ''}${field.live ? `${esc(t(field.model === 'merra' ? 'liveSourceNasa' : 'liveSource', { km: field.gridKm }))} ${sourceLinks(field)}<br>` : ''}${field.event ? `<b>${esc(t('eventLabel'))}:</b> ${esc(pick(field.event))} ${sourceLinks(field)}<br>` : ''}${esc(t('comparedWith', { years: formatList(a.normalYears) }))}</p>`;
}

/* ---------- All sources together ----------
   For every place: the satellite pictures (case studies only), ERA5-Land soil
   water, NASA MERRA-2 soil wetness and NASA rain of the last 90 days. Each is
   judged by the same rule against the same normal years; combineLevels() turns
   them into one verdict. */
const evidence = new Map(); // key -> sources (once loaded)
const evidenceLoading = new Map();

const evidenceKey = (field, a) => `${field.id}|${a.season}|${field.seasonStartMonth || 1}|${a.normalYears.join(',')}`;
const evidenceReady = (field, a) => evidence.get(evidenceKey(field, a)) || null;

function evidenceFor(field, a) {
  const key = evidenceKey(field, a);
  if (!evidenceLoading.has(key)) {
    const same = { season: a.season, seasonStartMonth: field.seasonStartMonth || 1, normalYears: a.normalYears, allYear: true };
    const promise = (async () => {
      const [era, power, river] = await Promise.allSettled([
        field.live ? null : Data.loadLivePlace(field.lat, field.lon),
        Data.loadPower(field.lat, field.lon),
        Data.loadRiver(field.lat, field.lon),
      ]);
      // Signs: what the plants, the soil and the rivers show. They decide the verdict.
      // Causes: rain, the water balance and heat. They explain it (and would count twice).
      const list = [];
      if (!field.live) list.push({ id: 'sat', group: 'sign', a, pair: true });
      if (field.live) list.push({ id: field.model === 'merra' ? 'merra' : 'era', group: 'sign', a, pair: true });
      else if (era.status === 'fulfilled') list.push({ id: 'era', group: 'sign', a: analyseField({ ...era.value, ...same }, era.value.rows), pair: true });
      if (power.status === 'fulfilled' && field.model !== 'merra') list.push({ id: 'merra', group: 'sign', a: analyseField({ id: 'merra', ...same, sdFloor: 0.01 }, power.value.soil) });
      if (river.status === 'fulfilled') list.push({ id: 'river', group: 'sign', a: analyseField({ id: 'river', ...same, sdFloor: 0.05 }, river.value), unit: 'flow' });
      if (power.status === 'fulfilled') {
        list.push({ id: 'rain', group: 'cause', a: analyseField({ id: 'rain', ...same, sdFloor: 5 }, power.value.rain), unit: 'mm' });
        list.push({ id: 'balance', group: 'cause', a: analyseField({ id: 'balance', ...same, sdFloor: 5 }, power.value.balance), unit: 'mm' });
        list.push({ id: 'heat', group: 'cause', a: analyseField({ id: 'heat', ...same, sdFloor: 0.5 }, power.value.heat), unit: 'heat' });
        list.power = power.value;
      }
      evidence.set(key, list);
      return list;
    })();
    promise.catch(() => evidenceLoading.delete(key));
    evidenceLoading.set(key, promise);
  }
  return evidenceLoading.get(key);
}

/** A source's judgement in period p (or the period before, when its newest data is a few days behind). */
function sourceAt(src, p) {
  for (const q of [p, p - 1]) {
    const level = q >= 0 ? src.a.overall[q] : null;
    if (level) {
      const zs = [src.a.ndvi.z[q], src.a.ndmi.z[q]].filter((z) => z != null);
      return { level, q, z: zs.length ? Math.min(...zs) : null, value: src.a.ndvi.values[q], normal: src.a.ndvi.mean[q] };
    }
  }
  return { level: null };
}

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((x, y) => x - y);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

/** The measured value in everyday units ("106 mm, normal 295 mm"). */
function valueText(src, at) {
  if (at.value == null || at.normal == null) return '';
  if (src.unit === 'mm') return t('srcMm', { mm: Math.round(at.value), normal: Math.round(at.normal) });
  if (src.unit === 'heat') return t('srcHeat', { c: formatNumber(-at.value, 1), normal: formatNumber(-at.normal, 1) });
  if (src.unit === 'flow') {
    const q = (v) => formatNumber(10 ** v - 0.01, 10 ** v < 1 ? 2 : 1);
    return t('srcFlow', { q: q(at.value), normal: q(at.normal) });
  }
  if (src.pair) {
    const z = (k) => (src.a[k].z[at.q] == null ? '–' : formatSigned(src.a[k].z[at.q]));
    return t(`srcPair_${src.id}`, { a: z('ndmi'), b: z('ndvi') });
  }
  return '';
}

/** Where z sits on a bar from −4 to +2 SD, in percent. */
const zPos = (z) => ((Math.min(2, Math.max(-4, z)) + 4) / 6) * 100;

function sourceRow(src, p) {
  const at = sourceAt(src, p);
  const judged = ['green', 'yellow', 'red'].includes(at.level);
  const symbol = judged ? at.level : 'off';
  const heat = src.unit === 'heat' ? '_heat' : '';
  const word = !at.level ? t('srcNone') : judged ? t(`idx_${at.level}${heat}`) : t('idx_off');
  const detail = [valueText(src, at), at.q != null && at.q !== p ? t('srcPrev') : ''].filter(Boolean).join(' · ');
  const bar = at.z == null ? '' : `<span class="zbar" aria-hidden="true"><i class="zbar-mark lvl-${symbol}" style="left:${zPos(at.z).toFixed(1)}%"></i></span>`;
  return `<li>
    <span class="mini lvl-${symbol}" aria-hidden="true">${SYMBOLS[symbol]}</span>
    <span class="src-name">${esc(t(`src_${src.id}`))}</span>
    <span class="src-z">${at.z == null || !judged ? '' : esc(t('sdValue', { z: formatSigned(heat ? -at.z : at.z) }))}</span>
    ${bar}
    <span class="src-detail"><b>${esc(word)}</b>${detail ? ` · ${esc(detail)}` : ''}</span>
  </li>`;
}

function sourcesPanel(sources, p) {
  if (p == null) return '';
  if (!sources) return `<div class="sources-panel"><p class="hint loading-line">${esc(t('srcLoading'))}</p></div>`;
  const group = (g) => sources.filter((src) => src.group === g);
  const judged = group('sign').map((src) => sourceAt(src, p).level).filter((l) => ['green', 'yellow', 'red'].includes(l));
  const dry = judged.filter((l) => l !== 'green').length;
  const scale = `<div class="zscale" aria-hidden="true"><span style="left:${zPos(-2)}%">−2</span><span style="left:${zPos(-1)}%">−1</span><span style="left:${zPos(0)}%">${esc(t('idx_green'))}</span></div>`;
  return `<div class="sources-panel">
    <div class="src-group">
      <h3 class="sources-title">${esc(t('groupSigns'))}</h3>
      <p class="hint">${esc(judged.length ? t('srcVerdict', { n: dry, total: judged.length }) : t('srcNoneAll'))}</p>
      <ul class="src-list">${group('sign').map((src) => sourceRow(src, p)).join('')}</ul>${scale}
    </div>
    ${group('cause').length ? `<div class="src-group">
      <h3 class="sources-title">${esc(t('groupCauses'))}</h3>
      <p class="hint">${esc(t('groupCausesHint'))}</p>
      <ul class="src-list">${group('cause').map((src) => sourceRow(src, p)).join('')}</ul>${scale}
    </div>` : ''}
    <p class="hint src-links">${esc(t('sourcesLabel'))}:
      <a href="https://power.larc.nasa.gov/" target="_blank" rel="noopener">NASA POWER (MERRA-2)</a> ·
      <a href="https://open-meteo.com/en/docs/historical-weather-api" target="_blank" rel="noopener">ERA5-Land</a> ·
      <a href="https://open-meteo.com/en/docs/flood-api" target="_blank" rel="noopener">GloFAS</a> ·
      <a href="https://www.fao.org/4/x0490e/x0490e00.htm" target="_blank" rel="noopener">FAO-56 (Hargreaves)</a></p>
  </div>`;
}

/* ---------- What to expect: the next 16 days ---------- */
const outlooks = new Map();

function outlookPanel(field, a, p, level) {
  // Only for "now": the newest period of a season that is still running
  const newest = a.dataPeriods.at(-1);
  const date = p == null ? null : a.labels[p];
  if (p == null || p !== newest || !date || Date.now() - date.getTime() > 40 * 86400000) return '';
  const key = Data.liveId(field.lat, field.lon);
  if (!outlooks.has(key)) {
    outlooks.set(key, null);
    Data.loadOutlook(field.lat, field.lon)
      .then((o) => { outlooks.set(key, o); if (currentField() === field) renderCard(); })
      .catch(() => outlooks.delete(key));
  }
  const o = outlooks.get(key);
  const power = evidenceReady(field, a)?.power;
  if (!o || !power) return `<div class="outlook"><h3 class="sources-title">${esc(t('outlookTitle'))}</h3><p class="hint loading-line">${esc(t('outlookLoading'))}</p></div>`;
  const normal = power.normalRain(o.from, o.days, a.normalYears);
  let verdict = 'outlookSame';
  if (normal == null || normal < 5) verdict = 'outlookDry';
  else if (o.rain < 0.5 * normal) verdict = level === 'green' ? 'outlookWatch' : 'outlookWorse';
  else if (o.rain > 1.5 * normal) verdict = level === 'green' ? 'outlookSame' : 'outlookEase';
  const share = normal ? Math.round((100 * o.rain) / normal) : null;
  return `<div class="outlook outlook-${verdict}">
    <h3 class="sources-title">${esc(t('outlookTitle'))}</h3>
    <div class="outlook-figures">
      <p><b>${esc(formatNumber(o.rain, 0))} mm</b><span>${esc(t('outlookRain', { days: o.days }))}</span></p>
      <p><b>${normal == null ? '–' : `${esc(formatNumber(normal, 0))} mm`}</b><span>${esc(t('outlookNormal'))}</span></p>
      <p><b>${esc(formatNumber(o.et0, 0))} mm</b><span>${esc(t('outlookEt0'))}</span></p>
    </div>
    <p class="outlook-verdict">${esc(t(verdict, { share: share ?? '–' }))}</p>
  </div>`;
}

/* ---------- How this was calculated (with the real numbers) ---------- */
function calcPanel(sources, p, a, level) {
  if (p == null) return '';
  const from = a.labels[p];
  const to = new Date(from.getTime() + 9 * 86400000);
  const day = (d) => formatDate(d, { day: 'numeric', month: 'short', year: 'numeric' });
  const signs = (sources || [{ id: a.field?.live ? 'era' : 'sat', group: 'sign', a, pair: true }]).filter((src) => src.group === 'sign');
  const lines = signs.map((src) => {
    const at = sourceAt(src, p);
    if (at.z == null) return `<li><b>${esc(t(`src_${src.id}`))}</b>: ${esc(t('srcNone'))}</li>`;
    const k = src.pair && src.a.ndmi.z[at.q] != null && src.a.ndmi.z[at.q] < (src.a.ndvi.z[at.q] ?? Infinity) ? 'ndmi' : 'ndvi';
    const fmt = (v) => formatNumber(v, 3);
    // River flow is compared as a logarithm (floods are 100 × a dry month); the text says so
    const flow = src.unit === 'flow' ? ` ${t('calcLog', { q: formatNumber(10 ** src.a[k].values[at.q] - 0.01, 2) })}` : '';
    return `<li><b>${esc(t(`src_${src.id}`))}</b>: ${esc(t('calcLine', {
      value: fmt(src.a[k].values[at.q]), mean: fmt(src.a[k].mean[at.q]), sd: fmt(src.a[k].sd[at.q]),
      z: formatSigned(src.a[k].z[at.q]), n: src.a[k].n[at.q], word: t(`idx_${at.level}`),
    }))}${esc(flow)}</li>`;
  }).join('');
  const judged = signs.map((src) => sourceAt(src, p).level).filter((l) => ['green', 'yellow', 'red'].includes(l));
  const count = (l) => judged.filter((x) => x === l).length;
  return `<details class="calc">
    <summary>${esc(t('calcTitle'))}</summary>
    <ol class="calc-steps">
      <li>${esc(t('calcStep1', { from: day(from), to: day(to), years: formatList(a.normalYears) }))}</li>
      <li>${esc(t('calcStep2'))}<ul class="calc-lines">${lines}</ul></li>
      <li>${esc(t('calcStep3'))}</li>
      <li>${esc(t('calcStep4', { red: count('red'), yellow: count('yellow'), green: count('green'), total: judged.length, level: t(`level_${level}`) }))}</li>
      <li>${esc(t('calcStep5'))}</li>
    </ol>
  </details>`;
}

/** Links to the reports that describe what really happened (from fields.json). */
/** "Average of 4 sample points: 2 red, 1 yellow, 1 green" (same season and normal years as the area). */
function areaSpread(field, p) {
  if (p == null) return '';
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const point of field.points) {
    const a = analyseField({ ...point, season: field.season, seasonStartMonth: field.seasonStartMonth, normalYears: field.normalYears }, point.rows);
    const level = a.overall[p];
    if (level in counts) counts[level] += 1;
  }
  const parts = ['red', 'yellow', 'green'].filter((l) => counts[l]).map((l) => t(`areaCount_${l}`, { n: counts[l] }));
  return t('areaSpread', { n: field.points.length, parts: parts.join(', ') || '–' });
}

function sourceLinks(field) {
  if (!field.sources?.length) return '';
  return `<span class="sources">${esc(t('sourcesLabel'))}: ${field.sources
    .map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">[${i + 1}]</a>`)
    .join(' ')}</span>`;
}

const sinceNote = (n) => (n === 1 ? t('kpiSinceOne') : t('kpiSinceNote', { n }));

/** One small tile with a label, a big value and an optional note. */
function kpi(label, valueHtml, note = '', extraClass = '') {
  return `<div class="kpi ${extraClass}">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value">${valueHtml}</span>
    ${note ? `<span class="kpi-note">${esc(note)}</span>` : ''}
  </div>`;
}

/** Confidence tile: three little bars like a phone's signal, and the reasons. */
function confidenceKpi(c) {
  if (!c) return kpi(t('kpiConfidence'), '–');
  const reasons = [
    t('confYears', { n: c.normalYears }),
    c.gapDays == null ? t('confFirst') : t('confGap', { days: c.gapDays }),
    c.nearLimit ? t('confNear') : null,
  ].filter(Boolean);
  const bars = { high: 3, medium: 2, low: 1 }[c.level];
  const icon = [1, 2, 3].map((i) => `<i class="${i <= bars ? 'on' : ''}"></i>`).join('');
  return `<div class="kpi conf-${c.level}" title="${esc(t('confExplain'))}">
    <span class="kpi-label">${esc(t('kpiConfidence'))}</span>
    <span class="kpi-value"><span class="conf-icon" aria-hidden="true">${icon}</span>${esc(t(`conf_${c.level}`))}</span>
    <span class="kpi-note">${esc(reasons.join(' · '))}</span>
  </div>`;
}

/** "Seen from space": real Sentinel-2 pictures, normal year next to the drought year. */
function renderSpace() {
  const field = currentField();
  const images = field?.images;
  $('space').hidden = !images?.normal || !images?.drought || state.light; // light mode: no picture downloads
  if ($('space').hidden) return;
  const kind = state.spaceKind;
  document.querySelectorAll('.space-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  $('ndvi-scale').hidden = kind !== 'ndvi';
  // One frame, two pictures of the same square: drag the handle to wipe from the normal year to the drought year
  const info = (role) => {
    const img = images[role];
    const date = formatDate(new Date(`${img.date}T00:00:00Z`));
    return { img, date, alt: t('spaceAlt', { kind: kind === 'rgb' ? t('spaceTrue') : t('spaceNdvi'), name: pick(field.short), date }) };
  };
  const normal = info('normal');
  const drought = info('drought');
  const pos = state.spacePos ?? 50;
  const caption = (role, x) => `<p><b>${esc(t(role === 'normal' ? 'spaceNormal' : 'spaceDrought'))}</b>${esc(x.date)} · ${esc(t('spaceNdviValue', { value: formatNumber(x.img.ndviValue, 2) }))}</p>`;
  $('space-grid').innerHTML = `
    <div class="cmp" style="--pos:${pos}%">
      <img src="data/${esc(normal.img[kind])}" alt="${esc(normal.alt)}" width="400" height="400">
      <img class="cmp-top" src="data/${esc(drought.img[kind])}" alt="${esc(drought.alt)}" width="400" height="400">
      <span class="cmp-tag cmp-left" aria-hidden="true">${esc(t('spaceNormal'))}</span>
      <span class="cmp-tag cmp-right" aria-hidden="true">${esc(t('spaceDrought'))}</span>
      <span class="cmp-handle" aria-hidden="true"></span>
      <input class="cmp-range" type="range" min="0" max="100" value="${pos}" aria-label="${esc(t('spaceSlider'))}">
    </div>
    <div class="cmp-captions">${caption('normal', normal)}${caption('drought', drought)}</div>`;
}

/** The season at a glance: one bar per 10-day period (click a bar to jump there). */
/**
 * The season at a glance: one row per source, one cell per 10-day period.
 * The top row is the combined verdict of the signs. Until the other sources
 * are in, it shows this field's own data as before.
 */
function renderTimeline(a) {
  const narrow = window.matchMedia('(max-width: 560px)').matches;
  const monthLabel = (d) => formatDate(d, { month: narrow ? 'narrow' : 'short' });
  const field = currentField();
  const sources = field ? evidenceReady(field, a) : null;
  if (!sources) {
    $('timeline').innerHTML = timelineHtml(a, state.period, monthLabel);
    if (field) evidenceFor(field, a).then(() => { if (currentField() === field) renderTimeline(a); }).catch(() => {});
    return;
  }
  const signs = sources.filter((src) => src.group === 'sign');
  const combinedRow = a.labels.map((_, q) => combineLevels(signs.map((src) => src.a.overall[q]))
    ?? (signs.some((src) => src.a.overall[q] === 'off') ? 'off' : null));
  const rows = [
    { label: esc(t('gridCombined')), levels: combinedRow },
    ...sources.map((src) => ({ label: `${esc(t(`srcShort_${src.id}`))}${src.group === 'cause' ? ' <small>*</small>' : ''}`, levels: src.a.overall })),
  ];
  $('timeline').innerHTML = evidenceGridHtml(rows, state.period, a.labels, monthLabel);
}

/** The same numbers as the charts, as a table (for screen readers and for checking). */
function renderTable(a) {
  const fmt = (v) => (v == null ? '–' : formatNumber(v, 2));
  const fmtNormal = (s, p) => (s.mean[p] == null ? '–' : `${formatNumber(s.mean[p], 2)} ± ${formatNumber(s.sd[p], 2)}`);
  const fmtZ = (z) => (z == null ? '–' : formatSigned(z));
  const rows = a.dataPeriods.filter((p) => p <= state.period).map((p) => {
    const level = a.overall[p];
    return `<tr${p === state.period ? ' class="current"' : ''}>
      <th scope="row">${esc(formatDate(a.dates[p], { day: 'numeric', month: 'short' }))}</th>
      <td>${fmt(a.ndmi.values[p])}</td><td>${fmtNormal(a.ndmi, p)}</td><td>${fmtZ(a.ndmi.z[p])}</td>
      <td>${fmt(a.ndvi.values[p])}</td><td>${fmtNormal(a.ndvi, p)}</td><td>${fmtZ(a.ndvi.z[p])}</td>
      <td><span class="mini lvl-${level}" aria-hidden="true">${SYMBOLS[level]}</span> ${esc(t(`level_${level}`))}</td>
    </tr>`;
  }).join('');
  $('table-wrap').innerHTML = `<table>
    <thead>
      <tr><th rowspan="2" scope="col">${esc(t('tableDate'))}</th>
        <th colspan="3" scope="colgroup">${esc(t('ndmiName'))}</th>
        <th colspan="3" scope="colgroup">${esc(t('ndviName'))}</th>
        <th rowspan="2" scope="col">${esc(t('tableLevel'))}</th></tr>
      <tr><th scope="col">${esc(t('tableValue'))}</th><th scope="col">${esc(t('tableNormal'))}</th><th scope="col">${esc(t('tableZ'))}</th>
        <th scope="col">${esc(t('tableValue'))}</th><th scope="col">${esc(t('tableNormal'))}</th><th scope="col">${esc(t('tableZ'))}</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Slider over the periods that have a satellite picture. */
function renderSlider(a) {
  const slider = $('period-slider');
  slider.min = 0;
  slider.max = Math.max(0, a.dataPeriods.length - 1);
  slider.value = Math.max(0, a.dataPeriods.indexOf(state.period));
  slider.disabled = a.dataPeriods.length < 2;
  const date = state.period == null ? '' : formatDate(a.dates[state.period]);
  $('period-label').textContent = t('situationOn', { date });
  slider.setAttribute('aria-valuetext', date);
}

function renderCompare(a) {
  $('compare-toggle').checked = state.compare;
  const select = $('compare-year');
  select.hidden = !state.compare;
  $('compare-year-label').hidden = !state.compare;
  select.innerHTML = a.normalYears
    .map((y) => `<option value="${y}"${y === state.compareYear ? ' selected' : ''}>${esc(y === a.typicalYear ? t('typicalYear', { year: y }) : y)}</option>`)
    .join('');
}

/**
 * Draw both charts. Normal mode uses Chart.js (with hover tooltips), light
 * mode the small SVG chart in charts-lite.js, which needs no download.
 */
async function renderCharts(a) {
  const lite = state.light;
  if (!lite) {
    try {
      await loadChartJs();
    } catch (error) {
      console.error(error);
      showMessage(t('chartError'));
    }
  }
  const useLite = lite || !window.Chart; // fall back to the SVG chart if Chart.js failed
  const p = state.period ?? -1;
  const labels = a.labels.map((d) => formatShortDate(d));
  for (const key of ['ndvi', 'ndmi']) {
    $(`chart-${key}`).hidden = useLite;
    $(`lite-${key}`).hidden = !useLite;
    const s = a[key];
    // "Replay": only show pictures up to the chosen date, like on that day.
    const cut = (arr) => arr.map((v, i) => (i <= p ? v : null));
    const levels = s.level.map((lv, i) => (a.inSeason[i] ? lv : 'off'));
    const chart = useLite
      ? { update: (d) => drawLiteChart($(`lite-${key}`), { ...d, dates: a.labels, monthLabel: (date) => esc(formatDate(date, { month: 'short' })) }) }
      : (charts[key] ||= new IndexChart($(`chart-${key}`)));
    chart.update({
      labels,
      values: cut(s.values),
      valuesAll: s.values,
      levels: cut(levels),
      mean: s.mean,
      sd: s.sd,
      compare: state.compare && state.compareYear != null
        ? { label: t('legendCompare', { year: state.compareYear }), values: a.normals[state.compareYear][key] }
        : null,
      selected: state.period,
      inSeason: a.inSeason,
      texts: { season: t('legendSeason', { year: a.season }), mean: t('legendMean'), band: t('legendBand') },
      locale: locale(),
      format: (v, digits = 2) => formatNumber(v, digits),
    });
    const level = state.period == null ? 'unknown' : (levels[state.period] || 'unknown');
    $(useLite ? `lite-${key}` : `chart-${key}`).setAttribute('aria-label', t('chartAria', { name: t(`${key}Name`), year: a.season, level: t(`level_${level}`) }));
  }
  renderLegend(a);
}

function renderLegend(a) {
  const items = [
    `<li><span class="key key-season"></span>${esc(t('legendSeason', { year: a.season }))}</li>`,
    `<li><span class="key key-band"></span>${esc(t('legendBand'))}</li>`,
    `<li><span class="key key-mean"></span>${esc(t('legendMean'))}</li>`,
  ];
  if (state.compare && state.compareYear != null) {
    items.push(`<li><span class="key key-compare"></span>${esc(t('legendCompare', { year: state.compareYear }))}</li>`);
  }
  items.push(`<li class="shapes">${esc(t('legendShapes'))}</li>`);
  $('legend').innerHTML = items.join('');
}

/** Quick buttons for the test fields (always visible, the only list in light mode). */
function renderChips() {
  $('chips').innerHTML = state.fields.map((f) => `
    <button type="button" class="chip${f.id === state.selectedId ? ' selected' : ''}" data-id="${esc(f.id)}"
      aria-pressed="${f.id === state.selectedId}">
      <span class="chip-symbol lvl-none" aria-hidden="true"></span>${esc(pick(f.short))}
    </button>`).join('');
  // Keep the selected button visible in the sideways-scrolling row on phones.
  document.querySelector('.chip.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // Re-apply known levels to the new buttons.
  for (const f of state.fields) {
    state.analyses.get(f.id)?.then((a) => updateFieldLevel(f.id, a)).catch(() => {});
  }
}

function renderLightToggle() {
  const button = $('light-toggle');
  button.setAttribute('aria-pressed', String(state.light));
  $('map').hidden = state.light;
  document.body.classList.toggle('no-map', state.light);
  if (!state.light) loadFont();
}

/** The Archivo font (its wide cut sets the headings, like place names on a map) is a download: never in light mode. */
function loadFont() {
  if (document.getElementById('font-css')) return;
  const link = document.createElement('link');
  link.id = 'font-css';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..800&display=swap';
  document.head.appendChild(link);
}

/* ---------- Map and light mode ---------- */
async function startMap() {
  $('map').hidden = false;
  try {
    await MapView.initMap($('map'), {
      onFieldClick: (id) => selectField(id),
      onMapClick: (lat, lon) => chooseLocation(lat, lon),
      onAreaSelect: (box) => openLiveArea(box),
    }, layerLabels());
  } catch (error) {
    console.error(error);
    showMessage(t('mapError'));
    setLightMode(true, { save: false });
    return;
  }
  MapView.showFields(state.fields, (f) => pick(f.name));
  for (const f of state.fields) {
    state.analyses.get(f.id)?.then((a) => updateFieldLevel(f.id, a)).catch(() => {});
  }
  const field = currentField();
  if (field) MapView.focusField(field);
}

const layerLabels = () => ({
  satellite: t('layerSatellite'), map: t('layerMap'),
  overlays: { greenness: t('layerGreenness'), soil: t('layerSoil') },
  area: { draw: t('areaDraw'), active: t('areaActive'), view: t('areaView'), hint: t('areaHint') },
});

async function setLightMode(on, { save = true } = {}) {
  state.light = on;
  if (save) writePref('dw.light', on ? '1' : '0');
  renderLightToggle();
  if (on) MapView.destroyMap();
  else if (state.fields.length) await startMap();
  if (currentField()) rerender(); // switch between the light and the full chart
}

/* ---------- Your own file (upload or drag-and-drop) ---------- */

/** Read a file the user picked or dropped, add it as a field and show it. */
async function onUpload(file) {
  if (!file) return;
  showMessage(t('uploadReading', { name: file.name }));
  let field;
  try {
    ({ field } = await Data.readUploadedFile(file));
  } catch (error) {
    console.error(error);
    const code = error instanceof Data.DataError ? error.code : 'unreadable';
    showMessage(t(`upload_${code}`, { name: file.name, ...(error.params || {}) }));
    return;
  }
  hideMessage();
  state.fields.push(field);
  renderChips();
  if (!state.light) MapView.addField(field, (f) => pick(f.name));
  await selectField(field.id);
  const a = await analysisFor(field);
  updateFieldLevel(field.id, a);
  if (a.normalYears.length < MIN_NORMAL_YEARS) showMessage(t('uploadFewNormals', { n: a.normalYears.length }));
  else if (!Number.isFinite(field.lat)) showMessage(t('uploadNoPlace'));
}

/** Season start, season and normal-year choices for an uploaded file. */
async function renderUploadSettings(a) {
  const field = currentField();
  const panel = $('upload-settings');
  // Uploaded files and live places can pick their season and normal years (any year back to 20 years ago)
  panel.hidden = !(field?.uploaded || field?.live);
  if (panel.hidden) return;
  panel.querySelector('.keep-check').hidden = !field.uploaded; // nothing to keep or remove for a live place
  $('up-remove').hidden = !field.uploaded;
  $('up-keep').checked = !!field.uploaded && Data.isUploadKept(field.id);
  const start = field.seasonStartMonth || 1;
  $('up-start').innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((m) => `<option value="${m}"${m === start ? ' selected' : ''}>${esc(formatDate(new Date(Date.UTC(2000, m - 1, 1)), { month: 'long' }))}</option>`)
    .join('');
  const seasons = availableSeasons(await Data.loadSeries(field), start);
  const label = (s) => (start === 1 ? String(s) : `${s}/${String(s + 1).slice(2)}`); // e.g. 2022/23
  $('up-season').innerHTML = seasons
    .map((s) => `<option value="${s.season}"${s.season === a.season ? ' selected' : ''}>${esc(label(s.season))}</option>`)
    .join('');
  // Mark normal years that look dry compared with the other normal years.
  const looksDry = new Set(checkNormalYears(a).filter((c) => c.suspicious).map((c) => c.year));
  $('up-normals').innerHTML = seasons.filter((s) => s.season !== a.season).map((s) => {
    const checked = s.usable && a.normalYears.includes(s.season);
    const note = !s.usable ? t('tooFewPictures') : looksDry.has(s.season) ? t('looksDry') : '';
    return `<label class="${s.usable ? '' : 'disabled'}${looksDry.has(s.season) ? ' dry' : ''}">
      <input type="checkbox" value="${s.season}"${checked ? ' checked' : ''}${s.usable ? '' : ' disabled'}>
      ${looksDry.has(s.season) ? '<span class="mini lvl-yellow" aria-hidden="true">!</span>' : ''}
      ${esc(label(s.season))}${note ? ` <small>(${esc(note)})</small>` : ''}
    </label>`;
  }).join('');
}

/** Apply new settings to the uploaded file and analyse it again. */
function changeUploadSettings(change) {
  const field = currentField();
  if (!field?.uploaded && !field?.live) return;
  Object.assign(field, change);
  if (field.uploaded && Data.isUploadKept(field.id)) Data.keepUpload(field); // save the new settings too
  state.analyses.delete(field.id);
  selectField(field.id).then(() => analysisFor(field).then((a) => updateFieldLevel(field.id, a)));
}

function removeUpload() {
  const field = currentField();
  if (!field?.uploaded) return;
  state.fields = state.fields.filter((f) => f.id !== field.id);
  state.analyses.delete(field.id);
  Data.removeUploadedField(field.id);
  MapView.removeField(field.id);
  state.selectedId = null;
  state.period = null;
  $('details').hidden = true;
  $('upload-settings').hidden = true;
  history.replaceState(null, '', location.pathname);
  renderChips();
  renderCard();
}

/** Drag a file anywhere over the page: show a big drop area. */
function wireDragAndDrop() {
  const overlay = $('drop-overlay');
  const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0; // dragenter/dragleave fire for every child element
  window.addEventListener('dragenter', (e) => { if (hasFile(e)) { depth++; overlay.hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFile(e) && --depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFile(e)) e.preventDefault(); }); // allow dropping
  window.addEventListener('drop', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault(); // otherwise the browser would open the file
    depth = 0;
    overlay.hidden = true;
    onUpload(e.dataTransfer.files[0]);
  });
}

/* ---------- "Use my location" ---------- */
function onLocate() {
  if (!navigator.geolocation) { showMessage(t('locateError')); return; }
  showMessage(t('locating'));
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      hideMessage();
      const { latitude, longitude } = pos.coords;
      MapView.flyTo(latitude, longitude, 12);
      chooseLocation(latitude, longitude);
    },
    () => showMessage(t('locateError')),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
  );
}

/* ---------- Messages ---------- */
function showMessage(text, action) {
  const el = $('message');
  el.replaceChildren(document.createTextNode(text));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.textContent = action.label;
    button.addEventListener('click', () => { hideMessage(); action.run(); });
    el.append(' ', button);
  }
  el.hidden = false;
}
function hideMessage() {
  $('message').hidden = true;
}

/* ---------- Controls ---------- */
function buildLanguageMenu() {
  $('lang').innerHTML = LANGUAGES
    .map((l) => `<option value="${l}"${l === getLanguage() ? ' selected' : ''}>${esc(STRINGS[l].languageName)}</option>`)
    .join('');
}

function wireControls() {
  $('search').addEventListener('submit', onSearch);
  $('light-toggle').addEventListener('click', () => setLightMode(!state.light));
  $('lang').addEventListener('change', (e) => {
    setLanguage(e.target.value);
    writePref('dw.lang', getLanguage());
    applyStaticTexts();
    MapView.setLayerLabels(layerLabels());
    renderChips();
    rerender();
  });
  $('locate').addEventListener('click', onLocate);
  $('upload-input').addEventListener('change', (e) => {
    onUpload(e.target.files[0]);
    e.target.value = ''; // so the same file can be picked again
  });
  wireDragAndDrop();
  $('up-start').addEventListener('change', (e) => changeUploadSettings({ seasonStartMonth: Number(e.target.value), season: undefined, normalYears: undefined }));
  $('up-season').addEventListener('change', (e) => changeUploadSettings({ season: Number(e.target.value), normalYears: undefined }));
  $('up-normals').addEventListener('change', () => changeUploadSettings({
    normalYears: [...$('up-normals').querySelectorAll('input:checked')].map((i) => Number(i.value)),
  }));
  $('up-remove').addEventListener('click', removeUpload);
  // Compare slider: move the wipe line (no re-render, so dragging stays smooth)
  $('space-grid').addEventListener('input', (e) => {
    if (!e.target.classList.contains('cmp-range')) return;
    state.spacePos = Number(e.target.value);
    e.target.closest('.cmp').style.setProperty('--pos', `${state.spacePos}%`);
  });
  document.querySelector('.space-tabs').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    state.spaceKind = button.dataset.kind;
    renderSpace();
  });
  $('up-keep').addEventListener('change', (e) => {
    const field = currentField();
    if (!field?.uploaded) return;
    if (!e.target.checked) Data.forgetUpload(field.id);
    else if (!Data.keepUpload(field)) { e.target.checked = false; showMessage(t('keepFailed')); }
  });
  // Click a bar of the season timeline to jump to that date.
  $('timeline').addEventListener('click', async (e) => {
    const bar = e.target.closest('.bar, .cell');
    const field = currentField();
    if (!bar || !field) return;
    const a = await analysisFor(field);
    const wanted = Number(bar.dataset.p);
    // Bars without a picture jump to the nearest period that has one.
    state.period = a.dataPeriods.reduce((best, q) => (Math.abs(q - wanted) < Math.abs(best - wanted) ? q : best));
    renderSelected(a);
  });
  window.addEventListener('offline', () => showMessage(t('offline')));
  window.addEventListener('online', hideMessage);
  // Redraw the timeline month labels when the screen gets narrower or wider.
  window.matchMedia('(max-width: 560px)').addEventListener('change', rerender);
  // The light chart is drawn for the exact width, so redraw it after resizing.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.light && currentField()) rerender(); }, 200);
  });
  $('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) selectField(chip.dataset.id);
  });
  $('period-slider').addEventListener('input', async (e) => {
    const field = currentField();
    if (!field) return;
    const a = await analysisFor(field);
    state.period = a.dataPeriods[Number(e.target.value)];
    renderSelected(a);
  });
  $('compare-toggle').addEventListener('change', (e) => { state.compare = e.target.checked; rerender(); });
  $('compare-year').addEventListener('change', (e) => { state.compareYear = Number(e.target.value); rerender(); });
}

init();

// Offline support: sw.js keeps a copy of the app and data on the device.
// Service workers only run on https:// or localhost (GitHub Pages is https).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Offline mode not available:', error));
}
