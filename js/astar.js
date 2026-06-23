// astar.js — direction-aware A* over a grid. No THREE dependency, so it can be
// unit-tested in Node. The turn penalty rewards long straight runs; the per-cell
// cost lets callers make land cheap and water expensive (so roads bridge only
// when forced).

// opts: { start:{i,j}, goal:{i,j}, cost(i,j)->number|Infinity,
//         inBounds(i,j)->bool, turnPenalty, onStep }. Returns [{i,j}...] or null.
// onStep (optional) is a visualizer hook: it fires once per node popped off the
// heap, with { cur:{i,j}, open:[{i,j}...] (the live frontier), path:[{i,j}...]
// (best route to cur so far) }. It's guarded so normal pathfinding pays nothing.
export function astarGrid({ start, goal, cost, inBounds, turnPenalty = 4, allowDiagonal = false, onStep = null }) {
  // Default is 4-connected (orthogonal) — road LAYOUT needs clean right-angle, connected
  // grids. allowDiagonal adds the 4 diagonals so UNIT NAV can cut straight across open
  // ground instead of staircasing. A diagonal step travels √2 as far, so it costs √2× the
  // cell — otherwise A* would over-prefer diagonals.
  const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIRS = allowDiagonal ? CARD.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]) : CARD;
  const SQRT2 = Math.SQRT2;
  const key = (i, j, d) => i + ',' + j + ',' + d;
  const h = (i, j) => Math.hypot(i - goal.i, j - goal.j);

  // Tiny binary min-heap keyed on f.
  const heap = [];
  const push = (n) => {
    heap.push(n); let c = heap.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let c = 0;
      for (;;) { let s = c; const l = 2 * c + 1, r = l + 1; if (l < heap.length && heap[l].f < heap[s].f) s = l; if (r < heap.length && heap[r].f < heap[s].f) s = r; if (s === c) break; [heap[s], heap[c]] = [heap[c], heap[s]]; c = s; }
    }
    return top;
  };

  const g = new Map();
  const from = new Map();
  g.set(key(start.i, start.j, -1), 0);
  push({ i: start.i, j: start.j, d: -1, g: 0, f: h(start.i, start.j) });

  while (heap.length) {
    const cur = pop();
    const curK = key(cur.i, cur.j, cur.d);
    if (cur.g > (g.get(curK) ?? Infinity)) continue;
    if (onStep) {
      // Reconstruct the best-known route to the node we just settled, so the
      // visualizer can draw the path firming up as the frontier sweeps outward.
      const pth = []; let node = cur;
      while (node) { pth.push({ i: node.i, j: node.j }); node = from.get(key(node.i, node.j, node.d)) || null; }
      pth.reverse();
      onStep({ cur: { i: cur.i, j: cur.j }, open: heap.map(n => ({ i: n.i, j: n.j })), path: pth });
    }
    if (cur.i === goal.i && cur.j === goal.j) {
      const path = [];
      let node = cur;
      while (node) { path.push({ i: node.i, j: node.j }); node = from.get(key(node.i, node.j, node.d)) || null; }
      return path.reverse();
    }
    for (let di = 0; di < DIRS.length; di++) {
      const ddi = DIRS[di][0], ddj = DIRS[di][1];
      const ni = cur.i + ddi, nj = cur.j + ddj;
      if (!inBounds(ni, nj)) continue;
      const tc = cost(ni, nj);
      if (!isFinite(tc)) continue;
      const diag = ddi !== 0 && ddj !== 0;
      // No corner-cutting: a diagonal step is only allowed if both orthogonally-adjacent
      // cells are passable, so units don't clip the corner of a wall/building.
      if (diag && (!isFinite(cost(cur.i, nj)) || !isFinite(cost(ni, cur.j)))) continue;
      const step = (diag ? tc * SQRT2 : tc) + (cur.d !== -1 && di !== cur.d ? turnPenalty : 0);
      const ng = cur.g + step;
      const nk = key(ni, nj, di);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        push({ i: ni, j: nj, d: di, g: ng, f: ng + h(ni, nj) });
      }
    }
  }
  return null;
}
