var TMB = window.TMB || {};
(function () {
/**
 * schematic.js
 * Converts the combined OSM + user-drawn transit data into a "tube map" style
 * topological graph and renders it with D3.
 *
 * Pipeline:
 *   1. Cluster stops into stations (same name & close together → one node).
 *   2. Derive the ordered station sequence of every line
 *      (from OSM relation member order, or by snapping stops onto drawn polylines).
 *   3. Build graph edges between consecutive stations; record which lines use each edge.
 *   4. Layout from real positions: edge lengths follow geography, only stops that
 *      would sit on top of each other are pushed apart, and angles near 45° get
 *      a light nudge. Grid snap, when on, stays close to that position.
 *   5. Render SVG: parallel line bands with white gaps, tube-style station ticks
 *      and interchange rings, collision-free labels, hover highlighting.
 */

/* global d3 */

const STATION_MERGE_DISTANCE_M = 400; // stops with the same name within this radius merge
const USER_SNAP_DISTANCE_M = 90;      // stop ↔ drawn polyline tolerance
const OSM_SNAP_DISTANCE_M = 35;       // fallback for OSM lines without stop members
const LINE_WIDTH = 5;
const LINE_GAP = 1.5;                 // white gap between parallel lines
const MAX_BAND_WIDTH = 26;            // max total width of parallel strokes on a shared edge
const LABEL_FONT_SIZE = 11;
const TERMINAL_NAME_SIZE = 15;
const TERMINAL_PILL_FONT = 11;
const LABEL_FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
const INK = '#1b2a4a';

let svg = null;
let zoomBehavior = null;
let rootGroup = null;
let lastGraph = null;
let lastContainer = null;
let measureCtx = null;
let onFocusChange = null;
let onRecolorChange = null;
let onStationMove = null;
let chooserEl = null;
let moveStops = false;

/* ================================================================== */
/* Public API                                                          */
/* ================================================================== */

/**
 * Render (or re-render) the schematic view.
 * @param {HTMLElement} container
 * @param {{osm:{stops:[],lines:[]}, user:{stops:[],lines:[]}}} data
 * @param {{spacing?:number, gridSnap?:boolean, showLabels?:boolean}} [options]
 * @returns {{nodes:number, edges:number, lines:number}}
 */
function renderSchematic(container, data, options = {}) {
  const opts = { spacing: 70, gridSnap: true, showLabels: true, showLineLabels: true, ...options };
  const graph = buildGraph(data);
  lastContainer = container;
  lastGraph = graph;

  // Focus (selected line) persists across re-renders; owner (main.js) can sync it.
  focusedLine = options.focus != null && graph.lineById.has(options.focus) ? options.focus : null;
  onFocusChange = typeof options.onFocus === 'function' ? options.onFocus : null;
  onRecolorChange = typeof options.onRecolor === 'function' ? options.onRecolor : null;
  onStationMove = typeof options.onStationMove === 'function' ? options.onStationMove : null;

  const prevTransform = options.keepView && svg ? d3.zoomTransform(svg.node()) : null;

  destroySchematic(container);

  if (!graph.nodes.length) {
    return { nodes: 0, edges: 0, lines: 0 };
  }

  layoutGraph(graph, opts);
  applyManualPositions(graph, options.positions);
  draw(container, graph, opts);
  if (prevTransform) svg.call(zoomBehavior.transform, prevTransform);
  else fitSchematic(0);

  return { nodes: graph.nodes.length, edges: graph.edges.length, lines: graph.lines.length };
}

function setSchematicMoveMode(on) {
  moveStops = !!on;
  if (rootGroup) rootGroup.classed('move-stops', moveStops);
}

function destroySchematic(container) {
  const target = container || lastContainer;
  if (target) target.innerHTML = '';
  svg = null;
  rootGroup = null;
  zoomBehavior = null;
  chooserEl = null;
}

/**
 * Zoom/pan so the whole graph is visible.
 */
function fitSchematic(duration = 400) {
  if (!svg || !rootGroup || !lastGraph || !lastGraph.nodes.length) return;
  const { width, height } = svgSize();
  const pad = 36;
  // Include names and line numbers, not only the stop dots.
  const box = rootGroup.node().getBBox();
  const minX = box.x, maxX = box.x + box.width;
  const minY = box.y, maxY = box.y + box.height;
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const scale = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh, 2.5);
  const tx = width / 2 - scale * (minX + bw / 2);
  const ty = height / 2 - scale * (minY + bh / 2);
  const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
  if (duration > 0) {
    svg.transition().duration(duration).call(zoomBehavior.transform, t);
  } else {
    svg.call(zoomBehavior.transform, t);
  }
}

/**
 * Serialize the current SVG (standalone, with inline styles) for export.
 */
function getSchematicSvgMarkup() {
  if (!svg) return null;
  const clone = svg.node().cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const { width, height } = svgSize();
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // Exported file shows every placed label regardless of the current zoom.
  const root = clone.querySelector('.sch-root');
  if (root) root.setAttribute('class', 'sch-root');
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    .sch-casing, .sch-stroke, .sch-tick { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .sch-casing { stroke: #fff; }
    .sch-ring { fill: #fff; stroke: #1b2a4a; stroke-width: 2.6; }
    .sch-capsule { fill: #fff; stroke: #1b2a4a; stroke-width: 2; }
    .sch-orphan { fill: #fff; stroke: #8a94a6; stroke-width: 2; }
    .sch-hit { fill: none; stroke: none; }
    .sch-label { font-family: ${LABEL_FONT}; font-size: ${LABEL_FONT_SIZE}px; font-weight: 500; fill: ${INK}; paint-order: stroke; stroke: #fff; stroke-width: 3.5px; }
    .sch-label.interchange { font-weight: 700; }
    .sch-label.crowded { display: none; }
    .sch-terminal-pill { stroke: #fff; stroke-width: 1.5; }
    .sch-terminal-text { font-family: ${LABEL_FONT}; font-size: ${TERMINAL_PILL_FONT}px; font-weight: 700; fill: #fff; }
    .sch-terminal-name { font-family: ${LABEL_FONT}; font-size: ${TERMINAL_NAME_SIZE}px; font-weight: 700; fill: ${INK}; paint-order: stroke; stroke: #fff; stroke-width: 4px; }
    .sch-edgelabel-text { font-family: ${LABEL_FONT}; font-size: 12px; font-weight: 800; stroke: #fff; stroke-width: 3.5px; paint-order: stroke; }
  `;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#ffffff');
  clone.insertBefore(bg, style.nextSibling);
  return new XMLSerializer().serializeToString(clone);
}

/* ================================================================== */
/* 1–3. Graph construction                                             */
/* ================================================================== */

/**
 * Strip platform / bay numbers that some operators put in stop names
 * ("Marynin 01", "Marynin 02" → "Marynin") so both platforms become one station.
 */
function stationDisplayName(name) {
  return String(name || '')
    .replace(/\s+(0\d|\d{2})$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(name) {
  return stationDisplayName(name)
    .toLowerCase()
    .replace(/[„”"']/g, '');
}

/**
 * Cluster stops into stations.
 * @returns {{stations: Station[], stopToStation: Map<string, Station>}}
 */
function clusterStops(stops) {
  const byName = new Map();
  for (const s of stops) {
    const key = normalizeName(s.name) || `__${s.id}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s);
  }

  const stations = [];
  const stopToStation = new Map();
  let counter = 0;

  for (const group of byName.values()) {
    const clusters = []; // each: { lat, lng, members: [] }
    for (const s of group) {
      let target = null;
      for (const c of clusters) {
        if (haversine(c.lat, c.lng, s.lat, s.lng) <= STATION_MERGE_DISTANCE_M) {
          target = c;
          break;
        }
      }
      if (!target) {
        target = { lat: s.lat, lng: s.lng, members: [] };
        clusters.push(target);
      }
      target.members.push(s);
      // Running centroid
      const n = target.members.length;
      target.lat = target.members.reduce((a, m) => a + m.lat, 0) / n;
      target.lng = target.members.reduce((a, m) => a + m.lng, 0) / n;
    }

    for (const c of clusters) {
      const station = {
        id: `st-${counter++}`,
        name: stationDisplayName(c.members[0].name) || c.members[0].name,
        lat: c.lat,
        lng: c.lng,
        stopIds: c.members.map((m) => m.id),
        hasUser: c.members.some((m) => m.source === 'user'),
        lines: new Set(),
        edges: [],
      };
      stations.push(station);
      for (const m of c.members) stopToStation.set(m.id, station);
    }
  }

  return { stations, stopToStation };
}

/**
 * Ordered station sequences for a line (one per direction/variant).
 * OSM lines carry explicit stop sequences; user lines get their stops by snapping.
 */
function lineStationSequences(line, stopToStation, allStops) {
  let stopSeqs;
  if (Array.isArray(line.stopSequences) && line.stopSequences.length) {
    stopSeqs = line.stopSequences;
  } else if (Array.isArray(line.stopIds) && line.stopIds.length >= 2) {
    stopSeqs = [line.stopIds];
  } else {
    stopSeqs = [snapStopsToLine(line, allStops)];
  }

  return stopSeqs
    .map((stopSeq) => {
      const seq = [];
      for (const id of stopSeq) {
        const st = stopToStation.get(id);
        if (!st) continue;
        if (seq.length && seq[seq.length - 1] === st) continue;
        seq.push(st);
      }
      return seq;
    })
    .filter((seq) => seq.length >= 2);
}

/**
 * Find stops lying close to a polyline and order them along it.
 * Returns an array of stop ids.
 */
function snapStopsToLine(line, allStops) {
  const paths = line.segments ? line.segments : [line.coords];
  const flat = [];
  for (const p of paths) for (const c of p) flat.push(c);
  if (flat.length < 2) return [];

  const threshold = line.source === 'user' ? USER_SNAP_DISTANCE_M : OSM_SNAP_DISTANCE_M;
  const refLat = flat[0][0];
  const toXY = (lat, lng) => [
    lng * 111320 * Math.cos((refLat * Math.PI) / 180),
    lat * 110540,
  ];
  const pts = flat.map(([lat, lng]) => toXY(lat, lng));

  // cumulative lengths
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }

  const hits = [];
  for (const s of allStops) {
    const [px, py] = toXY(s.lat, s.lng);
    let best = { dist: Infinity, t: 0 };
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay;
      const segLen2 = dx * dx + dy * dy || 1e-9;
      let u = ((px - ax) * dx + (py - ay) * dy) / segLen2;
      u = Math.max(0, Math.min(1, u));
      const cx = ax + u * dx, cy = ay + u * dy;
      const d = Math.hypot(px - cx, py - cy);
      if (d < best.dist) best = { dist: d, t: cum[i - 1] + u * Math.sqrt(segLen2) };
    }
    if (best.dist <= threshold) hits.push({ id: s.id, t: best.t });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits.map((h) => h.id);
}

function buildGraph(data) {
  const osm = data.osm || { stops: [], lines: [] };
  const user = data.user || { stops: [], lines: [] };

  const allStops = [
    ...osm.stops.map((s) => ({ ...s, source: 'osm' })),
    ...user.stops.map((s) => ({ ...s, source: 'user' })),
  ];
  const allLines = [
    ...osm.lines.map((l) => ({ ...l, source: 'osm' })),
    ...user.lines.map((l) => ({ ...l, source: 'user' })),
  ];

  const { stations, stopToStation } = clusterStops(allStops);

  const edgeMap = new Map();
  const lines = [];

  for (const line of allLines) {
    const seqs = lineStationSequences(line, stopToStation, allStops);
    if (!seqs.length) {
      // Still show user lines in the legend even if they have no stops yet.
      if (line.source === 'user') lines.push({ ...line, stationIds: [], edgeCount: 0 });
      continue;
    }
    let edgeCount = 0;
    const stationIds = new Set();
    for (const seq of seqs) {
      // Endpoints of this run: the line starts / terminates here.
      const first = seq[0], last = seq[seq.length - 1];
      (first.terminalOf || (first.terminalOf = new Set())).add(line.id);
      (last.terminalOf || (last.terminalOf = new Set())).add(line.id);

      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1], b = seq[i];
        if (a === b) continue;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        let edge = edgeMap.get(key);
        if (!edge) {
          edge = {
            id: key,
            source: a.id < b.id ? a : b,
            target: a.id < b.id ? b : a,
            lines: [],
            lineDir: new Map(), // lineId -> { fwd, rev } relative to source→target
          };
          edgeMap.set(key, edge);
          a.edges.push(edge);
          b.edges.push(edge);
        }
        if (!edge.lines.includes(line.id)) {
          edge.lines.push(line.id);
          edgeCount++;
        }
        // Record travel direction: a→b forward if a is the canonical source.
        let dd = edge.lineDir.get(line.id);
        if (!dd) { dd = { fwd: false, rev: false }; edge.lineDir.set(line.id, dd); }
        if (a === edge.source) dd.fwd = true; else dd.rev = true;

        a.lines.add(line.id);
        b.lines.add(line.id);
        stationIds.add(a.id);
        stationIds.add(b.id);
      }
    }
    lines.push({ ...line, stationIds: [...stationIds], edgeCount });
  }

  const edges = [...edgeMap.values()];
  // With routes, drop stops that no line uses. Stops-only loads have no edges,
  // so every clustered stop stays on the schematic.
  const nodes = stations.filter((s) => s.edges.length > 0 || s.hasUser || edges.length === 0);
  lines.sort(compareLines);
  const lineById = new Map(lines.map((l) => [l.id, l]));

  // Lowest line number stays in the same lane along a corridor (1, then 21, then 24).
  const lineOrder = new Map(lines.map((l, i) => [l.id, i]));
  for (const e of edges) e.lines.sort((a, b) => lineOrder.get(a) - lineOrder.get(b));

  return { nodes, edges, lines, lineById };
}

/* ================================================================== */
/* 4. Layout                                                           */
/* ================================================================== */

function mercator(lat, lng) {
  const x = (lng * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const y = -Math.log(Math.tan(Math.PI / 4 + phi / 2));
  return [x, y];
}

function layoutGraph(graph, opts) {
  const { nodes, edges } = graph;
  const spacing = opts.spacing;

  // Initial geographic positions (Mercator) scaled so the median edge length ≈ spacing.
  for (const n of nodes) {
    const [x, y] = mercator(n.lat, n.lng);
    n.px = x;
    n.py = y;
  }
  let scale = 1;
  if (edges.length) {
    const lens = edges
      .map((e) => Math.hypot(e.target.px - e.source.px, e.target.py - e.source.py))
      .filter((l) => l > 0)
      .sort((a, b) => a - b);
    const median = lens.length ? lens[Math.floor(lens.length / 2)] : 1;
    scale = spacing / (median || 1);
  } else {
    // Stops with no lines: scale from typical nearest-neighbor distance so a
    // cluster is not crushed into one point, then cap the whole span.
    const nn = nearestNeighborMedian(nodes);
    scale = spacing / (nn || 1);
    const xs = nodes.map((n) => n.px), ys = nodes.map((n) => n.py);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-9);
    const maxSpan = spacing * Math.max(6, Math.ceil(Math.sqrt(nodes.length)) * 3.2);
    if (span * scale > maxSpan) scale = maxSpan / span;
  }
  const cx = d3.mean(nodes, (n) => n.px);
  const cy = d3.mean(nodes, (n) => n.py);
  for (const n of nodes) {
    n.gx = (n.px - cx) * scale; // geographic anchor
    n.gy = (n.py - cy) * scale;
    n.x = n.gx;
    n.y = n.gy;
    n.vx = 0;
    n.vy = 0;
  }

  const grid = Math.max(10, Math.round(spacing / 4));
  // Floor so two markers don't share a point. Longer real gaps stay longer.
  const minSep = Math.max(40, spacing * 0.55);

  if (!edges.length) {
    relaxSpacing(nodes, [], minSep);
    if (opts.gridSnap) snapToGrid(nodes, grid, minSep);
    relaxSpacing(nodes, [], minSep);
    for (const n of nodes) {
      n.x = round1(n.x);
      n.y = round1(n.y);
    }
    return;
  }

  const links = edges.map((e) => {
    const geo = Math.hypot(e.target.gx - e.source.gx, e.target.gy - e.source.gy);
    const dist = Math.max(minSep, Math.min(geo > 0 ? geo : spacing, spacing * 12));
    e.targetDist = dist;
    return { source: e.source, target: e.target, edge: e, dist };
  });

  // Lengths come from the map. Geographic pull stays light so a stop that has
  // to move out of another's way does not drag the rest of the line with it.
  const simulation = d3
    .forceSimulation(nodes)
    .force('link', d3.forceLink(links).distance((l) => l.dist).strength(0.85))
    .force('geoX', d3.forceX((d) => d.gx).strength(0.06))
    .force('geoY', d3.forceY((d) => d.gy).strength(0.06))
    .force('octilinear', octilinearForce(links, 0.18))
    .force('straighten', straightenForce(nodes, 0.28))
    .alphaDecay(0.03)
    .velocityDecay(0.45)
    .stop();

  simulation.tick(220);
  separateThenRestore(nodes, edges, links, minSep);

  if (opts.gridSnap) snapToGrid(nodes, grid, minSep);
  separateThenRestore(nodes, edges, links, minSep);

  for (const n of nodes) {
    n.x = round1(n.x);
    n.y = round1(n.y);
  }
}

/**
 * Keep stops from stacking, then stretch any edge that separation shortened
 * back toward its geographic length.
 */
function separateThenRestore(nodes, edges, links, minSep) {
  relaxSpacing(nodes, edges, minSep);
  for (let iter = 0; iter < 14; iter++) {
    for (const l of links) {
      const a = l.source;
      const b = l.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d >= l.dist - 0.6) continue;
      const ux = dx / d;
      const uy = dy / d;
      const need = (l.dist - d) * 0.5;
      a.x -= ux * need / 2;
      a.y -= uy * need / 2;
      b.x += ux * need / 2;
      b.y += uy * need / 2;
    }
    if (iter % 4 === 3) relaxSpacing(nodes, edges, minSep);
  }
  relaxSpacing(nodes, edges, minSep);
}

/**
 * Custom d3 force: rotate every link toward the nearest multiple of 45°.
 */
function octilinearForce(links, strength) {
  const STEP = Math.PI / 4;
  return function force(alpha) {
    for (const l of links) {
      const s = l.source, t = l.target;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) continue;
      const angle = Math.atan2(dy, dx);
      const snapped = Math.round(angle / STEP) * STEP;
      let delta = snapped - angle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      // Leave angles that are nowhere near 45° alone — those carry the real shape.
      if (Math.abs(delta) > Math.PI / 6) continue;
      const tx = s.x + Math.cos(snapped) * dist;
      const ty = s.y + Math.sin(snapped) * dist;
      const fx = (tx - t.x) * strength * alpha;
      const fy = (ty - t.y) * strength * alpha;
      t.vx += fx / 2;
      t.vy += fy / 2;
      s.vx -= fx / 2;
      s.vy -= fy / 2;
    }
  };
}

/**
 * Custom d3 force: pull pass-through stations (exactly two neighbours) toward
 * the midpoint of their neighbours, removing zig-zags along a line.
 */
function straightenForce(nodes, strength) {
  const through = nodes.filter((n) => n.edges.length === 2);
  return function force(alpha) {
    for (const n of through) {
      const [e1, e2] = n.edges;
      const a = e1.source === n ? e1.target : e1.source;
      const b = e2.source === n ? e2.target : e2.source;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      n.vx += (mx - n.x) * strength * alpha;
      n.vy += (my - n.y) * strength * alpha;
    }
  };
}

/**
 * Snap nodes to a square grid, resolving collisions by searching nearby cells.
 */
/**
 * Snap nodes to a square grid, searching only a few cells so a stop stays
 * near its geographic position. `minDist` rejects a cell that another stop
 * already occupies.
 */
function snapToGrid(nodes, g, minDist) {
  const minD = Math.max(minDist || 0, g * 0.99);
  const bins = new Map();
  const bkey = (x, y) => `${Math.floor(x / minD)},${Math.floor(y / minD)}`;
  const addPlaced = (x, y) => {
    const k = bkey(x, y);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(x, y);
  };
  const blocked = (x, y) => {
    const cx = Math.floor(x / minD);
    const cy = Math.floor(y / minD);
    const limit = (minD - 0.01) * (minD - 0.01);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const arr = bins.get(`${ix},${iy}`);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i += 2) {
          const dx = arr[i] - x, dy = arr[i + 1] - y;
          if (dx * dx + dy * dy < limit) return true;
        }
      }
    }
    return false;
  };

  // Snap the most-connected stations first so interchanges keep their place.
  const ordered = [...nodes].sort((a, b) => b.edges.length - a.edges.length || b.lines.size - a.lines.size);
  const maxR = 6;

  for (const n of ordered) {
    const cx0 = Math.round(n.x / g);
    const cy0 = Math.round(n.y / g);
    let placed = false;
    for (let r = 0; r <= maxR && !placed; r++) {
      const candidates = [];
      if (r === 0) candidates.push([cx0, cy0]);
      else {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            candidates.push([cx0 + dx, cy0 + dy]);
          }
        }
        candidates.sort(
          (a, b) =>
            (a[0] * g - n.x) ** 2 + (a[1] * g - n.y) ** 2 -
            ((b[0] * g - n.x) ** 2 + (b[1] * g - n.y) ** 2)
        );
      }
      for (const [cx, cy] of candidates) {
        const x = cx * g, y = cy * g;
        if (!blocked(x, y)) {
          addPlaced(x, y);
          n.x = x;
          n.y = y;
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      n.x = cx0 * g;
      n.y = cy0 * g;
      addPlaced(n.x, n.y);
    }
  }
}

/**
 * Separate stations closer than `minDist`. Linked stops are pushed along
 * their edge; any other overlapping pair is pushed apart too, so a tight
 * geographic cluster spreads out instead of drawing on top of itself.
 */
function relaxSpacing(nodes, edges, minDist) {
  if (nodes.length < 2 || minDist <= 0) return;
  for (let iter = 0; iter < 28; iter++) {
    for (const e of edges) pushApart(e.source, e.target, minDist);
    const bins = new Map();
    const key = (x, y) => `${Math.floor(x / minDist)},${Math.floor(y / minDist)}`;
    for (const n of nodes) {
      const k = key(n.x, n.y);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(n);
    }
    const seen = new Set();
    for (const n of nodes) {
      const cx = Math.floor(n.x / minDist);
      const cy = Math.floor(n.y / minDist);
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iy = cy - 1; iy <= cy + 1; iy++) {
          const arr = bins.get(`${ix},${iy}`);
          if (!arr) continue;
          for (const o of arr) {
            if (o === n) continue;
            const id = n.id < o.id ? n.id + '|' + o.id : o.id + '|' + n.id;
            if (seen.has(id)) continue;
            seen.add(id);
            pushApart(n, o, minDist);
          }
        }
      }
    }
  }
}

