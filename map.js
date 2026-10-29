var TMB = window.TMB || {};
(function () {
/**
 * map.js
 * Leaflet map initialization, Leaflet-Geoman drawing tools and
 * rendering of both OSM data and user-drawn data.
 *
 * The module keeps a reference to the *user data object* that main.js owns,
 * mutates it in place when the user draws/edits/removes features, and
 * notifies main.js through the `onChange` callback so it can persist it.
 */

/* global L, TMB */
const { createId } = TMB;

const DEFAULT_CENTER = [52.2297, 21.0122]; // Warsaw
const DEFAULT_ZOOM = 13;

const LINE_PALETTE = [
  '#e3262e', '#0057a8', '#00843d', '#f58220', '#7b2d8e',
  '#00a4a7', '#b06000', '#e3007a', '#5a5a5a', '#8dba1a',
];

const STOP_ICON = L.divIcon({
  className: 'user-stop-icon',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  popupAnchor: [0, -10],
  tooltipAnchor: [8, 0],
});

let map = null;
let baseLayer = null;
let osmLayer = null;
let userLayer = null;
let userData = null;
let onChange = () => {};
let routeResolver = null;
let onPreviewLine = null;
let onEditOsmLine = null;

/** id -> Leaflet layer for user-drawn features */
const layerById = new Map();
/** OSM line id -> Leaflet polyline, for list hover/highlight */
const osmLineLayers = new Map();

/* ------------------------------------------------------------------ */
/* Basemaps (all usable when the page is opened from disk via file://) */
/* ------------------------------------------------------------------ */

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI = (service, extra) => ({
  url: `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
  options: { maxZoom: 19, attribution: `Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; ${extra}` },
});

const BASEMAPS = {
  transport: {
    label: 'Transport (tram & bus lines)',
    url: 'https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png',
    options: { maxZoom: 18, attribution: `Map <a href="https://memomaps.de/">memomaps.de</a> (CC-BY-SA), data ${OSM_ATTR}` },
  },
  streets: { label: 'Streets', ...ESRI('World_Street_Map', 'Esri, HERE, Garmin, &copy; OSM contributors') },
  topo: { label: 'Topographic', ...ESRI('World_Topo_Map', 'Esri, HERE, Garmin, &copy; OSM contributors') },
  satellite: { label: 'Satellite', ...ESRI('World_Imagery', 'Esri, Maxar, Earthstar Geographics') },
};
const DEFAULT_BASEMAP = 'transport';

function listBasemaps() {
  return Object.entries(BASEMAPS).map(([id, b]) => ({ id, label: b.label }));
}

function setBasemap(id) {
  const def = BASEMAPS[id] || BASEMAPS[DEFAULT_BASEMAP];
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(def.url, def.options).addTo(map);
  baseLayer.bringToBack();
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {string} containerId
 * @param {{ onChange?: (userData) => void }} [opts]
 */
function initMap(containerId, opts = {}) {
  onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  onPreviewLine = typeof opts.onPreviewLine === 'function' ? opts.onPreviewLine : null;
  onEditOsmLine = typeof opts.onEditOsmLine === 'function' ? opts.onEditOsmLine : null;

  map = L.map(containerId, {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    preferCanvas: false,
  });

  // tile.openstreetmap.org and CARTO reject requests without a Referer (pages opened via file://).
  setBasemap(DEFAULT_BASEMAP);

  osmLayer = L.layerGroup().addTo(map);
  userLayer = L.featureGroup().addTo(map);

  // --- Geoman setup ---
  map.pm.setGlobalOptions({
    layerGroup: userLayer,
    markerStyle: { icon: STOP_ICON },
    pathOptions: { color: LINE_PALETTE[0], weight: 5, opacity: 0.95 },
    templineStyle: { color: LINE_PALETTE[0], weight: 4, dashArray: '6 6' },
    hintlineStyle: { color: LINE_PALETTE[0], weight: 3, dashArray: '4 6', opacity: 0.6 },
    continueDrawing: false,
    snappable: true,
    snapDistance: 15,
    allowSelfIntersection: true,
  });

  map.pm.addControls({
    position: 'topleft',
    drawMarker: true,
    drawPolyline: true,
    drawCircle: false,
    drawCircleMarker: false,
    drawRectangle: false,
    drawPolygon: false,
    drawText: false,
    cutPolygon: false,
    rotateMode: false,
    editMode: true,
    dragMode: true,
    removalMode: true,
  });

  map.pm.Toolbar.changeActionsOfControl('Marker', ['cancel']);
  map.pm.Toolbar.changeActionsOfControl('Line', ['finish', 'removeLastVertex', 'cancel']);

  map.on('pm:create', handleCreate);
  map.on('pm:remove', handleRemove);

  return map;
}

function getMap() {
  return map;
}

function invalidateSize() {
  if (map) map.invalidateSize();
}

function getBounds() {
  const b = map.getBounds();
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

function getZoom() {
  return map.getZoom();
}

/* ------------------------------------------------------------------ */
/* OSM rendering (read-only, ignored by Geoman)                        */
/* ------------------------------------------------------------------ */

function renderOsm(osm) {
  osmLayer.clearLayers();
  osmLineLayers.clear();
  if (!osm) return;

  for (const line of osm.lines || []) {
    if (!line.segments || !line.segments.length) continue;
    const poly = L.polyline(line.segments, {
      color: line.color,
      weight: 3,
      opacity: 0.8,
      pmIgnore: true,
      interactive: true,
    });
    poly._baseWeight = 3;
    poly.bindTooltip(escapeHtml(line.name), { sticky: true, className: 'osm-stop-tooltip' });
    poly.on('mouseover', () => highlightOsmLine(line.id, true));
    poly.on('mouseout', () => highlightOsmLine(line.id, false));
    poly.bindPopup(() => buildOsmLinePopup(line), { minWidth: 200 });
    osmLayer.addLayer(poly);
    osmLineLayers.set(line.id, poly);
  }

  for (const stop of osm.stops || []) {
    const marker = L.circleMarker([stop.lat, stop.lng], {
      radius: 4,
      color: '#1c2430',
      weight: 1.5,
      fillColor: '#ffffff',
      fillOpacity: 1,
      pmIgnore: true,
    });
    marker.bindTooltip(escapeHtml(stop.name), { direction: 'top', className: 'osm-stop-tooltip' });
    osmLayer.addLayer(marker);
  }
}

function clearOsm() {
  osmLayer.clearLayers();
  osmLineLayers.clear();
}

/** Popup for an OSM line: preview on the schematic, or make it editable. */
function buildOsmLinePopup(line) {
  const root = document.createElement('div');
  root.className = 'feature-editor';

  const title = document.createElement('h4');
  title.textContent = 'OSM line';
  root.appendChild(title);

  const name = document.createElement('p');
  name.className = 'meta';
  name.style.fontWeight = '700';
  name.style.color = '#1b2a4a';
  name.textContent = line.name;
  root.appendChild(name);

  if (line.variants && line.variants.length > 1) {
    const v = document.createElement('p');
    v.className = 'meta';
    v.textContent = `${line.variants.length} directions/variants`;
    root.appendChild(v);
  }

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'btn primary';
  preview.textContent = 'Preview on schematic';
  preview.addEventListener('click', () => {
    map.closePopup();
    if (onPreviewLine) onPreviewLine(line.id, line.name);
  });
  root.appendChild(preview);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn';
  edit.style.marginTop = '6px';
  edit.textContent = 'Edit this line';
  edit.title = 'Turn this OSM line into an editable custom line';
  edit.addEventListener('click', () => {
    map.closePopup();
    if (onEditOsmLine) onEditOsmLine(line.id);
  });
  root.appendChild(edit);

  return root;
}

/** Emphasize a line on hover from the map or the route list (OSM or an edited copy). */
function highlightOsmLine(id, on) {
  const poly = osmLineLayers.get(id) || layerById.get(id);
  if (!poly || !poly._baseWeight || typeof poly.setStyle !== 'function') return;
  if (on) {
    poly.setStyle({ weight: poly._baseWeight + 4, opacity: 1 });
    if (poly.bringToFront) poly.bringToFront();
  } else {
    poly.setStyle({ weight: poly._baseWeight, opacity: poly._baseWeight > 4 ? 0.95 : 0.8 });
  }
}

/** Turn on vertex editing for a custom line and frame it on the map. */
function editUserLine(id) {
  const layer = layerById.get(id);
  if (!layer || !layer.pm || layer._tmbKind !== 'line') return false;
  if (layer.pm.enabled()) layer.pm.disable();
  layer.pm.enable({ allowSelfIntersection: true });
  if (layer.getBounds) {
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.35));
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* User data rendering                                                 */
/* ------------------------------------------------------------------ */

/**
 * Replace the current user data with `data`, render it, and keep the
 * reference for in-place mutation by drawing handlers.
 */
function setUserData(data) {
  userData = data;
  userLayer.clearLayers();
  layerById.clear();

  for (const line of userData.lines) {
    const layer = L.polyline(line.coords, {
      color: line.color,
      weight: 5,
      opacity: 0.95,
    });
    layer._baseWeight = 5;
    userLayer.addLayer(layer);
    bindUserLayer(layer, line, 'line');
  }

  for (const stop of userData.stops) {
    const layer = L.marker([stop.lat, stop.lng], { icon: STOP_ICON });
    userLayer.addLayer(layer);
    bindUserLayer(layer, stop, 'stop');
  }
}

function fitUserData() {
  if (userLayer && userLayer.getLayers().length) {
    map.fitBounds(userLayer.getBounds().pad(0.2));
  }
}

/* ------------------------------------------------------------------ */
/* Geoman event handlers                                               */
/* ------------------------------------------------------------------ */

function nextLineColor() {
  return LINE_PALETTE[userData.lines.length % LINE_PALETTE.length];
}

function handleCreate(e) {
  const { shape, layer } = e;

  if (shape === 'Line') {
    let coords = latLngsToCoords(layer.getLatLngs());
    if (coords.length < 2) {
      userLayer.removeLayer(layer);
      return;
    }
    // Optional: snap the drawn line so it follows real OSM tracks/routes.
    if (routeResolver) {
      const routed = routeResolver(coords);
      if (routed && routed.length >= 2) {
        coords = routed;
        layer.setLatLngs(coords);
      }
    }
    const line = {
      id: createId('user-line'),
      name: `Line ${userData.lines.length + 1}`,
      color: nextLineColor(),
      coords,
    };
    layer._baseWeight = 5;
    layer.setStyle({ color: line.color, weight: 5, opacity: 0.95 });
    userData.lines.push(line);
    bindUserLayer(layer, line, 'line');
    emitChange();
    layer.openPopup();
    return;
  }

  if (shape === 'Marker') {
    const ll = layer.getLatLng();
    const stop = {
      id: createId('user-stop'),
      name: `Stop ${userData.stops.length + 1}`,
      lat: ll.lat,
      lng: ll.lng,
    };
    userData.stops.push(stop);
    bindUserLayer(layer, stop, 'stop');
    emitChange();
    layer.openPopup();
    return;
  }

  // Unsupported shape – should not happen since controls are disabled.
  userLayer.removeLayer(layer);
}

function handleRemove(e) {
  const layer = e.layer;
  const id = layer && layer._tmbId;
  if (!id) return;
  removeRecord(id);
  layerById.delete(id);
  emitChange();
}

function removeRecord(id) {
  userData.lines = userData.lines.filter((l) => l.id !== id);
  userData.stops = userData.stops.filter((s) => s.id !== id);
}

/**
 * Attach record metadata, edit listeners and the editor popup to a layer.
 */
function bindUserLayer(layer, record, kind) {
  layer._tmbId = record.id;
  layer._tmbKind = kind;
  layerById.set(record.id, layer);

  const sync = () => {
    if (kind === 'line') {
      record.coords = latLngsToCoords(layer.getLatLngs());
    } else {
      const ll = layer.getLatLng();
      record.lat = ll.lat;
      record.lng = ll.lng;
    }
    emitChange();
  };

  layer.on('pm:edit', sync);
  layer.on('pm:dragend', sync);
  layer.on('pm:markerdragend', sync);
  layer.on('pm:vertexremoved', sync);

  layer.bindTooltip(() => escapeHtml(record.name), {
    direction: 'top',
    sticky: kind === 'line',
    className: 'user-tooltip',
  });

  layer.bindPopup(() => buildEditorPopup(layer, record, kind), {
    closeButton: true,
    autoPan: true,
    minWidth: 200,
  });
}

/**
 * Build the popup DOM for editing a user feature (name, color, delete).
 */
function buildEditorPopup(layer, record, kind) {
  const root = document.createElement('div');
  root.className = 'feature-editor';

  const title = document.createElement('h4');
  title.textContent = kind === 'line' ? 'Custom line' : 'Custom stop';
  root.appendChild(title);

  // Name
  const nameLabel = document.createElement('label');
  const nameSpan = document.createElement('span');
  nameSpan.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = record.name;
  nameInput.maxLength = 80;
  nameInput.addEventListener('input', () => {
    record.name = nameInput.value.trim() || (kind === 'line' ? 'Unnamed line' : 'Unnamed stop');
    emitChange();
  });
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') layer.closePopup();
  });
  nameLabel.append(nameSpan, nameInput);
  root.appendChild(nameLabel);

  // Color (lines only)
  if (kind === 'line') {
    const colorLabel = document.createElement('label');
    const colorSpan = document.createElement('span');
    colorSpan.textContent = 'Color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = toHexColor(record.color);
    colorInput.addEventListener('input', () => {
      record.color = colorInput.value;
      layer.setStyle({ color: record.color });
      emitChange();
    });
    colorLabel.append(colorSpan, colorInput);
    root.appendChild(colorLabel);
  }

  // Meta
  const meta = document.createElement('p');
  meta.className = 'meta';
  if (kind === 'line') {
    const km = (polylineLengthMeters(record.coords) / 1000).toFixed(2);
    meta.textContent = `${record.coords.length} vertices · ${km} km · ID ${record.id}`;
  } else {
    meta.textContent = `${record.lat.toFixed(5)}, ${record.lng.toFixed(5)} · ID ${record.id}`;
  }
  root.appendChild(meta);

  // Edit shape (lines): toggle Geoman vertex editing on this layer.
  if (kind === 'line') {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn';
    const refresh = () => {
      const on = layer.pm && layer.pm.enabled && layer.pm.enabled();
      editBtn.textContent = on ? 'Finish editing shape' : 'Edit shape';
    };
    editBtn.addEventListener('click', () => {
      if (!layer.pm) return;
      if (layer.pm.enabled()) {
        layer.pm.disable();
      } else {
        layer.pm.enable({ allowSelfIntersection: true });
        layer.closePopup();
      }
      refresh();
    });
    refresh();
    root.appendChild(editBtn);

    const hint = document.createElement('p');
    hint.className = 'meta';
    hint.textContent = 'Drag points to move; drag a midpoint to add; right-click a point to remove.';
    root.appendChild(hint);
  }

  // Delete
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn danger';
  del.textContent = 'Delete';
  del.addEventListener('click', () => {
    layer.closePopup();
    userLayer.removeLayer(layer);
    layerById.delete(record.id);
    removeRecord(record.id);
    emitChange();
  });
  root.appendChild(del);

  setTimeout(() => nameInput.select(), 50);
  return root;
}

function emitChange() {
  onChange(userData);
}

/**
 * Install a function that rewrites freshly drawn line coordinates so they
 * follow OSM geometry. Pass null to disable (free drawing).
 * resolver(coords) → coords[] | null
 */
function setRouteResolver(fn) {
  routeResolver = typeof fn === 'function' ? fn : null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function latLngsToCoords(latlngs) {
  // Geoman polylines are flat arrays; guard against nested arrays anyway.
  const flat = Array.isArray(latlngs[0]) ? latlngs.flat(Infinity) : latlngs;
  return flat
    .filter((ll) => ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng))
    .map((ll) => [round6(ll.lat), round6(ll.lng)]);
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function toHexColor(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return '#' + color.slice(1).split('').map((c) => c + c).join('');
  }
  // Resolve named colors through the canvas API.
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = color;
    const v = ctx.fillStyle;
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  } catch (_) { /* ignore */ }
  return '#1f5eff';
}

function polylineLengthMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversine(coords[i - 1], coords[i]);
  }
  return total;
}

function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

TMB.initMap = initMap;
TMB.getMap = getMap;
TMB.invalidateSize = invalidateSize;
TMB.getBounds = getBounds;
TMB.getZoom = getZoom;
TMB.renderOsm = renderOsm;
TMB.clearOsm = clearOsm;
TMB.highlightOsmLine = highlightOsmLine;
TMB.editUserLine = editUserLine;
TMB.setUserData = setUserData;
TMB.fitUserData = fitUserData;
TMB.setBasemap = setBasemap;
TMB.listBasemaps = listBasemaps;
TMB.setRouteResolver = setRouteResolver;
})();
