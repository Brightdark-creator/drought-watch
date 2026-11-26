/**
 * home.js — the home page: texts in the chosen language, the language menu
 * and the list of satellite case studies (from data/fields.json, with the
 * warning level each one reached, worked out by the same analysis as the map).
 */
import * as Data from './data.js';
import { t, pick, setLanguage, applyStaticTexts, LANGUAGES } from './i18n.js';
import { STRINGS } from './lang.js';
import { setupQr } from './qr.js';
import { loadLeaflet } from './map.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let fields = [];

function readLang() {
  try { return localStorage.getItem('dw.lang') || 'en'; } catch { return 'en'; } // English unless chosen before
}

const THEMES = ['dark', 'earth', 'light'];

function buildThemeMenu() {
  const current = document.documentElement.dataset.theme || 'dark';
  $('theme').innerHTML = THEMES.map((th) => `<option value="${th}"${th === current ? ' selected' : ''}>${esc(t(`theme_${th}`))}</option>`).join('');
}

/**
 * The hero map: real satellite imagery of the Earth with the official
 * Copernicus soil-moisture anomaly on top (brown = drier than normal right
 * now). A click anywhere opens that place on the map page.
 */
async function startHomeMap() {
  try {
    await loadLeaflet();
  } catch {
    return; // no map: the search still works
  }
  const map = L.map('home-map', { zoomControl: false, minZoom: 2, maxBounds: [[-75, -400], [85, 400]], scrollWheelZoom: false, worldCopyJump: true, attributionControl: true })
    .setView([24, 12], window.innerWidth < 700 ? 1 : window.innerWidth < 1200 ? 2 : 3);
  map.attributionControl.setPosition('bottomright');
  L.tileLayer('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg', {
    maxNativeZoom: 15, maxZoom: 18,
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX (Copernicus Sentinel data 2020)',
  }).addTo(map);
  L.tileLayer.wms('https://drought.emergency.copernicus.eu/api/wms', {
    layers: 'smang', format: 'image/png', transparent: true, version: '1.3.0', uppercase: true, opacity: 0.9, className: 'gdo-layer',
    attribution: '<a href="https://drought.emergency.copernicus.eu/">Copernicus Drought Observatory</a>',
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.on('click', (e) => {
    const { lat, lng } = e.latlng.wrap();
    location.href = `check.html?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`;
  });
}

function render() {
  applyStaticTexts();
  buildThemeMenu();
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  document.title = t('appTitle');
  renderCases();
}

/** Farm regions to check now: each link opens the CURRENT year for that place (live data). */
function renderCases() {
  $('home-cases').innerHTML = fields.map((f) => `
    <li><a href="check.html?lat=${f.lat.toFixed(4)}&amp;lon=${f.lon.toFixed(4)}">
      <b>${esc(pick(f.name))}</b>
      <span>${esc(t('homeCheckNow'))} <span aria-hidden="true">→</span></span>
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
  $('theme').addEventListener('change', (e) => {
    document.documentElement.classList.add('no-trans');
    document.documentElement.dataset.theme = e.target.value;
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('no-trans')));
    try { localStorage.setItem('dw.theme', e.target.value); } catch { /* private window */ }
  });
  setupQr($('phone-qr'), $('qr'), () => t('qrAlt'));
  startHomeMap();
  fields = (await Data.listFields()).filter((f) => !f.simulated && f.event);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