function pushApart(a, b, minDist) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  if (d >= minDist) return;
  if (d < 0.01) {
    const h = Math.abs(hashId(a.id) % 7) + 1;
    dx = h % 2 ? 1 : -1;
    dy = h % 3 === 0 ? 0.65 : -0.4;
    d = Math.hypot(dx, dy);
  }
  const push = ((minDist - d) / 2) * 0.85;
  const ux = dx / d, uy = dy / d;
  a.x -= ux * push;
  a.y -= uy * push;
  b.x += ux * push;
  b.y += uy * push;
}

function hashId(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function nearestNeighborMedian(nodes) {
  if (nodes.length < 2) return 1;
  const dists = [];
  for (let i = 0; i < nodes.length; i++) {
    let best = Infinity;
    const a = nodes[i];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(a.px - nodes[j].px, a.py - nodes[j].py);
      if (d > 1e-12 && d < best) best = d;
    }
    if (best < Infinity) dists.push(best);
  }
  dists.sort((a, b) => a - b);
  return dists.length ? dists[Math.floor(dists.length / 2)] || 1 : 1;
}

function stationKey(n) {
  return `${normalizeName(n.name)}@${Number(n.lat).toFixed(3)},${Number(n.lng).toFixed(3)}`;
}

function applyManualPositions(graph, positions) {
  if (!positions) return;
  for (const n of graph.nodes) {
    const p = positions[stationKey(n)];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      n.x = p.x;
      n.y = p.y;
    }
  }
}

