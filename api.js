var TMB = window.TMB || {};
(function () {
/**
 * api.js
 * Overpass API (OpenStreetMap) fetching for public transit data.
 *
 * Strategy: fetch `type=route` relations (tram / subway / light_rail / train / bus)
 * with inline geometry. Relations carry an *ordered* list of stop members, which
 * gives us real line topology for the schematic view. Stop nodes are fetched
 * separately so we get their names.
 *
 * OSM data shape returned by fetchTransit():
 * {
 *   stops: [ { id, osmId, name, lat, lng, tags } ],
 *   lines: [ {
 *     id, osmIds: [relationId, ...], name, ref, type, color, operator,
 *     variants: ["Tram 1: A => B", "Tram 1: B => A"],
 *     segments: [[[lat,lng],...], ...],        // track geometry (one array per OSM way)
 *     stopSequences: [[stopId, ...], ...]      // ordered stops, one array per direction/variant
 *   } ]
 * }
 * Both directions of a route (separate relations in OSM) are merged into one logical line.
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const QUERY_TIMEOUT_S = 35;          // server-side [timeout:]
const ENDPOINT_TIMEOUT_MS = 40000;   // client-side cap per endpoint
const STAGGER_MS = 3000;             // start the next mirror if the current one is still silent
const CACHE_PREFIX = 'transit-map-builder:osm-cache:';

const ROUTE_TYPES = ['tram', 'subway', 'light_rail', 'train', 'bus'];

/**
 * Combine an optional user AbortSignal with a timeout into one signal.
 */
function combineSignals(userSignal, timeoutMs) {
  const timeoutSignal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : null;
  if (!userSignal) return timeoutSignal || undefined;
  if (!timeoutSignal) return userSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([userSignal, timeoutSignal]);
  // Fallback for browsers without AbortSignal.any
  const controller = new AbortController();
  const abort = () => controller.abort();
  userSignal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

const DEFAULT_COLORS = {
  tram: '#d9372b',
  subway: '#1f4fd1',
  light_rail: '#2c9a3f',
  train: '#6b3fa0',
  bus: '#e08a00',
  default: '#555555',
};

// Used when the OSM relation has no `colour` tag (tube-map style distinct colours).
const FALLBACK_PALETTE = [
  '#e3262e', '#0057a8', '#00843d', '#f58220', '#7b2d8e', '#00a4a7',
  '#b06000', '#e3007a', '#5a5a5a', '#8dba1a', '#1b998b', '#c71585',
  '#ff6f61', '#4b0082', '#2e8b57', '#d2691e', '#4169e1', '#9acd32',
];

const ROUTE_LABELS = {
  tram: 'Tram',
  subway: 'Metro',
  light_rail: 'Light rail',
  train: 'Train',
  bus: 'Bus',
};

/* ------------------------------------------------------------------ */
/* Query building                                                      */
/* ------------------------------------------------------------------ */

/**
 * Stop nodes for the selected modes. Used alone for the fast "stops only" fetch,
 * and as a small extra so rail stations still appear when a route relation
 * doesn't list them.
 */
function stopClauses(routeTypes, bbox, { railStations = true, modeStops = true } = {}) {
  const t = new Set(routeTypes);
  const clauses = [];
  if (modeStops) {
    if (t.has('tram')) {
      clauses.push(`node["railway"="tram_stop"](${bbox});`);
      clauses.push(`node["tram"="yes"]["public_transport"](${bbox});`);
    }
    if (t.has('subway')) {
      clauses.push(`node["station"="subway"](${bbox});`);
      clauses.push(`node["subway"="yes"]["public_transport"](${bbox});`);
    }
    if (t.has('light_rail')) {
      clauses.push(`node["light_rail"="yes"]["public_transport"](${bbox});`);
    }
    if (t.has('train')) {
      clauses.push(`node["train"="yes"]["public_transport"](${bbox});`);
      clauses.push(`node["railway"~"^(station|halt)$"]["train"!="no"]["name"](${bbox});`);
    }
    if (t.has('bus')) {
      clauses.push(`node["highway"="bus_stop"](${bbox});`);
      clauses.push(`node["bus"="yes"]["public_transport"~"^(platform|stop_position)$"](${bbox});`);
    }
  }
  if (railStations) {
    const railway = [];
    if (t.has('tram')) railway.push('tram_stop');
    if (t.has('subway') || t.has('light_rail') || t.has('train')) railway.push('station', 'halt');
    if (railway.length) {
      clauses.push(`node["railway"~"^(${[...new Set(railway)].join('|')})$"]["name"](${bbox});`);
    }
  }
  return clauses;
}

function buildQuery(bbox, routeTypes, stopsOnly) {
  const types = routeTypes.filter((t) => ROUTE_TYPES.includes(t));
  if (stopsOnly) {
    // Nodes only — no route relations and no way geometry. This is the slow part
    // of a normal load, so skipping it usually returns in a few seconds.
    const clauses = stopClauses(types, bbox, { railStations: false, modeStops: true });
    if (!clauses.length) {
      clauses.push(`node["public_transport"~"^(platform|stop_position|station)$"](${bbox});`);
    }
    return `
[out:json][timeout:20];
(
  ${clauses.join('\n  ')}
);
out body;
`.trim();
  }
  const routeRegex = `^(${types.join('|')})$`;
  // geom(bbox) clips way geometry to the view. Stop nodes are also limited to
  // the view: a route that merely touches the area would otherwise drag in
  // every named stop on the whole line.
  const extra = stopClauses(types, bbox, { railStations: true, modeStops: false });
  return `
[out:json][timeout:${QUERY_TIMEOUT_S}];
relation["type"="route"]["route"~"${routeRegex}"](${bbox})->.routes;
.routes out body geom(${bbox});
(
  node(r.routes)["name"](${bbox});
  ${extra.join('\n  ')}
);
out body;
`.trim();
}

/* ------------------------------------------------------------------ */
/* Fetch with endpoint fallback                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {{south:number, west:number, north:number, east:number}} bounds
 * @param {string[]} routeTypes  subset of ROUTE_TYPES
 * @param {{signal?: AbortSignal, onStatus?: (msg:string)=>void}} [opts]
 */
async function fetchTransit(bounds, routeTypes, opts = {}) {
  const { signal, onStatus = () => {}, stopsOnly = false } = opts;
  const types = (routeTypes && routeTypes.length ? routeTypes : ['tram', 'subway', 'light_rail']);
  // 4 decimals (~10 m) so tiny pans reuse the cache.
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((n) => Number(n).toFixed(4))
    .join(',');
  const query = buildQuery(bbox, types, stopsOnly);
  const cacheKey = CACHE_PREFIX + query;

  const cached = readCache(cacheKey);
  if (cached) {
    onStatus('Loaded from cache.');
    return parseOverpass(cached);
  }

  const json = await raceEndpoints(query, signal, onStatus);
  writeCache(cacheKey, json);
  return parseOverpass(json);
}

/**
 * Query mirrors with a staggered start: the next mirror is started when the
 * previous one fails or stays silent for STAGGER_MS. The first valid response
 * wins and all other requests are aborted.
 */
function raceEndpoints(query, userSignal, onStatus) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const controllers = [];
    const errors = [];
    let next = 0;
    let running = 0;
    let settled = false;
    let staggerTimer = null;

    const ticker = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      onStatus(`Querying Overpass… ${s}s (servers tried: ${next}/${ENDPOINTS.length})`);
    }, 1000);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearTimeout(staggerTimer);
      controllers.forEach((c) => c.abort());
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
      fn(value);
    };

    const onUserAbort = () => {
      const err = new Error('Request cancelled.');
      err.name = 'AbortError';
      finish(reject, err);
    };
    if (userSignal) {
      if (userSignal.aborted) return onUserAbort();
      userSignal.addEventListener('abort', onUserAbort);
    }

    const launchNext = () => {
      clearTimeout(staggerTimer);
      if (settled || next >= ENDPOINTS.length) return;
      const url = ENDPOINTS[next++];
      const controller = new AbortController();
      controllers.push(controller);
      running++;
      onStatus(`Querying Overpass… (servers tried: ${next}/${ENDPOINTS.length})`);

      fetchEndpoint(url, query, combineSignals(controller.signal, ENDPOINT_TIMEOUT_MS))
        .then((json) => finish(resolve, json))
        .catch((err) => {
          running--;
          if (settled) return;
          console.warn(`[api] Overpass endpoint failed (${url}):`, err);
          errors.push(describeError(err));
          if (next < ENDPOINTS.length) {
            launchNext();
          } else if (running === 0) {
            finish(reject, new Error(failureMessage(errors)));
          }
        });

      staggerTimer = setTimeout(launchNext, STAGGER_MS);
    };

    launchNext();
  });
}

