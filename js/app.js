/**
 * app.js — connects everything: user input -> data -> analysis -> screen.
 *
 *   data.js      loads fields and measurements
 *   analysis.js  computes normal range, anomaly and traffic light
 *   map.js       world map        charts.js  line charts
 *   i18n.js / lang.js  all texts, dates and numbers
 */
import * as Data from './data.js';
import { analyseField, warningSince, leadTime, confidence, SYMBOLS } from './analysis.js';
import { plantSvg, meterHtml, timelineHtml } from './visuals.js';
import {
  t, pick, setLanguage, getLanguage, initialLanguage, applyStaticTexts, LANGUAGES, locale,
  formatDate, formatShortDate, formatNumber, formatSigned, formatKm, formatHectares, formatList,
} from './i18n.js';
import { STRINGS } from './lang.js';
import * as MapView from './map.js';
import { IndexChart, loadChartJs } from './charts.js';
import { drawLiteChart } from './charts-lite.js';
import { searchPlace } from './geocode.js';

/* ---------- App state (everything the screen shows comes from here) ---------- */
const state = {
  fields: [],
  analyses: new Map(), // field id -> Promise of analysis result
  selectedId: null,
  period: null,        // the 10-day period chosen with the slider
  compare: false,
  compareYear: null,
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
    state.fields = await Data.listFields();
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

  const fromUrl = new URLSearchParams(location.search).get('field');
  if (fromUrl && state.fields.some((f) => f.id === fromUrl)) selectField(fromUrl);
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

/** Level shown on a field's pin and button: its latest picture in the growing season. */
function latestLevel(a) {
  return a.defaultPeriod == null ? 'unknown' : a.overall[a.defaultPeriod];
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
  renderChips();
  renderCard({ loading: true });
  if (!state.light) MapView.focusField(field);
  history.replaceState(null, '', `?field=${encodeURIComponent(id)}`);

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
  state.period = a.defaultPeriod;
  state.compareYear = a.typicalYear;
  renderSelected(a);
}

/** A point on the map or a search result: select the field there, if we have one. */
async function chooseLocation(lat, lon) {
  const found = await Data.findField(state.fields, lat, lon);
  if (!found) return;
  if (found.exact) {
    selectField(found.field.id);
  } else {
    showMessage(
      t('noDataHere', { name: pick(found.field.short), distance: formatKm(found.km) }),
      { label: t('showIt'), run: () => selectField(found.field.id) },
    );
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
    chooseLocation(place.lat, place.lon);
  } catch (error) {
    console.error(error);
    showMessage(t('searchError'));
  }
}

/* ---------- Drawing the screen ---------- */
function renderSelected(a) {
  $('details').hidden = false;
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
      <div class="card-visual">${plantSvg(loading ? 'off' : 'green')}</div>
      <div class="card-body">
        <h2 class="level">${esc(loading ? t('loading') : t('chooseTitle'))}</h2>
        ${loading ? '' : `<p class="advice">${esc(t('chooseText'))}</p>`}
      </div>`;
    return;
  }
  const a = await analysisFor(field);
  const p = state.period;
  const level = p == null ? 'unknown' : a.overall[p] || 'unknown';
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
    `${esc(crop.startsWith('crop_') ? t('crop_unknown') : crop)}${field.areaHa ? ' · ' + esc(formatHectares(field.areaHa)) : ''}${field.simulated ? ` · <em>${esc(t('simulated'))}</em>` : ''}`,
  ];
  const facts = [
    p != null && a.dates[p] ? t('imageDate', { date: formatDate(a.dates[p]) }) : null,
    since != null && since !== p ? t('warningSince', { date: formatDate(a.dates[since]) }) : null,
    t('comparedWith', { years: formatList(a.normalYears) }),
  ].filter(Boolean);

  card.className = `card ${level}`;
  card.innerHTML = `
    <p class="field-name">${meta.join(' · ')}</p>
    <div class="card-visual">
      ${plantSvg(level)}
      <span class="badge" aria-hidden="true">${SYMBOLS[level]}</span>
    </div>
    <div class="card-body">
      <h2 class="level">${esc(t(`level_${level}`))}</h2>
      <p class="advice">${esc(t(`advice_${level}`))}</p>
    </div>
    <div class="meters">${meter('ndmi')}${meter('ndvi')}</div>
    ${lead ? `<p class="lead"><span class="lead-days">${esc(t('leadDays', { days: lead.days }))}</span>${esc(t('leadTime', { days: lead.days }))}</p>` : ''}
    ${confidenceHtml(confidence(a, p))}
    <p class="meta">${facts.map(esc).join(' · ')}</p>`;
}

/** Small "Confidence: high" label with the reasons behind it. */
function confidenceHtml(c) {
  if (!c) return '';
  const reasons = [
    t('confYears', { n: c.normalYears }),
    c.gapDays == null ? t('confFirst') : t('confGap', { days: c.gapDays }),
    c.nearLimit ? t('confNear') : null,
  ].filter(Boolean);
  const bars = { high: 3, medium: 2, low: 1 }[c.level];
  const icon = [1, 2, 3].map((i) => `<i class="${i <= bars ? 'on' : ''}"></i>`).join('');
  return `<p class="confidence conf-${c.level}" title="${esc(t('confExplain'))}">
    <span class="conf-icon" aria-hidden="true">${icon}</span>
    <b>${esc(t('confidence', { level: t(`conf_${c.level}`) }))}</b>
    <span>${esc(reasons.join(' · '))}</span>
  </p>`;
}

/** The season at a glance: one bar per 10-day period (click a bar to jump there). */
function renderTimeline(a) {
  const narrow = window.matchMedia('(max-width: 560px)').matches;
  $('timeline').innerHTML = timelineHtml(a, state.period, (d) => formatDate(d, { month: narrow ? 'narrow' : 'short' }));
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
}

/* ---------- Map and light mode ---------- */
async function startMap() {
  $('map').hidden = false;
  try {
    await MapView.initMap($('map'), {
      onFieldClick: (id) => selectField(id),
      onMapClick: (lat, lon) => chooseLocation(lat, lon),
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

const layerLabels = () => ({ satellite: t('layerSatellite'), map: t('layerMap') });

async function setLightMode(on, { save = true } = {}) {
  state.light = on;
  if (save) writePref('dw.light', on ? '1' : '0');
  renderLightToggle();
  if (on) MapView.destroyMap();
  else if (state.fields.length) await startMap();
  if (currentField()) rerender(); // switch between the light and the full chart
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
  // Click a bar of the season timeline to jump to that date.
  $('timeline').addEventListener('click', async (e) => {
    const bar = e.target.closest('.bar');
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