function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function outwardOf(n) {
  let sx = 0, sy = 0, count = 0;
  for (const e of n.edges) {
    const terminating = n.terminalOf && [...n.terminalOf].some((id) => e.lines.includes(id));
    if (!terminating && n.edges.length > 1) continue;
    const o = e.source === n ? e.target : e.source;
    const dx = o.x - n.x, dy = o.y - n.y;
    const len = Math.hypot(dx, dy) || 1;
    sx += dx / len; sy += dy / len;
    count++;
  }
  if (!count) return [0, -1];
  let ox = -sx, oy = -sy;
  const m = Math.hypot(ox, oy);
  if (m < 0.15) return [0, -1];
  return [ox / m, oy / m];
}

/* ================================================================== */
/* 5. Rendering                                                        */
/* ================================================================== */

function draw(container, graph, opts) {
  const { nodes, edges, lineById } = graph;

  svg = d3
    .select(container)
    .append('svg')
    .attr('class', 'schematic-svg')
    .attr('role', 'img')
    .attr('aria-label', 'Schematic transit map');

  rootGroup = svg.append('g').attr('class', 'sch-root').classed('move-stops', moveStops);

  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.15, 8])
    .on('zoom', (event) => {
      const k = event.transform.k;
      rootGroup
        .attr('transform', event.transform)
        // Declutter: only interchange names when zoomed out, none when very far out.
        .classed('zoomed-out', k < 0.55)
        .classed('zoomed-far', k < 0.3);
    });
  svg.call(zoomBehavior).on('dblclick.zoom', null);
  svg.on('click', (event) => {
    if (event.target === svg.node()) { setFocusLine(null); closeChooser(); }
  });

  const edgeLayer = rootGroup.append('g').attr('class', 'sch-edges');
  const arrowLayer = rootGroup.append('g').attr('class', 'sch-arrows');
  const edgeLabelLayer = rootGroup.append('g').attr('class', 'sch-edgelabels');
  const stationLayer = rootGroup.append('g').attr('class', 'sch-stations');
  const terminalLayer = rootGroup.append('g').attr('class', 'sch-terminals');
  const labelLayer = rootGroup.append('g').attr('class', 'sch-labels');

  // --- Edge geometry: lanes per line, offset along a canonical normal ---
  const strokes = [];
  const arrows = [];
  for (const e of edges) {
    const n = e.lines.length;
    const dx = e.target.x - e.source.x;
    const dy = e.target.y - e.source.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len, ny = dx / len;
    // Same normal direction regardless of edge orientation → lanes stay consistent.
    if (ny < -1e-6 || (Math.abs(ny) <= 1e-6 && nx < 0)) { nx = -nx; ny = -ny; }
    const step = n > 1
      ? Math.min(LINE_WIDTH + LINE_GAP, (MAX_BAND_WIDTH - LINE_WIDTH) / (n - 1))
      : 0;
    e.bandWidth = LINE_WIDTH + step * (n - 1);
    e.dir = [dx / len, dy / len];
    e.normal = [nx, ny];
    e.len = len;
    e.lanes = [];
    e.lines.forEach((lineId, i) => {
      const offset = (i - (n - 1) / 2) * step;
      const line = lineById.get(lineId) || {};
      const sx = e.source.x + nx * offset, sy = e.source.y + ny * offset;
      const tx = e.target.x + nx * offset, ty = e.target.y + ny * offset;
      e.lanes.push({ lineId, sx, sy, tx, ty });
      strokes.push({
        key: `${e.id}#${lineId}`, lineId, edge: e,
        x1: sx, y1: sy, x2: tx, y2: ty,
        ox1: sx - e.source.x, oy1: sy - e.source.y,
        ox2: tx - e.target.x, oy2: ty - e.target.y,
        color: line.color || '#555',
        name: line.name || lineId,
        width: Math.min(LINE_WIDTH, step > 0 ? step : LINE_WIDTH),
      });
      // One-directional run: draw an arrow in the travel direction.
      const dd = e.lineDir.get(lineId);
      if (dd && (dd.fwd ? 1 : 0) + (dd.rev ? 1 : 0) === 1 && len > 26) {
        const fwd = dd.fwd; // source→target
        const mx = (sx + tx) / 2, my = (sy + ty) / 2;
        const ang = (Math.atan2(fwd ? dy : -dy, fwd ? dx : -dx) * 180) / Math.PI;
        arrows.push({ key: `${e.id}#${lineId}#a`, lineId, x: mx, y: my, angle: ang, color: line.color || '#555' });
      }
    });
  }

  // White casing first (thin gaps between parallel lanes), then coloured strokes.
  edgeLayer
    .selectAll('line.sch-casing')
    .data(strokes, (d) => d.key)
    .join('line')
    .attr('class', 'sch-casing')
    .attr('data-line', (d) => d.lineId)
    .attr('x1', (d) => d.x1).attr('y1', (d) => d.y1)
    .attr('x2', (d) => d.x2).attr('y2', (d) => d.y2)
    .attr('stroke-width', (d) => d.width + LINE_GAP * 1.5);

  edgeLayer
    .selectAll('line.sch-stroke')
    .data(strokes, (d) => d.key)
    .join('line')
    .attr('class', 'sch-stroke')
    .attr('data-line', (d) => d.lineId)
    .attr('x1', (d) => d.x1).attr('y1', (d) => d.y1)
    .attr('x2', (d) => d.x2).attr('y2', (d) => d.y2)
    .attr('stroke', (d) => d.color)
    .attr('stroke-width', (d) => Math.max(1.5, d.width - (d.width < LINE_WIDTH ? 0.6 : 0)))
    .on('click', (event, d) => {
      event.stopPropagation();
      // Multi-line edge → let the user pick which line to preview.
      pickLine(d.edge.lines, event);
    })
    .append('title')
    .text((d) => d.name);

  // Direction arrows for one-way segments.
  arrowLayer
    .selectAll('path.sch-arrow')
    .data(arrows, (d) => d.key)
    .join('path')
    .attr('class', 'sch-arrow')
    .attr('data-line', (d) => d.lineId)
    .attr('d', 'M-3.2,-3 L3.4,0 L-3.2,3 Z')
    .attr('fill', (d) => d.color)
    .attr('transform', (d) => `translate(${d.x},${d.y}) rotate(${d.angle})`);

  // --- Station geometry (band width & main direction at each station) ---
  for (const n of nodes) {
    n.band = n.edges.length ? Math.max(...n.edges.map((e) => e.bandWidth)) : LINE_WIDTH;
    let sx = 0, sy = 0;
    for (const e of n.edges) {
      // Fold directions so opposite edges reinforce instead of cancelling.
      let [ux, uy] = e.dir;
      if (ux < 0 || (ux === 0 && uy < 0)) { ux = -ux; uy = -uy; }
      if (sx * ux + sy * uy < 0) { ux = -ux; uy = -uy; }
      sx += ux; sy += uy;
    }
    const m = Math.hypot(sx, sy) || 1;
    n.axis = n.edges.length ? [sx / m, sy / m] : [1, 0];
    n.kind =
      n.lines.size === 0 ? 'orphan'
        : n.lines.size > 1 && (n.edges.length > 2 || hasLineChange(n)) ? 'interchange'
          : n.lines.size > 1 ? 'shared'
            : 'single';
  }

  let edgeLabelItems = [];
  const placedTerminalBoxes = [];
  for (const n of nodes) {
    n.terminalLayout = opts.showLineLabels ? layoutTerminal(n, lineById, opts.showLabels, edges, nodes, placedTerminalBoxes) : null;
    if (n.terminalLayout && n.terminalLayout.blockBox) placedTerminalBoxes.push(n.terminalLayout.blockBox);
  }
  if (opts.showLineLabels) edgeLabelItems = planEdgeLabels(edges, nodes, lineById);

  // Names are placed after line numbers so every stop stays visible and its
  // label can sit on the route without covering a line number.
  if (opts.showLabels) {
    const numberBoxes = numberObstacles(nodes, edgeLabelItems);
    const nameBoxes = placeTerminalNames(nodes, numberBoxes);
    placeLabels(nodes, numberBoxes, nameBoxes);
  }

  // --- Stations ---
  const stationSel = stationLayer
    .selectAll('g.sch-station')
    .data(nodes, (d) => d.id)
    .join('g')
    .attr('class', (d) => `sch-station ${d.kind}`)
    .attr('data-lines', (d) => [...d.lines].join(' '))
    .attr('transform', (d) => `translate(${d.x},${d.y})`)
    .on('mouseenter', function (event, d) {
      d3.select(this).raise();
      labelLayer.selectAll('text').filter((t) => t === d).classed('hovered', true);
    })
    .on('mouseleave', (event, d) => {
      labelLayer.selectAll('text').filter((t) => t === d).classed('hovered', false);
    })
    .on('click', (event, d) => {
      if (!d.lines.size) return;
      event.stopPropagation();
      pickLine([...d.lines], event);
    });

  stationSel.each(function (d) {
    const g = d3.select(this);
    const [ax, ay] = d.axis;
    const [px, py] = [-ay, ax]; // perpendicular to the line direction
    const angle = (Math.atan2(ay, ax) * 180) / Math.PI;

    if (d.kind === 'interchange') {
      const r = Math.max(5.5, d.band / 2 + 2.5);
      g.append('circle').attr('class', 'sch-ring').attr('r', r)
        .attr('fill', '#fff').attr('stroke', '#1b2a4a').attr('stroke-width', 2.6);
    } else if (d.kind === 'shared') {
      // Capsule across the whole band (several lines, no change of route).
      const len = d.band + 6;
      g.append('rect')
        .attr('class', 'sch-capsule')
        .attr('x', -3.5).attr('y', -len / 2)
        .attr('width', 7).attr('height', len)
        .attr('rx', 3.5)
        .attr('fill', '#fff').attr('stroke', '#1b2a4a').attr('stroke-width', 2)
        .attr('transform', `rotate(${angle})`);
    } else if (d.kind === 'single') {
      const color = (lineById.get([...d.lines][0]) || {}).color || INK;
      const terminal = d.edges.length === 1;
      // Tick on the label side (London style); terminals get a full cross-bar.
      let sign = 1;
      if (d.label && d.label.dir) sign = d.label.dir[0] * px + d.label.dir[1] * py >= 0 ? 1 : -1;
      const outer = d.band / 2 + 4;
      const inner = terminal ? -outer : 0;
      g.append('line')
        .attr('class', 'sch-tick')
        .attr('x1', px * sign * inner)
        .attr('y1', py * sign * inner)
        .attr('x2', px * sign * outer)
        .attr('y2', py * sign * outer)
        .attr('stroke', color)
        .attr('stroke-width', LINE_WIDTH - 1);
    } else {
      g.append('circle').attr('class', 'sch-orphan').attr('r', 4.5)
        .attr('fill', '#fff').attr('stroke', '#8a94a6').attr('stroke-width', 2);
    }
    // Generous invisible hit area for hovering and dragging.
    g.append('circle').attr('class', 'sch-hit').attr('r', Math.max(10, d.band / 2 + 6))
      .attr('fill', 'none').attr('stroke', 'none');
  });

  stationSel.call(d3.drag()
    .filter((event) => moveStops && !event.button)
    .on('start', (event) => {
      if (event.sourceEvent) event.sourceEvent.stopPropagation();
    })
    .on('drag', function (event, d) {
      const [x, y] = d3.pointer(event, rootGroup.node());
      d.x = x;
      d.y = y;
      d3.select(this).attr('transform', `translate(${x},${y})`);
      edgeLayer.selectAll('line').each(function (s) {
        if (!s || !s.edge || (s.edge.source !== d && s.edge.target !== d)) return;
        d3.select(this)
          .attr('x1', s.edge.source.x + s.ox1).attr('y1', s.edge.source.y + s.oy1)
          .attr('x2', s.edge.target.x + s.ox2).attr('y2', s.edge.target.y + s.oy2);
      });
      if (d.label) {
        labelLayer.selectAll('text').filter((t) => t === d)
          .attr('x', d.x + d.label.dx).attr('y', d.y + d.label.dy);
      }
    })
    .on('end', (event, d) => {
      if (onStationMove) onStationMove(stationKey(d), d.x, d.y);
    }));

  stationSel.append('title').text((d) => {
    const lines = [...d.lines].map((id) => (lineById.get(id) || {}).name || id);
    return lines.length ? `${d.name}\n${lines.join(', ')}` : d.name;
  });

  // --- Label DOM ---
  if (opts.showLabels) {
    labelLayer
      .selectAll('text')
      .data(nodes.filter((n) => n.label && !(n.terminalLayout && n.terminalLayout.name)), (d) => d.id)
      .join('text')
      .attr('class', (d) => {
        const cls = ['sch-label'];
        if (d.kind === 'interchange') cls.push('interchange');
        return cls.join(' ');
      })
      .attr('data-lines', (d) => [...d.lines].join(' '))
      .attr('x', (d) => d.x + d.label.dx)
      .attr('y', (d) => d.y + d.label.dy)
      .attr('font-size', (d) => d.label.size || LABEL_FONT_SIZE)
      .attr('text-anchor', (d) => d.label.anchor)
      .attr('dominant-baseline', 'central')
      .text((d) => d.name);
  }

  // --- Terminal markers: which line(s) end their run at each terminus ---
  if (opts.showLineLabels) renderTerminals(terminalLayer, nodes);

  // --- Line refs along each segment (repeated on long segments) ---
  if (opts.showLineLabels) renderEdgeLabels(edgeLabelLayer, edgeLabelItems);

  renderLegend(graph);
  applyHighlight();
}