async function fetchEndpoint(url, query, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (json.remark && /timed out|runtime error|out of memory/i.test(json.remark)) {
    throw new Error(json.remark);
  }
  return json;
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  if (err.status === 429) return 'rate limited';
  if (err.status >= 500) return `server busy (${err.status})`;
  if (err instanceof TypeError) return 'network error';
  return err.message;
}

function failureMessage(errors) {
  const rateLimited = errors.some((e) => e === 'rate limited');
  const hint = rateLimited
    ? 'Overpass is rate-limiting this connection – wait 1–2 minutes and try again.'
    : 'The public Overpass servers are overloaded – try a smaller area or try again in a few minutes.';
  return `Could not load OSM data (${errors.join(', ')}). ${hint}`;
}

/* ------------------------------------------------------------------ */
/* Response cache (sessionStorage, survives reloads within the tab)    */
/* ------------------------------------------------------------------ */

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeCache(key, json) {
  try {
    sessionStorage.setItem(key, JSON.stringify(json));
  } catch (_) {
    // Quota exceeded: drop older entries and give up silently.
    try {
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .forEach((k) => sessionStorage.removeItem(k));
    } catch (__) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function normalizeOsmColor(colour, routeType) {
  if (typeof colour === 'string') {
    const c = colour.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return c;
    if (/^[0-9a-f]{6}$/i.test(c)) return `#${c}`;
    if (/^[a-z]+$/i.test(c)) return c.toLowerCase(); // CSS named color
  }
  return DEFAULT_COLORS[routeType] || DEFAULT_COLORS.default;
}

function lineDisplayName(tags) {
  if (tags.name) return tags.name;
  const label = ROUTE_LABELS[tags.route] || 'Route';
  if (tags.ref) return `${label} ${tags.ref}`;
  if (tags.from && tags.to) return `${tags.from} → ${tags.to}`;
  return label;
}

/**
 * Convert an Overpass JSON response into our OSM data structure.
 */
function parseOverpass(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];

  // 1) Index nodes (stops / platforms / stations) by OSM id.
  const nodeById = new Map();
  for (const el of elements) {
    if (el.type !== 'node' || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
    const tags = el.tags || {};
    nodeById.set(el.id, {
      id: `osm-n-${el.id}`,
      osmId: el.id,
      name: tags.name || tags['name:en'] || tags.ref || `Stop ${el.id}`,
      lat: el.lat,
      lng: el.lon,
      tags,
    });
  }

  // 2) Build route variants from relations (OSM has one relation per direction).
  const variants = [];
  const usedStopIds = new Set();

  for (const el of elements) {
    if (el.type !== 'relation') continue;
    const tags = el.tags || {};
    const routeType = tags.route || 'default';
    const members = Array.isArray(el.members) ? el.members : [];

    const segments = []; // { wayRef, coords }
    const stopRoleRefs = [];
    const platformRoleRefs = [];
    const anyNodeRefs = [];

    for (const m of members) {
      if (m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length >= 2) {
        // Platforms mapped as ways are not track geometry: skip them.
        if (/platform/i.test(m.role || '')) continue;
        // Clipped output marks points outside the bbox as null: split into runs.
        let run = [];
        let runIndex = 0;
        const flush = () => {
          if (run.length >= 2) segments.push({ wayRef: `${m.ref}:${runIndex++}`, coords: run });
          run = [];
        };
        for (const p of m.geometry) {
          if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) run.push([p.lat, p.lon]);
          else flush();
        }
        flush();
      } else if (m.type === 'node') {
        const role = m.role || '';
        anyNodeRefs.push(m.ref);
        if (/^stop/i.test(role)) stopRoleRefs.push(m.ref);
        else if (/^platform/i.test(role)) platformRoleRefs.push(m.ref);
      }
    }

    const toKnown = (refs) => refs.filter((r) => nodeById.has(r));
    let orderedRefs = toKnown(stopRoleRefs);
    if (orderedRefs.length < 2) orderedRefs = toKnown(platformRoleRefs);
    if (orderedRefs.length < 2) orderedRefs = toKnown(anyNodeRefs);

    // Collapse immediate duplicates (same node referenced twice in a row).
    const stopIds = [];
    for (const ref of orderedRefs) {
      const id = nodeById.get(ref).id;
      if (stopIds[stopIds.length - 1] !== id) stopIds.push(id);
    }

    if (segments.length === 0 && stopIds.length < 2) continue; // nothing drawable

    stopIds.forEach((id) => usedStopIds.add(id));

    variants.push({
      osmId: el.id,
      name: lineDisplayName(tags),
      ref: tags.ref || '',
      type: routeType,
      colour: tags.colour || tags.color || '',
      operator: tags.operator || '',
      segments,
      stopIds,
    });
  }

  // 3) Merge variants into logical lines keyed by route type + ref
  //    (e.g. both directions of "Tram 1" become a single line).
  const lineMap = new Map();
  for (const v of variants) {
    const refKey = (v.ref || v.name).trim().toLowerCase();
    const key = `${v.type}|${refKey}`;
    let line = lineMap.get(key);
    if (!line) {
      line = {
        id: `osm-l-${v.type}-${slug(refKey)}`,
        osmIds: [],
        name: v.ref ? `${ROUTE_LABELS[v.type] || 'Route'} ${v.ref}` : v.name,
        ref: v.ref,
        type: v.type,
        color: DEFAULT_COLORS[v.type] || DEFAULT_COLORS.default,
        colorFromOsm: false,
        operator: v.operator,
        variants: [],
        segments: [],
        stopSequences: [],
        _wayRefs: new Set(),
      };
      lineMap.set(key, line);
    }
    line.osmIds.push(v.osmId);
    line.variants.push(v.name);
    if (!line.colorFromOsm && v.colour) {
      line.color = normalizeOsmColor(v.colour, v.type);
      line.colorFromOsm = true;
    }
    for (const seg of v.segments) {
      // Both directions usually share the same ways – draw each way once.
      if (seg.wayRef != null) {
        if (line._wayRefs.has(seg.wayRef)) continue;
        line._wayRefs.add(seg.wayRef);
      }
      line.segments.push(seg.coords);
    }
    if (v.stopIds.length >= 2) line.stopSequences.push(v.stopIds);
  }

  // Lines without an OSM colour get a distinct palette colour so they are
  // distinguishable on the schematic (sorted first so assignment is stable).
  const lines = [...lineMap.values()];
  lines.sort((a, b) =>
    (a.type + a.ref + a.name).localeCompare(b.type + b.ref + b.name, undefined, { numeric: true })
  );
  let paletteIndex = 0;
  for (const l of lines) {
    if (!l.colorFromOsm) {
      l.color = FALLBACK_PALETTE[paletteIndex % FALLBACK_PALETTE.length];
      paletteIndex++;
    }
    delete l._wayRefs;
    delete l.colorFromOsm;
  }

  // 4) Keep stops that are part of a route, or that are clearly stations/stops on their own.
  const stops = [];
  for (const node of nodeById.values()) {
    const t = node.tags;
    if (usedStopIds.has(node.id) || isTransitStop(t)) {
      stops.push(node);
    }
  }

  stops.sort((a, b) => a.name.localeCompare(b.name));

  return { stops, lines };
}

function isTransitStop(tags) {
  if (!tags) return false;
  if (/^(station|halt|tram_stop|stop)$/.test(tags.railway || '')) return true;
  if (tags.station === 'subway' || tags.station === 'light_rail') return true;
  if (
    tags.public_transport === 'station' ||
    tags.public_transport === 'stop_position' ||
    tags.public_transport === 'platform'
  ) return true;
  if (tags.highway === 'bus_stop' || tags.amenity === 'bus_station') return true;
  return false;
}

function routeTypeLabel(type) {
  return ROUTE_LABELS[type] || type;
}

function slug(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'line';
}

TMB.ROUTE_TYPES = ROUTE_TYPES;
TMB.fetchTransit = fetchTransit;
TMB.parseOverpass = parseOverpass;
TMB.routeTypeLabel = routeTypeLabel;
TMB.isTransitStop = isTransitStop;
})();
