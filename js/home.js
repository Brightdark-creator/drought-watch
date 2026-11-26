/**
 * home.js — the home page: texts in the chosen language, the language menu
 * and the list of satellite case studies (from data/fields.json, with the
 * warning level each one reached, worked out by the same analysis as the map).
 */
import * as Data from './data.js';
import { t, pick, setLanguage, applyStaticTexts, LANGUAGES } from './i18n.js';
import { STRINGS } from './lang.js';
import { setupQr } from './qr.js';

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

/** Farm regions to check now: each link opens the CURRENT year for that place (live data). */
function renderCases() {
  $('home-cases').innerHTML = fields.map((f) => `
    <li><a href="check.html?lat=${f.lat.toFixed(4)}&amp;lon=${f.lon.toFixed(4)}">
      <span class="mini lvl-off" aria-hidden="true">→</span>
      <span class="home-case-name"><b>${esc(pick(f.name))}</b></span>
      <span class="home-case-event">${esc(t('homeCheckNow'))}</span>
    </a></li>`).join('');
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
  setupQr($('phone-qr'), $('qr'), () => t('qrAlt'));
  fields = (await Data.listFields()).filter((f) => !f.simulated && f.event);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