/* ------------------------------------------------------------------ */
/* Terminal markers + along-segment line labels                        */
/* ------------------------------------------------------------------ */

function lineShort(line) {
  if (!line) return '?';
  if (line.ref && String(line.ref).trim()) return String(line.ref).trim();
  const name = String(line.name || '').trim();
  const m = name.match(/\b([A-Z]?\d+[A-Za-z]?)\b/); // e.g. "Tram 17" → "17", "Metro M1" → "M1"
  return m ? m[1] : name.slice(0, 6);
}

/** Ascending line numbers: 1, 9, 21, 24 — not insertion order. */
function compareLines(a, b) {
  const as = lineShort(a);
  const bs = lineShort(b);
  const c = as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' });
  if (c) return c;
  return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function pillBox(p, pad = 2) {
  return {
    type: 'num',
    x1: p.x - p.w / 2 - pad,
    y1: p.y - p.h / 2 - pad,
    x2: p.x + p.w / 2 + pad,
    y2: p.y + p.h / 2 + pad,
  };
}

function boxesOverlap(a, b, pad = 0) {
  return a.x1 - pad < b.x2 && a.x2 + pad > b.x1 && a.y1 - pad < b.y2 && a.y2 + pad > b.y1;
}

function pointHitsBox(x, y, box, pad) {
  const cx = Math.max(box.x1, Math.min(x, box.x2));
  const cy = Math.max(box.y1, Math.min(y, box.y2));
  return (cx - x) ** 2 + (cy - y) ** 2 < pad * pad;
}

function terminalRefs(n, lineById, font) {
  return [...n.terminalOf].map((id) => {
    const line = lineById.get(id);
    const text = lineShort(line);
    return {
      id,
      line,
      text,
      color: (line || {}).color || '#555',
      w: Math.max(font + 6, textWidth(text, true, font) + 8),
    };
  }).sort((a, b) => compareLines(a.line, b.line));
}

// ── replacement for layoutTerminalPills ──────────────────────────────────────
// Now computes the combined NAME + PILLS block as a single unit.
// Returns { pills, name, blockBox } where:
//   pills  – array of pill descriptors (x,y are absolute SVG coords)
//   name   – { x, y, text } or null
//   blockBox – { x1,y1,x2,y2 } bounding box of the whole block
/**
 * Layout the terminal block:
 *   [Nazwa końcówki]
 *   [pill 1] [pill 2] ...
 *
 * Places the block strictly outside all connected edges (tracks), stations, and other terminal blocks.
 * Unified format and font size across ALL terminal stations (dead-ends and pass-through termini).
 */
function layoutTerminal(n, lineById, showLabels, edges, allNodes, placedBoxes) {
  if (!n.terminalOf || !n.terminalOf.size) return null;

  const refs = terminalRefs(n, lineById, TERMINAL_PILL_FONT);
  if (!refs.length) return null;

  const font = TERMINAL_PILL_FONT;
  const H = font + 7;                 // pill height
  const GAP = 3.5;                    // horizontal gap between pills
  const VGAP = 4.5;                   // vertical gap between name and pills
  const bandR = (n.band || LINE_WIDTH) / 2;

  // Name is shown for ALL stations where a line terminates if labels are enabled
  const nameText = showLabels !== false ? n.name : null;
  const nameW = nameText ? textWidth(nameText, true, TERMINAL_NAME_SIZE) + 4 : 0;
  const nameH = nameText ? TERMINAL_NAME_SIZE + 4 : 0;

  // Pill row width
  const pillRowW = refs.reduce((s, r) => s + r.w, 0) + GAP * Math.max(0, refs.length - 1);

  // Block dimensions
  const blockW = Math.max(nameW, pillRowW) + 8;
  const blockH = (nameText ? nameH + VGAP : 0) + H + 4;
  const hw = blockW / 2;
  const hh = blockH / 2;

  // Generate candidate placement directions
  const edgeDirs = n.edges.map((e) => {
    const o = e.source === n ? e.target : e.source;
    const dx = o.x - n.x;
    const dy = o.y - n.y;
    const len = Math.hypot(dx, dy) || 1;
    return { dx: dx / len, dy: dy / len, ang: Math.atan2(dy, dx), edge: e, neighbor: o };
  });

  const deadEnd = n.edges.length <= 1;
  const [ox0, oy0] = outwardOf(n);
  const primaryAng = Math.atan2(oy0, ox0);

  // Candidate angles
  const candidateAngles = [];
  if (deadEnd) {
    const offsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, Math.PI];
    for (const off of offsets) {
      candidateAngles.push(primaryAng + off);
    }
  } else {
    for (let i = 0; i < 16; i++) {
      candidateAngles.push((i * Math.PI) / 8);
    }
    if (edgeDirs.length >= 2) {
      const sortedAngles = edgeDirs.map((ed) => ed.ang).sort((a, b) => a - b);
      for (let i = 0; i < sortedAngles.length; i++) {
        const a1 = sortedAngles[i];
        const a2 = i + 1 < sortedAngles.length ? sortedAngles[i + 1] : sortedAngles[0] + 2 * Math.PI;
        candidateAngles.push((a1 + a2) / 2);
      }
    }
  }

  // Sort candidate angles:
  // Dead ends: prefer continuing the track (closest to primaryAng)
  // Multi-edge: prefer angles furthest from all connected tracks
  candidateAngles.sort((angA, angB) => {
    if (deadEnd) {
      return Math.abs(angleDiff(angA, primaryAng)) - Math.abs(angleDiff(angB, primaryAng));
    }
    const minDiffA = Math.min(...edgeDirs.map((ed) => Math.abs(angleDiff(angA, ed.ang))));
    const minDiffB = Math.min(...edgeDirs.map((ed) => Math.abs(angleDiff(angB, ed.ang))));
    return minDiffB - minDiffA;
  });

  // Obstacles for line collision checks
  const connectedEdgeSegments = edgeDirs.map((ed) => ({
    x1: n.x, y1: n.y,
    x2: ed.neighbor.x, y2: ed.neighbor.y,
    pad: (ed.edge.bandWidth || LINE_WIDTH) / 2 + 3.5,
  }));

  const nearbyEdges = (edges || []).filter((e) => {
    if (n.edges.includes(e)) return false;
    const minX = Math.min(e.source.x, e.target.x) - 40;
    const maxX = Math.max(e.source.x, e.target.x) + 40;
    const minY = Math.min(e.source.y, e.target.y) - 40;
    const maxY = Math.max(e.source.y, e.target.y) + 40;
    return n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY;
  }).map((e) => ({
    x1: e.source.x, y1: e.source.y,
    x2: e.target.x, y2: e.target.y,
    pad: (e.bandWidth || LINE_WIDTH) / 2 + 3.5,
  }));

  const nearbyStations = (allNodes || []).filter((o) => o !== n && Math.hypot(o.x - n.x, o.y - n.y) < 180);

  const marginSteps = [6, 14, 24, 36, 50];
  let best = null;

  for (const margin of marginSteps) {
    for (const ang of candidateAngles) {
      const cdx = Math.cos(ang);
      const cdy = Math.sin(ang);

      const boxExtent = Math.abs(cdx) * hw + Math.abs(cdy) * hh;
      const dist = bandR + boxExtent + margin;
      const cx = n.x + cdx * dist;
      const cy = n.y + cdy * dist;

      const candBox = {
        x1: cx - hw,
        y1: cy - hh,
        x2: cx + hw,
        y2: cy + hh,
      };

      let penalty = 0;

      // Connected edge collisions (CRITICAL: must not touch track)
      for (const seg of connectedEdgeSegments) {
        if (segmentHitsBox(seg, candBox)) penalty += 10000;
      }

      // Nearby edge collisions
      for (const seg of nearbyEdges) {
        if (segmentHitsBox(seg, candBox)) penalty += 8000;
      }

      // Self station collision
      if (pointHitsBox(n.x, n.y, candBox, bandR + 3)) penalty += 5000;

      // Other stations collision
      for (const st of nearbyStations) {
        if (pointHitsBox(st.x, st.y, candBox, 14)) penalty += 4000;
      }

      // Previously placed terminal blocks
      if (placedBoxes && placedBoxes.length) {
        for (const pb of placedBoxes) {
          if (boxesOverlap(candBox, pb, 4)) penalty += 5000;
        }
      }

      penalty += margin * 5;
      if (deadEnd) {
        penalty += Math.abs(angleDiff(ang, primaryAng)) * 25;
      }

      if (!best || penalty < best.penalty) {
        best = { cx, cy, candBox, penalty };
      }

      if (penalty < 1000) break;
    }
    if (best && best.penalty < 1000) break;
  }

  const { cx: blockCX, cy: blockCY, candBox: finalBox } = best;

  let name = null;
  let pillY = blockCY;

  if (nameText) {
    const nameY = finalBox.y1 + 2 + nameH / 2;
    pillY = finalBox.y1 + 2 + nameH + VGAP + H / 2;
    name = {
      x: blockCX,
      y: nameY,
      text: nameText,
      w: nameW,
      h: nameH,
      fontSize: TERMINAL_NAME_SIZE,
    };
  }

  const pills = [];
  let cursor = blockCX - pillRowW / 2;
  for (const r of refs) {
    pills.push({
      key: `${n.id}#${r.id}`,
      x: cursor + r.w / 2,
      y: pillY,
      w: r.w,
      h: H,
      text: r.text,
      color: r.color,
      lineId: r.id,
      fontSize: TERMINAL_PILL_FONT,
    });
    cursor += r.w + GAP;
  }

  return { pills, name, blockBox: finalBox };
}

