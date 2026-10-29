var TMB = window.TMB || {};
(function () {
/**
 * storage.js
 * LocalStorage persistence + JSON import/export for user-drawn data.
 *
 * User data shape (the "delta" that is persisted):
 * {
 *   version: 1,
 *   stops: [ { id, name, lat, lng } ],
 *   lines: [ { id, name, color, coords: [[lat, lng], ...], fromOsm?: true, ref?: string } ]
 * }
 */

const STORAGE_KEY = 'transit-map-builder:user-data:v1';
const DATA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* IDs                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Generate a unique ID with the given prefix (e.g. "user-stop-…").
 */
function createId(prefix = 'user') {
  let random;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    random = crypto.randomUUID().slice(0, 8);
  } else {
    random = Math.random().toString(36).slice(2, 10);
  }
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/* ------------------------------------------------------------------ */
/* Shape helpers / validation                                          */
/* ------------------------------------------------------------------ */

function emptyUserData() {
  return { version: DATA_VERSION, stops: [], lines: [] };
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function isLatLngPair(p) {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    isFiniteNumber(p[0]) &&
    isFiniteNumber(p[1]) &&
    p[0] >= -90 && p[0] <= 90 &&
    p[1] >= -180 && p[1] <= 180
  );
}

function normalizeColor(c, fallback = '#1f5eff') {
  if (typeof c !== 'string') return fallback;
  const s = c.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
  // allow CSS named colors / rgb() strings as-is (best effort)
  if (/^[a-z]+$/i.test(s) || /^rgba?\(/i.test(s)) return s;
  return fallback;
}

/**
 * Validate and normalize a raw object into the canonical user-data shape.
 * Invalid individual records are dropped; a fundamentally invalid payload throws.
 */
function normalizeUserData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid data: expected a JSON object with "stops" and "lines".');
  }
  const stopsIn = Array.isArray(raw.stops) ? raw.stops : [];
  const linesIn = Array.isArray(raw.lines) ? raw.lines : [];
  if (!Array.isArray(raw.stops) && !Array.isArray(raw.lines)) {
    throw new Error('Invalid data: missing "stops" and "lines" arrays.');
  }

  const seen = new Set();
  const uniqueId = (id, prefix) => {
    let out = typeof id === 'string' && id.trim() ? id.trim() : createId(prefix);
    while (seen.has(out)) out = createId(prefix);
    seen.add(out);
    return out;
  };

  const stops = [];
  for (const s of stopsIn) {
    if (!s || typeof s !== 'object') continue;
    const lat = Number(s.lat);
    const lng = Number(s.lng ?? s.lon);
    if (!isLatLngPair([lat, lng])) continue;
    stops.push({
      id: uniqueId(s.id, 'user-stop'),
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : 'Unnamed stop',
      lat,
      lng,
    });
  }

  const lines = [];
  for (const l of linesIn) {
    if (!l || typeof l !== 'object' || !Array.isArray(l.coords)) continue;
    const coords = l.coords
      .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null))
      .filter((p) => p && isLatLngPair(p));
    if (coords.length < 2) continue;
    const line = {
      id: uniqueId(l.id, 'user-line'),
      name: typeof l.name === 'string' && l.name.trim() ? l.name.trim() : 'Unnamed line',
      color: normalizeColor(l.color),
      coords,
    };
    // Lines converted from a loaded route stay in the route list after a reload.
    if (l.fromOsm) line.fromOsm = true;
    if (typeof l.ref === 'string' && l.ref.trim()) line.ref = l.ref.trim();
    lines.push(line);
  }

  return { version: DATA_VERSION, stops, lines };
}

/* ------------------------------------------------------------------ */
/* LocalStorage                                                        */
/* ------------------------------------------------------------------ */

function loadUserData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyUserData();
    return normalizeUserData(JSON.parse(raw));
  } catch (err) {
    console.warn('[storage] Could not restore user data, starting fresh.', err);
    return emptyUserData();
  }
}

function saveUserData(data) {
  try {
    const payload = { ...data, version: DATA_VERSION, savedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error('[storage] Failed to save user data.', err);
    return false;
  }
}

function clearUserData() {
  localStorage.removeItem(STORAGE_KEY);
}

/* ------------------------------------------------------------------ */
/* File export / import                                                */
/* ------------------------------------------------------------------ */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

/**
 * Download the user-drawn data as a .json file.
 */
function exportUserData(data) {
  const payload = {
    app: 'Transit Map Builder',
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    stops: data.stops,
    lines: data.lines,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `transit-map-${timestampSlug()}.json`);
}

/**
 * Download arbitrary SVG markup as an .svg file.
 */
function exportSvgMarkup(svgMarkup) {
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  downloadBlob(blob, `transit-schematic-${timestampSlug()}.svg`);
}

/**
 * Read a File (from <input type="file">) and resolve with normalized user data.
 */
function importUserDataFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        resolve(normalizeUserData(parsed));
      } catch (err) {
        reject(new Error(`Import failed: ${err.message}`));
      }
    };
    reader.readAsText(file);
  });
}

TMB.createId = createId;
TMB.emptyUserData = emptyUserData;
TMB.normalizeUserData = normalizeUserData;
TMB.loadUserData = loadUserData;
TMB.saveUserData = saveUserData;
TMB.clearUserData = clearUserData;
TMB.exportUserData = exportUserData;
TMB.exportSvgMarkup = exportSvgMarkup;
TMB.importUserDataFromFile = importUserDataFromFile;
})();
