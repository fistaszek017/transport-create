(function () {
/**
 * main.js
 * Application bootstrap: wires the UI to the map, API, storage and schematic modules.
 */

/* global TMB */
const {
  initMap,
  renderOsm,
  clearOsm,
  highlightOsmLine,
  editUserLine,
  setUserData,
  invalidateSize,
  getBounds,
  getZoom,
  setBasemap,
  listBasemaps,
  setRouteResolver,
  createRouter,
  fetchTransit,
  loadUserData,
  saveUserData,
  clearUserData,
  emptyUserData,
  exportUserData,
  exportSvgMarkup,
  importUserDataFromFile,
  renderSchematic,
  destroySchematic,
  fitSchematic,
  getSchematicSvgMarkup,
  setSchematicFocus,
  getSchematicFocus,
  setSchematicMoveMode,
  compareLines,
  createId,
  isTransitStop,
} = TMB;

const MIN_LOAD_ZOOM = 12;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  osm: { stops: [], lines: [] }, // fetched, never persisted
  user: loadUserData(),          // user-drawn delta, persisted in LocalStorage
  view: 'map',
  schematicDirty: true,          // data changed since last schematic render
  follow: 'all',                 // snap drawn lines onto any loaded route
  osmVersion: 0,                 // bumps whenever state.osm changes (router cache key)
  focusLine: null,               // currently previewed line on the schematic
  stationPos: {},                // schematic stationKey -> {x, y} after a manual drag
};

let fetchController = null;
let router = null;
let routerKey = null;            // `${follow}:${osmVersion}` the router was built for

// Which OSM route types each snapping mode follows.
const FOLLOW_TYPES = {
  tram: ['tram', 'light_rail', 'subway'],
  bus: ['bus'],
  all: null,
};

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

const el = {
  panel: $('#control-panel'),
  panelToggle: $('#panel-toggle'),
  mapView: $('#map-view'),
  schematicView: $('#schematic-view'),
  schematicContainer: $('#schematic'),
  schematicEmpty: $('#schematic-empty'),
  schematicLegend: $('#schematic-legend'),
  schematicControls: $('#schematic-controls'),
  viewButtons: document.querySelectorAll('.seg-btn[data-view]'),
  basemapSelect: $('#basemap-select'),
  followTracks: $('#follow-tracks'),
  btnLoadOsm: $('#btn-load-osm'),
  osmStopsOnly: $('#osm-stops-only'),
  btnClearOsm: $('#btn-clear-osm'),
  osmStats: $('#osm-stats'),
  osmLines: $('#osm-lines'),
  userStats: $('#user-stats'),
  btnExport: $('#btn-export'),
  btnImport: $('#btn-import'),
  fileImport: $('#file-import'),
  btnClearUser: $('#btn-clear-user'),
  spacingRange: $('#spacing-range'),
  spacingValue: $('#spacing-value'),
  gridSnap: $('#grid-snap'),
  showLabels: $('#show-labels'),
  showLineLabels: $('#show-line-labels'),
  btnRelayout: $('#btn-relayout'),
  btnMoveStops: $('#btn-move-stops'),
  btnFit: $('#btn-fit'),
  btnExportSvg: $('#btn-export-svg'),
  status: $('#status'),
};

/* ------------------------------------------------------------------ */
/* Status toast                                                        */
/* ------------------------------------------------------------------ */

let statusTimer = null;
function showStatus(message, type = 'info', timeout = 3500) {
  el.status.textContent = message;
  el.status.className = `status ${type}`;
  clearTimeout(statusTimer);
  if (timeout > 0) {
    statusTimer = setTimeout(hideStatus, timeout);
  }
}
function hideStatus() {
  el.status.classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

function updateUserStats() {
  const l = state.user.lines.length;
  const s = state.user.stops.length;
  el.userStats.textContent = `${l} ${l === 1 ? 'line' : 'lines'}, ${s} ${s === 1 ? 'stop' : 'stops'}`;
}

function editedRouteCount() {
  return state.user.lines.filter((l) => l.fromOsm).length;
}

function updateOsmStats() {
  const l = state.osm.lines.length;
  const edited = editedRouteCount();
  const s = state.osm.stops.length;
  if (!l && !s && !edited) {
    el.osmStats.textContent = 'No OSM data loaded.';
    return;
  }
  const routeCount = l + edited;
  const editedNote = edited ? ` (${edited} edited)` : '';
  el.osmStats.textContent = `${routeCount} ${routeCount === 1 ? 'route' : 'routes'}${editedNote}, ${s} stops.`;
}

/* ------------------------------------------------------------------ */
/* Route list (loaded OSM lines + routes edited from them)             */
/* ------------------------------------------------------------------ */

function routeRows() {
  const rows = [
    ...state.osm.lines.map((line) => ({ line, source: 'osm' })),
    ...state.user.lines.filter((line) => line.fromOsm).map((line) => ({ line, source: 'user' })),
  ];
  rows.sort((a, b) => compareLines(a.line, b.line));
  return rows;
}

function renderOsmLineList() {
  const rows = routeRows();
  el.osmLines.innerHTML = '';
  if (!rows.length) {
    el.osmLines.classList.add('hidden');
    return;
  }
  el.osmLines.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'line-list-head';
  head.textContent = `Routes · ${rows.length}`;
  el.osmLines.appendChild(head);

  const ul = document.createElement('ul');
  for (const { line, source } of rows) {
    const li = document.createElement('li');
    li.className = 'line-row';

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = line.color;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = line.name;
    const variantTitle = line.variants && line.variants.length ? line.variants.join('\n') : line.name;
    name.title = source === 'user' ? `${variantTitle}\nEdited route` : variantTitle;

    if (source === 'user') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'edited';
      li.append(sw, name, tag);
    } else {
      li.append(sw, name);
    }

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'row-act';
    preview.textContent = '\u25C9';
    preview.title = 'Preview on schematic';
    preview.addEventListener('click', (ev) => {
      ev.stopPropagation();
      previewLineOnSchematic(line.id, line.name);
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'row-act';
    edit.textContent = '\u270E';
    edit.title = source === 'user' ? 'Edit the shape of this route' : 'Edit this route (it stays in the list)';
    edit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (source === 'user') editListedUserLine(line.id);
      else convertOsmLineToUser(line.id);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-del';
    del.textContent = '\u00d7';
    del.title = 'Remove this route';
    del.setAttribute('aria-label', `Remove ${line.name}`);
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (source === 'user') deleteEditedRoute(line.id);
      else deleteOsmLine(line.id);
    });

    li.append(preview, edit, del);
    li.addEventListener('mouseenter', () => highlightOsmLine(line.id, true));
    li.addEventListener('mouseleave', () => highlightOsmLine(line.id, false));
    ul.appendChild(li);
  }
  el.osmLines.appendChild(ul);
}

function deleteEditedRoute(id) {
  const line = state.user.lines.find((l) => l.id === id);
  if (!line) return;
  state.user.lines = state.user.lines.filter((l) => l.id !== id);
  saveUserData(state.user);
  setUserData(state.user);
  updateUserStats();
  updateOsmStats();
  state.schematicDirty = true;
  renderOsmLineList();
  showStatus(`Removed “${line.name}”.`, 'info', 2000);
}

function editListedUserLine(id) {
  const go = () => {
    invalidateSize();
    if (!editUserLine(id)) showStatus('Could not edit this route.', 'error');
  };
  if (state.view !== 'map') setView('map');
  requestAnimationFrame(go);
}

function deleteOsmLine(id) {
  const line = state.osm.lines.find((l) => l.id === id);
  if (!line) return;
  state.osm.lines = state.osm.lines.filter((l) => l.id !== id);

  // Drop stops that are no longer referenced by any remaining line.
  const referenced = new Set();
  for (const l of state.osm.lines) {
    for (const seq of l.stopSequences || []) for (const sid of seq) referenced.add(sid);
    for (const sid of l.stopIds || []) referenced.add(sid);
  }
  state.osm.stops = state.osm.stops.filter(
    (s) => referenced.has(s.id) || isStandaloneStation(s)
  );

  state.osmVersion++;
  state.schematicDirty = true;
  renderOsm(state.osm);
  updateOsmStats();
  renderOsmLineList();
  refreshRouter();
  showStatus(`Removed “${line.name}”.`, 'info', 2000);
}

function isStandaloneStation(s) {
  return isTransitStop((s && s.tags) || {});
}

/* ------------------------------------------------------------------ */
/* Preview a line on the schematic (from the map or its popup)         */
/* ------------------------------------------------------------------ */

function previewLineOnSchematic(id, name) {
  state.focusLine = id;
  if (state.view !== 'schematic') {
    setView('schematic');
  } else {
    setSchematicFocus(id);
  }
  showStatus(`Previewing “${name || id}” on the schematic.`, 'info', 2500);
}

/* ------------------------------------------------------------------ */
/* Convert an OSM line into an editable custom line                    */
/* ------------------------------------------------------------------ */

function convertOsmLineToUser(id) {
  const line = state.osm.lines.find((l) => l.id === id);
  if (!line) return;
  const coords = chainSegments(line.segments || []);
  if (coords.length < 2) {
    showStatus('This line has no editable geometry.', 'error');
    return;
  }

  // Copy the line's stops so the schematic keeps its stations after conversion.
  const stopIds = new Set();
  for (const seq of line.stopSequences || []) for (const sid of seq) stopIds.add(sid);
  for (const sid of line.stopIds || []) stopIds.add(sid);
  const existing = new Set(state.user.stops.map((s) => `${s.name}@${s.lat.toFixed(4)},${s.lng.toFixed(4)}`));
  for (const sid of stopIds) {
    const s = state.osm.stops.find((os) => os.id === sid);
    if (!s) continue;
    const key = `${s.name}@${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
    if (existing.has(key)) continue;
    existing.add(key);
    state.user.stops.push({ id: createId('user-stop'), name: s.name, lat: s.lat, lng: s.lng });
  }

  state.user.lines.push({
    id: createId('user-line'),
    name: line.name,
    color: line.color,
    coords,
    fromOsm: true,
    ref: line.ref || '',
  });
  saveUserData(state.user);
  setUserData(state.user);
  updateUserStats();

  // Remove the original OSM line (its orphan stops are pruned by deleteOsmLine).
  state.osm.lines = state.osm.lines.filter((l) => l.id !== id);
  pruneOrphanOsmStops();
  state.osmVersion++;
  state.schematicDirty = true;
  renderOsm(state.osm);
  updateOsmStats();
  renderOsmLineList();
  refreshRouter();
  showStatus(`“${line.name}” stays in the route list. Reshape it on the map.`, 'success', 5000);
}

function pruneOrphanOsmStops() {
  const referenced = new Set();
  for (const l of state.osm.lines) {
    for (const seq of l.stopSequences || []) for (const sid of seq) referenced.add(sid);
    for (const sid of l.stopIds || []) referenced.add(sid);
  }
  state.osm.stops = state.osm.stops.filter((s) => referenced.has(s.id) || isStandaloneStation(s));
}

/** Chain disjoint OSM way segments into one polyline by nearest endpoints. */
function chainSegments(segments) {
  const segs = (segments || []).filter((s) => Array.isArray(s) && s.length >= 2).map((s) => s.slice());
  if (!segs.length) return [];
  const used = new Array(segs.length).fill(false);
  used[0] = true;
  let path = segs[0].slice();
  for (let k = 1; k < segs.length; k++) {
    const tail = path[path.length - 1];
    let best = -1, rev = false, bestD = Infinity;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const s = segs[i];
      const d0 = dist2(tail, s[0]);
      const d1 = dist2(tail, s[s.length - 1]);
      if (d0 < bestD) { bestD = d0; best = i; rev = false; }
      if (d1 < bestD) { bestD = d1; best = i; rev = true; }
    }
    if (best < 0) break;
    used[best] = true;
    let s = segs[best];
    if (rev) s = s.slice().reverse();
    if (dist2(tail, s[0]) < 1e-10) s = s.slice(1); // drop duplicated join point
    path = path.concat(s);
  }
  return path;
}

function dist2(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/* ------------------------------------------------------------------ */
/* Snap-to-tracks router                                               */
/* ------------------------------------------------------------------ */

function refreshRouter() {
  if (state.follow === 'off') {
    router = null;
    routerKey = null;
    setRouteResolver(null);
    return;
  }
  const key = `${state.follow}:${state.osmVersion}`;
  if (key !== routerKey) {
    const types = FOLLOW_TYPES[state.follow];
    router = createRouter(state.osm.lines, types);
    routerKey = key;
  }
  setRouteResolver(router && !router.isEmpty ? routeLine : null);
}

function routeLine(coords) {
  if (!router || router.isEmpty) {
    showStatus('No matching tracks loaded for snapping – drawn as a straight line.', 'error', 4000);
    return null;
  }
  const res = router.route(coords);
  if (!res.ok) {
    showStatus('No tracks near the drawn points – left as a free line.', 'error', 4000);
    return null;
  }
  if (res.legsStraight > 0) {
    showStatus(`Snapped to tracks (${res.legsRouted} of ${res.legsRouted + res.legsStraight} segments).`, 'info', 3500);
  } else {
    showStatus('Line snapped to OSM tracks.', 'success', 2500);
  }
  return res.coords;
}

/* ------------------------------------------------------------------ */
/* User data persistence                                               */
/* ------------------------------------------------------------------ */

function handleUserDataChange(userData) {
  state.user = userData;
  state.schematicDirty = true;
  if (!saveUserData(userData)) {
    showStatus('Could not save to LocalStorage (storage full or disabled).', 'error');
  }
  updateUserStats();
  updateOsmStats();
  renderOsmLineList();
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function getSchematicOptions() {
  return {
    spacing: Number(el.spacingRange.value) || 70,
    gridSnap: el.gridSnap.checked,
    showLabels: el.showLabels.checked,
    showLineLabels: el.showLineLabels.checked,
    focus: state.focusLine,
    positions: state.stationPos,
    onFocus: (id) => { state.focusLine = id; },
    onStationMove: (key, x, y) => {
      state.stationPos[key] = { x, y };
      refreshSchematic({ keepView: true });
    },
    onRecolor: recolorLine,
  };
}

function recolorLine(id, color) {
  let touched = null;
  for (const line of state.osm.lines) {
    if (line.id === id) { line.color = color; touched = 'osm'; }
  }
  for (const line of state.user.lines) {
    if (line.id === id) { line.color = color; touched = 'user'; }
  }
  if (!touched) return;
  if (touched === 'user') {
    saveUserData(state.user);
    setUserData(state.user);
  } else {
    renderOsm(state.osm);
  }
  renderOsmLineList();
  if (state.view === 'schematic') refreshSchematic({ keepView: true });
}

function refreshSchematic(extra) {
  const result = renderSchematic(el.schematicContainer, state, { ...getSchematicOptions(), ...extra });
  state.schematicDirty = false;
  const empty = result.nodes === 0;
  el.schematicEmpty.classList.toggle('hidden', !empty);
  if (empty) el.schematicLegend.classList.add('hidden');
  return result;
}

function setView(view) {
  if (view === state.view && view === 'map') return;
  state.view = view;

  el.viewButtons.forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  const schematic = view === 'schematic';
  el.mapView.classList.toggle('hidden', schematic);
  el.schematicView.classList.toggle('hidden', !schematic);
  el.schematicControls.classList.toggle('hidden', !schematic);

  if (schematic) {
    // Container must be visible before measuring.
    requestAnimationFrame(() => {
      const r = refreshSchematic();
      if (r.nodes) {
        showStatus(`Schematic: ${r.nodes} stations, ${r.edges} connections, ${r.lines} lines.`, 'info', 2500);
      }
    });
  } else {
    destroySchematic(el.schematicContainer);
    requestAnimationFrame(() => invalidateSize());
  }
}

/* ------------------------------------------------------------------ */
/* OSM loading                                                         */
/* ------------------------------------------------------------------ */

function selectedRouteTypes() {
  return [...document.querySelectorAll('input[name="route-type"]:checked')].map((i) => i.value);
}

async function loadOsmTransit() {
  // While a request is running the button acts as "Cancel".
  if (fetchController) {
    fetchController.abort();
    showStatus('Loading cancelled.', 'info', 2000);
    return;
  }
  if (state.view !== 'map') setView('map');

  const zoom = getZoom();
  if (zoom < MIN_LOAD_ZOOM) {
    showStatus(`Zoom in to level ${MIN_LOAD_ZOOM} or closer before loading (current: ${zoom}).`, 'error');
    return;
  }
  const types = selectedRouteTypes();
  if (!types.length) {
    showStatus('Select at least one route type.', 'error');
    return;
  }

  fetchController = new AbortController();

  el.btnLoadOsm.textContent = 'Cancel loading';
  showStatus('Fetching transit data from OpenStreetMap…', 'info', 0);

  try {
    const stopsOnly = el.osmStopsOnly.checked;
    const result = await fetchTransit(getBounds(), types, {
      signal: fetchController.signal,
      onStatus: (msg) => showStatus(msg, 'info', 0),
      stopsOnly,
    });
    state.osm = result;
    state.osmVersion++;
    state.schematicDirty = true;
    renderOsm(state.osm);
    updateOsmStats();
    renderOsmLineList();
    refreshRouter();
    if (!result.lines.length && !result.stops.length) {
      showStatus(stopsOnly
        ? 'No stops found in this area for the selected types.'
        : 'No transit routes found in this area for the selected types.', 'info');
    } else if (stopsOnly) {
      showStatus(`Loaded ${result.stops.length} stops. Route lines were skipped.`, 'success');
    } else {
      showStatus(`Loaded ${result.lines.length} routes and ${result.stops.length} stops.`, 'success');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    showStatus(err.message || 'Failed to load OSM data.', 'error', 9000);
  } finally {
    el.btnLoadOsm.textContent = el.osmStopsOnly.checked ? 'Load stops' : 'Load OSM Transit';
    fetchController = null;
  }
}

function clearOsmData() {
  if (fetchController) fetchController.abort();
  state.osm = { stops: [], lines: [] };
  state.osmVersion++;
  state.schematicDirty = true;
  clearOsm();
  updateOsmStats();
  renderOsmLineList();
  refreshRouter();
  showStatus('OSM data cleared.', 'info', 2000);
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

function handleExport() {
  if (!state.user.lines.length && !state.user.stops.length) {
    showStatus('Nothing to export yet – draw some lines or stops first.', 'error');
    return;
  }
  exportUserData(state.user);
  showStatus('Exported JSON file.', 'success', 2000);
}

async function handleImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // allow re-importing the same file
  if (!file) return;

  try {
    const data = await importUserDataFromFile(file);
    const hasExisting = state.user.lines.length || state.user.stops.length;
    if (hasExisting) {
      const ok = window.confirm(
        `Importing "${file.name}" will replace your current ${state.user.lines.length} lines and ${state.user.stops.length} stops. Continue?`
      );
      if (!ok) return;
    }
    state.user = data;
    saveUserData(state.user);
    setUserData(state.user);
    state.schematicDirty = true;
    updateUserStats();
    updateOsmStats();
    renderOsmLineList();
    if (state.view === 'schematic') refreshSchematic();
    showStatus(`Imported ${data.lines.length} lines and ${data.stops.length} stops.`, 'success');
  } catch (err) {
    console.error(err);
    showStatus(err.message || 'Import failed.', 'error', 6000);
  }
}

function handleClearUser() {
  if (!state.user.lines.length && !state.user.stops.length) return;
  const ok = window.confirm('Delete all your drawn lines and stops? This cannot be undone.');
  if (!ok) return;
  state.user = emptyUserData();
  clearUserData();
  saveUserData(state.user);
  setUserData(state.user);
  state.schematicDirty = true;
  updateUserStats();
  updateOsmStats();
  renderOsmLineList();
  if (state.view === 'schematic') refreshSchematic();
  showStatus('All drawings deleted.', 'info', 2000);
}

function handleExportSvg() {
  const markup = getSchematicSvgMarkup();
  if (!markup) {
    showStatus('Nothing to export – the schematic is empty.', 'error');
    return;
  }
  exportSvgMarkup(markup);
  showStatus('Exported SVG file.', 'success', 2000);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  el.viewButtons.forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));

  el.panelToggle.addEventListener('click', () => {
    const collapsed = el.panel.classList.toggle('collapsed');
    el.panelToggle.textContent = collapsed ? '+' : '−';
    el.panelToggle.title = collapsed ? 'Expand panel' : 'Collapse panel';
    el.panelToggle.setAttribute('aria-expanded', String(!collapsed));
  });

  el.basemapSelect.addEventListener('change', () => setBasemap(el.basemapSelect.value));

  el.followTracks.addEventListener('change', () => {
    state.follow = el.followTracks.value;
    refreshRouter();
    if (state.follow !== 'off') {
      if (!state.osm.lines.length) {
        showStatus('Load OSM transit first, then drawn lines will snap to it.', 'info', 4000);
      } else if (router && router.isEmpty) {
        const label = el.followTracks.selectedOptions[0].textContent.trim();
        showStatus(`No “${label}” geometry loaded – load that type to snap onto it.`, 'info', 4500);
      } else {
        showStatus('Snapping on: click points along a route and the line follows the tracks.', 'info', 4000);
      }
    }
  });

  el.btnLoadOsm.addEventListener('click', loadOsmTransit);
  el.osmStopsOnly.addEventListener('change', () => {
    if (!fetchController) {
      el.btnLoadOsm.textContent = el.osmStopsOnly.checked ? 'Load stops' : 'Load OSM Transit';
    }
  });
  el.btnClearOsm.addEventListener('click', clearOsmData);

  el.btnExport.addEventListener('click', handleExport);
  el.btnImport.addEventListener('click', () => el.fileImport.click());
  el.fileImport.addEventListener('change', handleImportFile);
  el.btnClearUser.addEventListener('click', handleClearUser);

  el.spacingRange.addEventListener('input', () => {
    el.spacingValue.textContent = el.spacingRange.value;
  });
  el.spacingRange.addEventListener('change', () => {
    if (state.view === 'schematic') refreshSchematic();
  });
  el.gridSnap.addEventListener('change', () => {
    if (state.view === 'schematic') refreshSchematic();
  });
  el.showLabels.addEventListener('change', () => {
    if (state.view === 'schematic') refreshSchematic();
  });
  el.showLineLabels.addEventListener('change', () => {
    if (state.view === 'schematic') refreshSchematic();
  });
  el.btnRelayout.addEventListener('click', () => {
    if (state.view === 'schematic') {
      state.stationPos = {};
      const r = refreshSchematic();
      showStatus(`Re-laid out ${r.nodes} stations.`, 'info', 2000);
    }
  });
  el.btnMoveStops.addEventListener('click', () => {
    const on = el.btnMoveStops.classList.toggle('active');
    el.btnMoveStops.setAttribute('aria-pressed', String(on));
    setSchematicMoveMode(on);
    showStatus(on
      ? 'Drag a stop to move it. Re-layout clears manual positions.'
      : 'Stop moving is off.', 'info', 2500);
  });
  el.btnFit.addEventListener('click', () => fitSchematic(400));
  el.btnExportSvg.addEventListener('click', handleExportSvg);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view === 'map') invalidateSize();
      else fitSchematic(0);
    }, 150);
  });

  // Keyboard shortcuts: 1 = map, 2 = schematic (ignored while typing).
  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (ev.key === '1') setView('map');
    if (ev.key === '2') setView('schematic');
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function populateBasemaps() {
  const bases = listBasemaps();
  el.basemapSelect.innerHTML = '';
  for (const b of bases) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.label;
    el.basemapSelect.appendChild(opt);
  }
  // Default matches map.js (the "transport" basemap).
  el.basemapSelect.value = bases[0].id;
}

function init() {
  initMap('map', {
    onChange: handleUserDataChange,
    onPreviewLine: previewLineOnSchematic,
    onEditOsmLine: convertOsmLineToUser,
  });
  populateBasemaps();
  setUserData(state.user);
  updateUserStats();
  updateOsmStats();
  renderOsmLineList();
  bindEvents();

  const restored = state.user.lines.length + state.user.stops.length;
  if (restored) {
    showStatus(`Restored ${state.user.lines.length} lines and ${state.user.stops.length} stops from your browser.`, 'info', 3000);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();