function renderTerminals(layer, nodes) {
  const items = nodes.filter((n) => n.terminalLayout && n.terminalLayout.pills.length);
  const groups = layer
    .selectAll('g.sch-terminal')
    .data(items, (d) => d.id)
    .join('g')
    .attr('class', 'sch-terminal')
    .attr('data-lines', (d) => d.terminalLayout.pills.map((p) => p.lineId).join(' '));

  groups.each(function (n) {
    const g = d3.select(this);
    const lay = n.terminalLayout;
    if (lay.name) {
      g.append('text')
        .attr('class', 'sch-terminal-name')
        .attr('x', lay.name.x)
        .attr('y', lay.name.y)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .text(lay.name.text);
    }
    for (const p of lay.pills) {
      const pill = g.append('g').attr('transform', `translate(${p.x},${p.y})`);
      pill.append('rect')
        .attr('class', 'sch-terminal-pill')
        .attr('x', -p.w / 2).attr('y', -p.h / 2)
        .attr('width', p.w).attr('height', p.h)
        .attr('rx', 3)
        .attr('fill', p.color);
      pill.append('text')
        .attr('class', 'sch-terminal-text')
        .attr('font-size', p.fontSize || TERMINAL_PILL_FONT)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .text(p.text);
    }
  });
}

const EDGE_LABEL_ATTEMPTS = [
  { font: 12, side: 1 },
  { font: 12, side: -1 },
  { font: 10, side: 1 },
  { font: 10, side: -1 },
  { font: 9, side: 1 },
  { font: 9, side: -1 },
];

