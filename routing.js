var TMB = window.TMB || {};
(function () {
/**
 * routing.js
 * Builds a routing graph from loaded OSM transit geometry so that user-drawn
 * lines can be snapped to follow the real tracks (tram/rail) or bus routes.
 *
 * Usage:
 *   const router = TMB.createRouter(osm.lines, ['tram', 'light_rail']);
 *   const res = router.route([[lat,lng], [lat,lng], ...]); // drawn waypoints
 *   // res = { coords: [[lat,lng],...], legsRouted, legsStraight, ok }
 *
 * The graph nodes are the vertices of the OSM way geometry (quantized so that
 * ways meeting at a junction share a node). Edges are weighted by metric length.
 * route() snaps each waypoint to the nearest node and runs Dijkstra between
 * consecutive waypoints, falling back to a straight segment when a leg cannot be
 * routed (waypoint too far from any track, or no connecting path).
 */

const MAX_SNAP_METERS = 250;   // a waypoint farther than this is treated as "off track"
const CELL_DEG = 0.004;        // spatial-hash cell (~300–450 m)
const MAX_PATH_POINTS = 4000;  // safety cap for a single routed line

/* ------------------------------------------------------------------ */
/* Min-heap for Dijkstra                                               */
/* ------------------------------------------------------------------ */

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(dist, node) {
    const a = this.a;
    a.push({ dist, node });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].dist <= a[i].dist) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < n && a[l].dist < a[s].dist) s = l;
        if (r < n && a[r].dist < a[s].dist) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/* ------------------------------------------------------------------ */
/* Graph construction                                                  */
/* ------------------------------------------------------------------ */

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

/**
 * @param {Array} osmLines  lines from api.parseOverpass (each with .type + .segments)
 * @param {string[]|null} types  allowed route types, or null for all
 */
function createRouter(osmLines, types) {
  const typeSet = types && types.length ? new Set(types) : null;
  const lat = [];           // node latitude
  const lng = [];           // node longitude
  const adj = [];           // adjacency: adj[i] = [j0, w0, j1, w1, ...] flat
  const nodeIndex = new Map(); // quantized key -> node id
  const grid = new Map();   // cell key -> [nodeId, ...]
  const edgeSet = new Set();

  const keyOf = (la, lo) => `${Math.round(la * 1e5)},${Math.round(lo * 1e5)}`;
  const cellOf = (la, lo) => `${Math.floor(la / CELL_DEG)},${Math.floor(lo / CELL_DEG)}`;

  function nodeAt(la, lo) {
    const k = keyOf(la, lo);
    let id = nodeIndex.get(k);
    if (id === undefined) {
      id = lat.length;
      nodeIndex.set(k, id);
      lat.push(la);
      lng.push(lo);
      adj.push([]);
      const ck = cellOf(la, lo);
      if (!grid.has(ck)) grid.set(ck, []);
      grid.get(ck).push(id);
    }
    return id;
  }

  function addEdge(ia, ib, w) {
    if (ia === ib) return;
    const ek = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
    if (edgeSet.has(ek)) return;
    edgeSet.add(ek);
    adj[ia].push(ib, w);
    adj[ib].push(ia, w);
  }

  let segmentCount = 0;
  for (const line of osmLines || []) {
    if (typeSet && !typeSet.has(line.type)) continue;
    const segs = line.segments || [];
    for (const seg of segs) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      segmentCount++;
      let prev = nodeAt(seg[0][0], seg[0][1]);
      for (let i = 1; i < seg.length; i++) {
        const cur = nodeAt(seg[i][0], seg[i][1]);
        addEdge(prev, cur, haversine(lat[prev], lng[prev], lat[cur], lng[cur]));
        prev = cur;
      }
    }
  }

  /* ------------------------------------------------------------ */
  /* Nearest-node query                                            */
  /* ------------------------------------------------------------ */

  function nearest(la, lo) {
    const cx = Math.floor(la / CELL_DEG);
    const cy = Math.floor(lo / CELL_DEG);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cell = grid.get(`${cx + dx},${cy + dy}`);
          if (!cell) continue;
          for (const id of cell) {
            const d = haversine(la, lo, lat[id], lng[id]);
            if (d < bestD) { bestD = d; best = id; }
          }
        }
      }
      // Once we found something and have scanned one extra ring, stop.
      if (best >= 0 && r >= 1) break;
    }
    if (best < 0) return null;
    return { idx: best, dist: bestD };
  }

  /* ------------------------------------------------------------ */
  /* Dijkstra between two nodes                                     */
  /* ------------------------------------------------------------ */

  function shortestPath(start, goal) {
    if (start === goal) return [start];
    const n = lat.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    dist[start] = 0;
    const heap = new MinHeap();
    heap.push(0, start);
    while (heap.size) {
      const { dist: d, node } = heap.pop();
      if (d > dist[node]) continue;
      if (node === goal) break;
      const row = adj[node];
      for (let k = 0; k < row.length; k += 2) {
        const to = row[k];
        const nd = d + row[k + 1];
        if (nd < dist[to]) {
          dist[to] = nd;
          prev[to] = node;
          heap.push(nd, to);
        }
      }
    }
    if (!Number.isFinite(dist[goal])) return null;
    const path = [];
    for (let at = goal; at !== -1; at = prev[at]) path.push(at);
    path.reverse();
    return path;
  }

  /* ------------------------------------------------------------ */
  /* Public: route through waypoints                               */
  /* ------------------------------------------------------------ */

  function route(waypoints) {
    const wps = (waypoints || []).filter(
      (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
    );
    if (wps.length < 2 || lat.length === 0) {
      return { coords: wps, legsRouted: 0, legsStraight: Math.max(0, wps.length - 1), ok: false };
    }

    const snaps = wps.map((p) => {
      const near = nearest(p[0], p[1]);
      return near && near.dist <= MAX_SNAP_METERS ? near : null;
    });

    const coords = [];
    let legsRouted = 0;
    let legsStraight = 0;
    const pushPoint = (la, lo) => {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== la || last[1] !== lo) coords.push([la, lo]);
    };

    for (let i = 0; i < wps.length - 1; i++) {
      const a = snaps[i];
      const b = snaps[i + 1];
      let routed = null;
      if (a && b) routed = shortestPath(a.idx, b.idx);

      if (routed && coords.length + routed.length <= MAX_PATH_POINTS) {
        for (const id of routed) pushPoint(lat[id], lng[id]);
        legsRouted++;
      } else {
        // Fallback: straight segment through the raw waypoints.
        pushPoint(wps[i][0], wps[i][1]);
        pushPoint(wps[i + 1][0], wps[i + 1][1]);
        legsStraight++;
      }
    }

    return {
      coords: coords.length >= 2 ? coords : wps,
      legsRouted,
      legsStraight,
      ok: legsRouted > 0,
    };
  }

  return {
    route,
    nodeCount: lat.length,
    segmentCount,
    isEmpty: lat.length === 0,
  };
}

TMB.createRouter = createRouter;
})();
