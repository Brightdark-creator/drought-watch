/**
 * home.js — the home page: texts in the chosen language, the language menu
 * and the list of satellite case studies (from data/fields.json, with the
 * warning level each one reached, worked out by the same analysis as the map).
 */
import * as Data from './data.js';
import { analyseField, SYMBOLS } from './analysis.js';
import { t, pick, setLanguage, applyStaticTexts, LANGUAGES } from './i18n.js';
import { STRINGS } from './lang.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let fields = [];

function readLang() {
  try { return localStorage.getItem('dw.lang') || 'en'; } catch { return 'en'; } // English unless chosen before
}

function render() {
  applyStaticTexts();
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  document.title = t('appTitle');
  renderCases();
}

/** One row per case study: level symbol, place, year, what happened. Links open it on the map. */
async function renderCases() {
  const list = $('home-cases');
  list.innerHTML = fields.map((f) => `
    <li><a href="check.html?field=${encodeURIComponent(f.id)}">
      <span class="mini lvl-off" data-level="${esc(f.id)}" aria-hidden="true">${SYMBOLS.off}</span>
      <span class="home-case-name"><b>${esc(pick(f.short))}</b></span>
      <span class="home-case-event">${esc(pick(f.event) || '')}</span>
    </a></li>`).join('');
  // Fill in the level each field reached at its worst moment (same rule as the map)
  for (const f of fields) {
    Data.loadSeries(f).then((rows) => {
      const a = analyseField(f, rows);
      // The worst level the season reached (same order as the traffic light)
      const level = ['red', 'yellow', 'green'].find((l) => a.overall.includes(l)) || 'off';
      const el = list.querySelector(`[data-level="${CSS.escape(f.id)}"]`);
      if (el) { el.className = `mini lvl-${level}`; el.textContent = SYMBOLS[level]; }
    }).catch(() => {});
  }
}

async function init() {
  const lang = readLang();
  setLanguage(lang);
  document.documentElement.lang = lang;
  $('lang').innerHTML = LANGUAGES.map((l) => `<option value="${l}"${l === lang ? ' selected' : ''}>${esc(STRINGS[l].languageName)}</option>`).join('');
  $('lang').addEventListener('change', (e) => {
    setLanguage(e.target.value);
    document.documentElement.lang = e.target.value;
    try { localStorage.setItem('dw.lang', e.target.value); } catch { /* private window */ }
    render();
  });
  fields = (await Data.listFields()).filter((f) => !f.simulated && f.event);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