function pointOnCorridor(pts, cum, dist) {
  const total = cum[cum.length - 1];
  if (total < 16) return null;
  const d = Math.max(8, Math.min(dist, total - 8));
  let idx = 1;
  while (idx < cum.length - 1 && cum[idx] < d) idx++;
  const span = cum[idx] - cum[idx - 1] || 1;
  const u = (d - cum[idx - 1]) / span;
  const x1 = pts[idx - 1].x, y1 = pts[idx - 1].y;
  const x2 = pts[idx].x, y2 = pts[idx].y;
  let ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  if (ang > 90) ang -= 180;
  else if (ang < -90) ang += 180;
  return {
    x: x1 + (x2 - x1) * u,
    y: y1 + (y2 - y1) * u,
    ang,
    edge: pts[idx].edge,
    span,
  };
}

function buildEdgeRows(refs, attempt, bandWidth) {
  const font = attempt.font;
  const labels = refs
    .map((r) => ({
      id: r.id,
      line: r.line,
      text: lineShort(r.line),
      color: (r.line || {}).color || '#555',
    }))
    .sort((a, b) => compareLines(a.line, b.line));
  for (const l of labels) l.w = textWidth(l.text, true, font) + 4;
  const rowH = font + 4;
  const off = (bandWidth || LINE_WIDTH) / 2 + 7;
  const width = labels.reduce((s, l) => s + l.w, 0);
  const rows = [{ labels, y: attempt.side * (off + rowH / 2), width }];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const row of rows) {
    x1 = Math.min(x1, -row.width / 2);
    x2 = Math.max(x2, row.width / 2);
    y1 = Math.min(y1, row.y - rowH / 2);
    y2 = Math.max(y2, row.y + rowH / 2);
  }
  return { rows, local: { x1, y1, x2, y2 }, fontSize: font };
}

function transformBox(local, x, y, angDeg) {
  const a = (angDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const corners = [
    [local.x1, local.y1], [local.x2, local.y1],
    [local.x2, local.y2], [local.x1, local.y2],
  ];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [lx, ly] of corners) {
    const wx = x + lx * c - ly * s;
    const wy = y + lx * s + ly * c;
    x1 = Math.min(x1, wx); y1 = Math.min(y1, wy);
    x2 = Math.max(x2, wx); y2 = Math.max(y2, wy);
  }
  return { x1: x1 - 2, y1: y1 - 2, x2: x2 + 2, y2: y2 + 2 };
}

function boxHitsAny(box, obstacles) {
  let n = 0;
  for (const o of obstacles) {
    if (box.x1 < o.x2 && box.x2 > o.x1 && box.y1 < o.y2 && box.y2 > o.y1) n++;
  }
  return n;
}

