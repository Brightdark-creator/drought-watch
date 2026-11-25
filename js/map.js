/**
 * map.js — the world map (Leaflet + OpenStreetMap tiles).
 * Leaflet is only downloaded when the map is shown, so light mode never
 * loads it. Each test field gets a pin with its traffic-light symbol and,
 * when zoomed in, its outline.
 */
import { SYMBOLS } from './analysis.js';

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

let leafletLoading = null;
let map = null;
let handlers = {};
const pins = new Map(); // field id -> { marker, outline, level }
let selectedId = null;
let layers = null;       // { satellite, map } base layers
let layerControl = null; // the Satellite/Map switch in the corner
let baseName = 'satellite';

// Field outline style: white on the satellite picture, dark green on the street map.
const OUTLINE = {
  satellite: { color: '#ffffff', weight: 2.5, fillOpacity: 0.12, fillColor: '#ffffff' },
  map: { color: '#1f6f50', weight: 2, fillOpacity: 0.15, fillColor: '#1f6f50' },
};

function readBase() {
  try { return localStorage.getItem('dw.base') === 'map' ? 'map' : 'satellite'; } catch { return 'satellite'; }
}

/** Add Leaflet's CSS and JS to the page once. */
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);
      const script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.onload = resolve;
      script.onerror = () => { leafletLoading = null; reject(new Error('Leaflet could not be loaded')); };
      document.head.appendChild(script);
    });
  }
  return leafletLoading;
}

/**
 * Create the map in `container`.
 * handlers.onFieldClick(id)        a field pin or outline was clicked
 * handlers.onMapClick(lat, lon)    somewhere else on the map was clicked
 */
export async function initMap(container, newHandlers, labels) {
  handlers = newHandlers;
  await loadLeaflet();
  if (map) return;
  map = L.map(container, { worldCopyJump: true }).setView([35, 0], 2);
  layers = {
    // Sentinel-2 cloudless: a cloud-free picture of the whole Earth made from
    // the same Sentinel-2 satellites the app uses (by EOX, free for non-commercial use).
    satellite: L.tileLayer('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg', {
      maxNativeZoom: 15,
      maxZoom: 18,
      attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020)',
    }),
    map: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
  };
  baseName = readBase();
  layers[baseName].addTo(map);
  setLayerLabels(labels);
  map.on('baselayerchange', (e) => {
    baseName = e.layer === layers.map ? 'map' : 'satellite';
    try { localStorage.setItem('dw.base', baseName); } catch { /* not important */ }
    for (const pin of pins.values()) pin.outline?.setStyle(OUTLINE[baseName]);
  });
  map.on('click', (e) => handlers.onMapClick?.(e.latlng.lat, e.latlng.lng));
}

/** (Re)build the Satellite/Map switch with texts in the current language. */
export function setLayerLabels(labels) {
  if (!map || !labels) return;
  layerControl?.remove();
  layerControl = L.control.layers({ [labels.satellite]: layers.satellite, [labels.map]: layers.map }, null, { collapsed: false, position: 'topright' }).addTo(map);
}

export function isMapReady() {
  return map !== null;
}

/** Remove the map completely (used when light mode is switched on). */
export function destroyMap() {
  if (!map) return;
  map.remove();
  map = null;
  layerControl = null;
  pins.clear();
}

function pinIcon(level, selected) {
  const cls = `pin pin-${level || 'none'}${selected ? ' pin-selected' : ''}`;
  return L.divIcon({
    className: 'pin-wrap', // our own class: no default white Leaflet box
    html: `<span class="${cls}" aria-hidden="true">${SYMBOLS[level] || ''}</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

/** Draw all fields and zoom so that every field is visible. */
export function showFields(fields, nameOf) {
  if (!map) return;
  for (const field of fields) {
    const marker = L.marker([field.lat, field.lon], { icon: pinIcon(null, false), title: nameOf(field), keyboard: true })
      .addTo(map)
      .on('click', () => handlers.onFieldClick?.(field.id));
    let outline = null;
    if (field.polygon) {
      outline = L.polygon(field.polygon, { ...OUTLINE[baseName], bubblingMouseEvents: false })
        .addTo(map)
        .on('click', () => handlers.onFieldClick?.(field.id));
    }
    pins.set(field.id, { marker, outline, level: null });
  }
  if (fields.length) {
    map.fitBounds(L.latLngBounds(fields.map((f) => [f.lat, f.lon])), { padding: [40, 40], maxZoom: 6, animate: false });
  }
}

/** Update a pin's colour and symbol after its data has been analysed. */
export function setFieldLevel(id, level) {
  const pin = pins.get(id);
  if (!pin) return;
  pin.level = level;
  pin.marker.setIcon(pinIcon(level, id === selectedId));
}

/** Highlight the selected field and zoom to it. */
export function focusField(field) {
  if (!map) return;
  const previous = selectedId;
  selectedId = field.id;
  if (previous && pins.has(previous)) setFieldLevel(previous, pins.get(previous).level);
  setFieldLevel(field.id, pins.get(field.id)?.level ?? null);
  const outline = pins.get(field.id)?.outline;
  if (!canAnimate()) {
    if (outline) map.fitBounds(outline.getBounds(), { padding: [60, 60], maxZoom: 15, animate: false });
    else map.setView([field.lat, field.lon], 14, { animate: false });
  } else if (outline) map.flyToBounds(outline.getBounds(), { padding: [60, 60], maxZoom: 15, duration: 1 });
  else map.flyTo([field.lat, field.lon], 14, { duration: 1 });
}

export function flyTo(lat, lon, zoom = 11) {
  if (!map) return;
  if (canAnimate()) map.flyTo([lat, lon], zoom, { duration: 1 });
  else map.setView([lat, lon], zoom, { animate: false });
}

/** No flying animation in a hidden tab (it would freeze halfway) or if the user asked for less motion. */
function canAnimate() {
  return !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
