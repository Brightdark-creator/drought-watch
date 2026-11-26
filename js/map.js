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
let overlays = null;     // NASA layers: today's greenness and soil moisture
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
 * handlers.onAreaSelect(box)       an area was dragged: { south, west, north, east }
 */
export async function initMap(container, newHandlers, labels) {
  handlers = newHandlers;
  await loadLeaflet();
  if (map) return;
  map = L.map(container, { worldCopyJump: true }).setView([35, 0], 2);
  // The warning card overlaps the bottom of the map, so the map credits go to the top (they must stay visible).
  map.attributionControl.setPosition('topright');
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
  // Overlays from NASA GIBS (newest picture, tiles need no account): what the
  // satellites see right now, over the whole map. Switched on in the layer box.
  const gibs = (layer, matrix, maxNativeZoom, credit) => L.tileLayer(
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/${matrix}/{z}/{y}/{x}.png`,
    { maxNativeZoom, maxZoom: 18, opacity: 0.7, attribution: `${credit} via <a href="https://www.earthdata.nasa.gov/gibs">NASA GIBS</a>` },
  );
  overlays = {
    greenness: gibs('MODIS_Terra_L3_NDVI_16Day', 'GoogleMapsCompatible_Level9', 9, 'MODIS NDVI 16-day'),
    soil: gibs('SMAP_L4_Analyzed_Root_Zone_Soil_Moisture', 'GoogleMapsCompatible_Level6', 6, 'SMAP L4 root-zone soil moisture'),
  };
  baseName = readBase();
  layers[baseName].addTo(map);
  setLayerLabels(labels);
  map.on('baselayerchange', (e) => {
    baseName = e.layer === layers.map ? 'map' : 'satellite';
    try { localStorage.setItem('dw.base', baseName); } catch { /* not important */ }
    for (const pin of pins.values()) pin.outline?.setStyle(OUTLINE[baseName]);
  });
  map.on('click', (e) => {
    if (justDrew) return; // the click that ends a drag is not a "check this point"
    handlers.onMapClick?.(e.latlng.lat, e.latlng.lng);
  });
  installAreaTool();
}

/** (Re)build the Satellite/Map switch with texts in the current language. */
export function setLayerLabels(labels) {
  if (!map || !labels) return;
  setAreaLabels(labels);
  layerControl?.remove();
  const extra = labels.overlays && overlays
    ? { [labels.overlays.greenness]: overlays.greenness, [labels.overlays.soil]: overlays.soil }
    : null;
  layerControl = L.control.layers({ [labels.satellite]: layers.satellite, [labels.map]: layers.map }, extra, { collapsed: true, position: 'topright' }).addTo(map);
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
  const located = fields.filter(hasPosition);
  located.forEach((field) => addField(field, nameOf));
  if (located.length) {
    map.fitBounds(L.latLngBounds(located.map((f) => [f.lat, f.lon])), { padding: [40, 40], maxZoom: 6, animate: false });
  }
}

const hasPosition = (f) => Number.isFinite(f.lat) && Number.isFinite(f.lon);

/** Add one field (pin + outline). Fields without a position are skipped. */
export function addField(field, nameOf) {
  if (!map || !hasPosition(field) || pins.has(field.id)) return;
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

/** Remove a field from the map (used when an uploaded file is removed). */
export function removeField(id) {
  const pin = pins.get(id);
  if (!pin) return;
  pin.marker.remove();
  pin.outline?.remove();
  pins.delete(id);
  if (selectedId === id) selectedId = null;
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
  if (!map || !hasPosition(field)) return;
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


/* ---------- Drag to select an area ----------
   "Select area" (or Shift + drag) turns dragging into drawing: press, drag a
   rectangle, let go. Pointer events, so mouse, finger and pen all work.
   "Check this view" does the same for the visible map, for keyboard users. */
let areaMode = false;
let draft = null;      // the dashed rectangle while drawing
let justDrew = false;
let areaControl = null;
let areaLabels = { draw: 'Select area', active: 'Drag on the map', view: 'Check this view', hint: '' };

function installAreaTool() {
  map.boxZoom.disable(); // Shift + drag draws an area instead of zooming
  const box = map.getContainer();
  let start = null;
  const toLatLng = (e) => map.containerPointToLatLng(map.mouseEventToContainerPoint(e));

  box.addEventListener('pointerdown', (e) => {
    if (!(areaMode || e.shiftKey) || e.button !== 0 || e.target.closest('.leaflet-control')) return;
    e.preventDefault();
    e.stopPropagation(); // Leaflet must not start panning
    map.dragging.disable();
    start = toLatLng(e);
    draft?.remove();
    draft = L.rectangle([start, start], { color: '#ffd166', weight: 2.5, dashArray: '6 5', fillOpacity: 0.12, interactive: false }).addTo(map);
    box.setPointerCapture?.(e.pointerId);
  }, true);

  box.addEventListener('pointermove', (e) => {
    if (start) draft.setBounds(L.latLngBounds(start, toLatLng(e)));
  }, true);

  const finish = (e) => {
    if (!start) return;
    const bounds = L.latLngBounds(start, toLatLng(e));
    start = null;
    map.dragging.enable();
    justDrew = true;
    setTimeout(() => { justDrew = false; }, 60);
    const a = map.latLngToContainerPoint(bounds.getSouthWest());
    const b = map.latLngToContainerPoint(bounds.getNorthEast());
    if (Math.abs(a.x - b.x) < 12 || Math.abs(a.y - b.y) < 12) { clearDraft(); return; } // a tap, not a drag
    setAreaMode(false);
    handlers.onAreaSelect?.(boxOf(bounds));
  };
  box.addEventListener('pointerup', finish, true);
  box.addEventListener('pointercancel', () => { start = null; map.dragging.enable(); clearDraft(); }, true);
}

const boxOf = (bounds) => ({
  south: bounds.getSouth(), west: L.Util.wrapNum(bounds.getWest(), [-180, 180], true),
  north: bounds.getNorth(), east: L.Util.wrapNum(bounds.getEast(), [-180, 180], true),
});

export function clearDraft() {
  draft?.remove();
  draft = null;
}

export function setAreaMode(on) {
  areaMode = on;
  map?.getContainer().classList.toggle('area-mode', on);
  const button = areaControl?.getContainer().querySelector('.area-draw');
  if (button) {
    button.setAttribute('aria-pressed', String(on));
    button.querySelector('span').textContent = on ? areaLabels.active : areaLabels.draw;
  }
}

function setAreaLabels(labels) {
  areaLabels = { ...areaLabels, ...labels.area };
  areaControl?.remove();
  const AreaControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar area-control');
      div.innerHTML = `
        <button type="button" class="area-draw" aria-pressed="${areaMode}" title="${areaLabels.hint}">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${areaMode ? areaLabels.active : areaLabels.draw}</span>
        </button>
        <button type="button" class="area-view">${areaLabels.view}</button>`;
      L.DomEvent.disableClickPropagation(div);
      div.querySelector('.area-draw').addEventListener('click', () => setAreaMode(!areaMode));
      div.querySelector('.area-view').addEventListener('click', () => {
        setAreaMode(false);
        handlers.onAreaSelect?.(boxOf(map.getBounds().pad(-0.1))); // a bit inside the edges
      });
      return div;
    },
  });
  areaControl = new AreaControl({ position: 'topleft' }).addTo(map);
}