function planEdgeLabels(edges, nodes, lineById) {
  // Labels only where the bundle of lines changes, plus an occasional repeat
  // on a long unchanged run — not on every stop-to-stop segment.
  const REPEAT = 520;
  const CHANGE_INSET = 54;
  const MIN_CORRIDOR = 72;
  const items = [];
  const obstacles = [];
  for (const n of nodes) {
    obstacles.push({ x1: n.x - 15, y1: n.y - 15, x2: n.x + 15, y2: n.y + 15 });
    const lay = n.terminalLayout;
    if (!lay) continue;
    for (const p of lay.pills) obstacles.push(pillBox(p, 4));
  }
  const keyOf = (e) => e.lines.join('|');
  const visited = new Set();

  const lineChanges = (node) => {
    if (!node || node.edges.length < 2) return false;
    let first = null;
    for (const e of node.edges) {
      const k = keyOf(e);
      if (first == null) first = k;
      else if (k !== first) return true;
    }
    return false;
  };
  const sameNext = (edge, node) => {
    const key = keyOf(edge);
    const nexts = node.edges.filter((e) => e !== edge && keyOf(e) === key);
    return nexts.length === 1 ? nexts[0] : null;
  };

  for (const seed of edges) {
    if (visited.has(seed) || !seed.lines.length) continue;
    const chain = [seed];
    visited.add(seed);
    const walk = (startNode, unshift) => {
      let edge = seed;
      let node = startNode;
      while (true) {
        const next = sameNext(edge, node);
        if (!next || visited.has(next) || lineChanges(node)) break;
        visited.add(next);
        if (unshift) chain.unshift(next); else chain.push(next);
        const far = next.source === node ? next.target : next.source;
        edge = next;
        node = far;
      }
      return node;
    };
    const endA = walk(seed.source, true);
    const endB = walk(seed.target, false);

    const pts = [];
    let prev = endA;
    let broken = false;
    for (const e of chain) {
      if (e.source !== prev && e.target !== prev) { broken = true; break; }
      const a = e.source === prev ? e.source : e.target;
      const b = e.source === prev ? e.target : e.source;
      if (!pts.length) pts.push({ x: a.x, y: a.y });
      pts.push({ x: b.x, y: b.y, edge: e });
      prev = b;
    }
    if (broken || pts.length < 2) continue;

    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const total = cum[cum.length - 1];
    const startChange = lineChanges(endA);
    const endChange = lineChanges(endB);
    if (total < ((startChange || endChange) ? 36 : MIN_CORRIDOR)) continue;
    const marks = [];
    const near = (d) => marks.some((m) => Math.abs(m - d) < 140);
    if (startChange) marks.push(Math.min(CHANGE_INSET, total * 0.4));
    if (endChange) {
      const d = Math.max(total - CHANGE_INSET, total * 0.6);
      if (!near(d)) marks.push(d);
    }
    if (total >= REPEAT) {
      const n = Math.max(1, Math.round(total / REPEAT) - 1);
      for (let i = 1; i <= n; i++) {
        const d = (total * i) / (n + 1);
        if (!near(d)) marks.push(d);
      }
    } else if (!startChange && !endChange && total >= 360) {
      marks.push(total / 2);
    }
    if (!marks.length) continue;

    const refs = chain[0].lines.map((id) => ({ id, line: lineById.get(id) }));
    marks.forEach((dist, mi) => {
      let best = null;
      for (const shift of [0, -34, 34, -68, 68]) {
        const anchor = pointOnCorridor(pts, cum, dist + shift);
        if (!anchor) continue;
        for (const attempt of EDGE_LABEL_ATTEMPTS) {
          const built = buildEdgeRows(refs, attempt, anchor.edge.bandWidth || LINE_WIDTH);
          const width = built.local.x2 - built.local.x1;
          const box = transformBox(built.local, anchor.x, anchor.y, anchor.ang);
          const tooWide = width > Math.max(36, anchor.span * 0.92);
          const hits = boxHitsAny(box, obstacles) + (tooWide ? 4 : 0);
          const cand = {
            key: `${chain[0].id}#c${mi}`,
            x: anchor.x,
            y: anchor.y,
            ang: anchor.ang,
            rows: built.rows,
            fontSize: built.fontSize,
            box,
            hits,
            ids: refs.map((r) => r.id),
          };
          if (hits === 0) { best = cand; break; }
        }
        if (best && best.hits === 0) break;
      }
      // One row only. A segment that cannot hold it drops the numbers.
      if (!best || best.hits > 0) return;
      items.push(best);
      obstacles.push(best.box);
    });
  }

  return items;
}

function renderEdgeLabels(layer, items) {
  const groups = layer
    .selectAll('g.sch-edgelabel')
    .data(items, (d) => d.key)
    .join('g')
    .attr('class', 'sch-edgelabel')
    .attr('data-lines', (d) => d.ids.join(' '))
    .attr('transform', (d) => `translate(${d.x},${d.y}) rotate(${d.ang})`);

  groups.each(function (d) {
    const g = d3.select(this);
    for (const row of d.rows) {
      let cursor = -row.width / 2;
      for (const l of row.labels) {
        g.append('text')
          .attr('class', 'sch-edgelabel-text sch-edgelabel-pill')
          .attr('data-lines', l.id)
          .attr('x', cursor + l.w / 2)
          .attr('y', row.y)
          .attr('font-size', d.fontSize)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', l.color)
          .text(l.text);
        cursor += l.w;
      }
    }
  });
}

/** Line changes at a pass-through station (two lines meet but continue differently). */
function hasLineChange(n) {
  if (n.edges.length < 2) return n.lines.size > 1;
  const [a, b] = n.edges;
  if (a.lines.length !== b.lines.length) return true;
  return a.lines.some((l) => !b.lines.includes(l));
}

/* ------------------------------------------------------------------ */
/* Label placement with collision avoidance                            */
/* ------------------------------------------------------------------ */

const LABEL_DIRECTIONS = [
  [1, 0], [-1, 0], [0, -1], [0, 1],
  [0.7071, -0.7071], [-0.7071, -0.7071], [0.7071, 0.7071], [-0.7071, 0.7071],
];

function textWidth(text, bold, size = LABEL_FONT_SIZE) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${bold ? 700 : 500} ${size}px ${LABEL_FONT}`;
  return measureCtx.measureText(text).width;
}

function numberObstacles(nodes, edgeItems) {
  const out = [];
  for (const item of edgeItems) {
    if (!item.box) continue;
    out.push({ type: 'num', x1: item.box.x1, y1: item.box.y1, x2: item.box.x2, y2: item.box.y2 });
  }
  for (const n of nodes) {
    const lay = n.terminalLayout;
    if (!lay) continue;
    for (const p of lay.pills) out.push(pillBox(p, 5));
    if (lay.blockBox) out.push({ type: 'num',
      x1: lay.blockBox.x1 - 3, y1: lay.blockBox.y1 - 3,
      x2: lay.blockBox.x2 + 3, y2: lay.blockBox.y2 + 3 });
  }
  return out;
}

function labelScore(box, items, owner) {
  const score = { numbers: 0, labels: 0, stations: 0 };
  for (const it of items) {
    if (it.type === 'label' && it.owner === owner) continue;
    if (!boxesOverlap(box, it, 0)) continue;
    if (it.type === 'num') score.numbers++;
    else if (it.type === 'station') score.stations++;
    else score.labels++;
  }
  return score;
}

function betterLabelScore(a, b) {
  if (a.numbers !== b.numbers) return a.numbers < b.numbers;
  if (a.stations !== b.stations) return a.stations < b.stations;
  return a.labels < b.labels;
}

function placeTerminalNames(nodes, numberBoxes) {
  // Names are positioned inside layoutTerminalBlock together with pills as
  // one block; x/y are already set. Just collect boxes for obstacle tracking.
  const nameBoxes = [];
  for (const n of nodes) {
    const lay = n.terminalLayout;
    if (!lay || !lay.name || lay.name.x == null) continue;
    const nm = lay.name;
    nameBoxes.push({
      type: 'label', owner: n,
      x1: nm.x - nm.w / 2, y1: nm.y - nm.h / 2,
      x2: nm.x + nm.w / 2, y2: nm.y + nm.h / 2,
    });
  }
  return nameBoxes;
}
function placeLabels(nodes, numberBoxes, nameBoxes) {
  const CELL = 64;
  const grid = new Map();
  const cellKey = (cx, cy) => `${cx},${cy}`;
  const addToGrid = (item) => {
    const box = item;
    for (let cx = Math.floor(box.x1 / CELL); cx <= Math.floor(box.x2 / CELL); cx++) {
      for (let cy = Math.floor(box.y1 / CELL); cy <= Math.floor(box.y2 / CELL); cy++) {
        const k = cellKey(cx, cy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(item);
      }
    }
  };
  const nearby = (box) => {
    const out = new Set();
    for (let cx = Math.floor(box.x1 / CELL); cx <= Math.floor(box.x2 / CELL); cx++) {
      for (let cy = Math.floor(box.y1 / CELL); cy <= Math.floor(box.y2 / CELL); cy++) {
        const items = grid.get(cellKey(cx, cy));
        if (items) items.forEach((i) => out.add(i));
      }
    }
    return out;
  };

  for (const b of numberBoxes) addToGrid(b);
  for (const b of nameBoxes) addToGrid(b);
  for (const n of nodes) {
    const r = 11;
    addToGrid({ type: 'station', owner: n, x1: n.x - r, y1: n.y - r, x2: n.x + r, y2: n.y + r });
  }

  const ordered = [...nodes].sort((a, b) => {
    const rank = (n) => (n.kind === 'interchange' ? 0 : n.edges.length === 1 ? 1 : 2);
    return rank(a) - rank(b) || b.edges.length - a.edges.length;
  });

  for (const n of ordered) {
    if (n.terminalLayout && n.terminalLayout.name) {
      n.label = null;
      continue;
    }
    const bold = n.kind === 'interchange';
    const preferred = preferredDirection(n);
    const candidates = [preferred, ...LABEL_DIRECTIONS.filter((d) => d !== preferred)];
    const baseGap = n.band / 2 + (n.kind === 'interchange' ? 8 : 6);
    let best = null;
    for (const size of [LABEL_FONT_SIZE, 9]) {
      const w = textWidth(n.name, bold, size) + 2;
      const h = size + 3;
      for (const mul of [1, 1.4, 2.0]) {
        for (const dir of candidates) {
          const cand = labelBox(n, dir, baseGap * mul, w, h);
          const score = labelScore(cand.box, nearby(cand.box), n);
          const packed = { ...cand, size, score };
          if (!best || betterLabelScore(score, best.score)) best = packed;
          if (score.numbers === 0 && score.labels === 0 && score.stations === 0) break;
        }
        if (best && best.score.numbers === 0 && best.score.labels === 0 && best.score.stations === 0) break;
      }
      if (best && best.score.numbers === 0 && best.score.labels === 0 && best.score.stations === 0) break;
    }
    n.label = { dx: best.dx, dy: best.dy, anchor: best.anchor, dir: best.dir, size: best.size };
    addToGrid({ type: 'label', owner: n, ...best.box });
  }
}

function preferredDirection(n) {
  // Perpendicular to the station's main axis, preferring right/up.
  const [ax, ay] = n.axis;
  let px = -ay, py = ax;
  if (px < -0.1 || (Math.abs(px) <= 0.1 && py > 0)) { px = -px; py = -py; }
  let best = LABEL_DIRECTIONS[0], bestDot = -Infinity;
  for (const d of LABEL_DIRECTIONS) {
    const dot = d[0] * px + d[1] * py;
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

function labelBox(n, dir, gap, w, h) {
  const [dxu, dyu] = dir;
  const dx = dxu * gap;
  const dy = dyu * gap;
  const anchor = Math.abs(dxu) < 0.2 ? 'middle' : dxu > 0 ? 'start' : 'end';
  const ax = n.x + dx;
  // Vertical labels sit fully above/below the station.
  const cy = n.y + dy + (Math.abs(dxu) < 0.2 ? Math.sign(dyu) * (h / 2 - 2) : 0);
  const x1 = anchor === 'start' ? ax : anchor === 'end' ? ax - w : ax - w / 2;
  return {
    dir,
    dx,
    dy: cy - n.y,
    anchor,
    box: { x1, y1: cy - h / 2, x2: x1 + w, y2: cy + h / 2 },
  };
}

function countConflicts(box, items, owner) {
  let c = 0;
  for (const it of items) {
    if (it.type === 'box') {
      if (it.owner === owner) continue;
      if (box.x1 < it.x2 && box.x2 > it.x1 && box.y1 < it.y2 && box.y2 > it.y1) c++;
    } else if (segmentHitsBox(it, box)) {
      c++;
    }
  }
  return c;
}

/** Segment (with thickness `pad`) vs. axis-aligned box, via Liang–Barsky clipping. */
function segmentHitsBox(s, b) {
  const x1 = b.x1 - s.pad, y1 = b.y1 - s.pad, x2 = b.x2 + s.pad, y2 = b.y2 + s.pad;
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [s.x1 - x1, x2 - s.x1, s.y1 - y1, y2 - s.y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Highlighting                                                        */
/* ------------------------------------------------------------------ */

let focusedLine = null;

function getFocusLine() { return focusedLine; }

function setFocusLine(lineId) {
  focusedLine = lineId || null;
  applyHighlight();
  if (onFocusChange) onFocusChange(focusedLine);
}

function applyHighlight() {
  if (!rootGroup) return;
  const active = focusedLine;
  rootGroup.classed('has-focus', !!active);
  const matchOne = function () { return this.getAttribute('data-line') === active; };
  const matchMany = function () {
    return !!active && (this.getAttribute('data-lines') || '').split(' ').includes(active);
  };
  rootGroup.selectAll('.sch-stroke, .sch-casing, .sch-arrow').classed('active', matchOne);
  rootGroup
    .selectAll('.sch-station, .sch-label, .sch-terminal, .sch-edgelabel-pill')
    .classed('active', matchMany);
  if (active) {
    rootGroup.selectAll('.sch-casing.active').raise();
    rootGroup.selectAll('.sch-stroke.active').raise();
    rootGroup.selectAll('.sch-arrow.active').raise();
  }
  document.querySelectorAll('#schematic-legend li[data-line]').forEach((li) => {
    li.classList.toggle('active', li.dataset.line === active);
  });
}

/* ------------------------------------------------------------------ */
/* Line chooser (click an element carrying several lines)              */
/* ------------------------------------------------------------------ */

function pickLine(lineIds, event) {
  const ids = [...new Set(lineIds)].filter((id) => lastGraph.lineById.has(id));
  if (!ids.length) return;
  if (ids.length === 1) {
    setFocusLine(focusedLine === ids[0] ? null : ids[0]);
    closeChooser();
    return;
  }
  openChooser(ids, event);
}

function openChooser(ids, event) {
  closeChooser();
  const container = lastContainer;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  chooserEl = document.createElement('div');
  chooserEl.className = 'sch-chooser';
  const title = document.createElement('div');
  title.className = 'sch-chooser-title';
  title.textContent = 'Preview which line?';
  chooserEl.appendChild(title);

  ids.sort((a, b) => compareLines(lastGraph.lineById.get(a), lastGraph.lineById.get(b)));
  for (const id of ids) {
    const line = lastGraph.lineById.get(id) || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sch-chooser-item' + (focusedLine === id ? ' active' : '');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = line.color || '#555';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = line.name || id;
    btn.append(sw, nm);
    btn.addEventListener('click', (e) => { e.stopPropagation(); setFocusLine(id); closeChooser(); });
    chooserEl.appendChild(btn);
  }

  container.appendChild(chooserEl);
  const x = (event && event.clientX ? event.clientX : rect.left + rect.width / 2) - rect.left;
  const y = (event && event.clientY ? event.clientY : rect.top + rect.height / 2) - rect.top;
  const cw = chooserEl.offsetWidth, ch = chooserEl.offsetHeight;
  chooserEl.style.left = Math.max(6, Math.min(rect.width - cw - 6, x + 8)) + 'px';
  chooserEl.style.top = Math.max(6, Math.min(rect.height - ch - 6, y + 8)) + 'px';
}

function closeChooser() {
  if (chooserEl && chooserEl.parentNode) chooserEl.parentNode.removeChild(chooserEl);
  chooserEl = null;
}

function renderLegend(graph) {
  const legend = document.getElementById('schematic-legend');
  if (!legend) return;
  const lines = graph.lines.filter((l) => l.edgeCount > 0 || l.source === 'user').slice().sort(compareLines);
  if (!lines.length) {
    legend.classList.add('hidden');
    legend.innerHTML = '';
    return;
  }
  legend.classList.remove('hidden');
  legend.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = `Lines · ${lines.length}`;
  legend.appendChild(h);
  const ul = document.createElement('ul');
  for (const l of lines) {
    const li = document.createElement('li');
    li.dataset.line = l.id;
    li.title = l.variants && l.variants.length ? l.variants.join('\n') : l.name;
    const color = document.createElement('input');
    color.type = 'color';
    color.value = toHexColor(l.color);
    color.title = `Color of ${l.name}`;
    color.addEventListener('mousedown', (e) => e.stopPropagation());
    color.addEventListener('click', (e) => e.stopPropagation());
    color.addEventListener('change', (e) => {
      e.stopPropagation();
      if (onRecolorChange) onRecolorChange(l.id, color.value);
    });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = l.name;
    li.append(color, name);
    if (l.source === 'user') {
      const badge = document.createElement('span');
      badge.className = 'user-badge';
      badge.textContent = 'custom';
      li.appendChild(badge);
    }
    li.addEventListener('click', () => {
      setFocusLine(focusedLine === l.id ? null : l.id);
      closeChooser();
    });
    ul.appendChild(li);
  }
  legend.appendChild(ul);
}

/* ================================================================== */
/* Utils                                                               */
/* ================================================================== */

function svgSize() {
  const node = svg.node();
  const rect = node.getBoundingClientRect();
  return { width: rect.width || 800, height: rect.height || 600 };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function toHexColor(color) {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return color;
  if (typeof color === 'string' && /^#[0-9a-f]{3}$/i.test(color)) {
    return '#' + color.slice(1).split('').map((c) => c + c).join('');
  }
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = '#555555';
    ctx.fillStyle = color || '#555555';
    if (/^#[0-9a-f]{6}$/i.test(ctx.fillStyle)) return ctx.fillStyle;
  } catch (_) { /* ignore */ }
  return '#555555';
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

TMB.renderSchematic = renderSchematic;
TMB.destroySchematic = destroySchematic;
TMB.fitSchematic = fitSchematic;
TMB.getSchematicSvgMarkup = getSchematicSvgMarkup;
TMB.setSchematicFocus = setFocusLine;
TMB.getSchematicFocus = getFocusLine;
TMB.setSchematicMoveMode = setSchematicMoveMode;
TMB.compareLines = compareLines;
})();
