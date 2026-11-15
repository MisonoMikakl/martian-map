// 占位数据生成器（C 前端开发用）。
//
// 合成一块 2×2 km、2 米分辨率的地形，用和 B 的 build_graph.py / planner.py 相同的规则
// （时间代价、不准切角、子集 + 排列枚举、事件时刻 95 分钟）算出三个场景，
// 输出格式和 B 的 run_scenarios.py 完全一致，所以前端就是按 B 的真实输出在开发和测试。
// 同时写出 A 格式的 work/*.bin，给 scripts/make-envelope-frames.mjs 用。
//
// 这些都是假数据：grid.json 里带 "synthetic": true，网页会显示“占位数据”横幅。
// A、B、D 的真实文件放进 public/data/ 后直接覆盖同名文件即可，不要再跑这个脚本。
//
// 用法：npm run fake-data（会接着跑安全返回范围脚本）

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const OUT = path.resolve('public/data');
const W = 1000;
const H = 1000;
const RES = 2; // 米/格
const N = W * H;

const PARAMS = { k: 0.6, alpha: 0.5, max_slope_deg: 15, eva_budget_min: 240, reserve_min: 30 };
const NOMINAL_TARGET_MIN = 200; // 调停留时间，让 nominal 的总时长落在这附近

// ---------------------------------------------------------------- 工具

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261114);

function valueNoise(cell, seed) {
  const gw = Math.ceil(W / cell) + 3;
  const gh = Math.ceil(H / cell) + 3;
  const r = mulberry32(seed);
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = r() * 2 - 1;
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = g[iy * gw + ix];
    const b = g[iy * gw + ix + 1];
    const c = g[(iy + 1) * gw + ix];
    const d = g[(iy + 1) * gw + ix + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const idx = (x, y) => y * W + x;

function writePng(file, width, height, rgba, colorType = 6) {
  const png = new PNG({ width, height, colorType, inputColorType: 6, inputHasAlpha: true });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  fs.writeFileSync(file, PNG.sync.write(png, { colorType, inputColorType: 6, inputHasAlpha: true }));
}

function rampColor(stops, v) {
  // stops: [[t, r, g, b], ...] 递增
  if (v <= stops[0][0]) return stops[0].slice(1);
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, ...c0] = stops[i - 1];
      const [t1, ...c1] = stops[i];
      const t = (v - t0) / (t1 - t0);
      return c0.map((c, j) => Math.round(lerp(c, c1[j], t)));
    }
  }
  return stops[stops.length - 1].slice(1);
}

// ---------------------------------------------------------------- 地形

const hab = { id: 'hab', name: 'Habitat', x: 120, y: 860 };
const targets = [
  { id: 't1', name: 'Boxwork ridge A', x: 410, y: 530, priority: 3,
    why: 'Mineral-filled fracture ridges record late groundwater flow (placeholder text).' },
  { id: 't2', name: 'Ridge-bounded hollow', x: 700, y: 640, priority: 2,
    why: 'Floor between ridges exposes the host rock the veins cut through (placeholder text).' },
  { id: 't3', name: 'Dark band contact', x: 640, y: 290, priority: 1,
    why: 'Contact between the boxwork unit and overlying layer constrains timing (placeholder text).' },
];
const keepClear = [hab, ...targets];

const elev = new Float32Array(N);
const hills = [];
for (let i = 0; i < 16; i++) {
  hills.push({ x: rand() * W, y: rand() * H, a: 6 + rand() * 26, s: 45 + rand() * 120 });
}
hills.push({ x: 560, y: 470, a: 42, s: 42 }); // 两个目标点之间的陡丘，逼路线绕行
hills.push({ x: 300, y: 700, a: 18, s: 60 });
const n1 = valueNoise(140, 1);
const n2 = valueNoise(35, 2);
const n3 = valueNoise(7, 3);
const nRidge = valueNoise(55, 4);
const ridge = new Float32Array(N);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let z = -4420 + 22 * (1 - y / H) + 9 * (x / W);
    for (const h of hills) {
      const dx = x - h.x;
      const dy = y - h.y;
      z += h.a * Math.exp(-(dx * dx + dy * dy) / (2 * h.s * h.s));
    }
    z += 7 * n1(x, y) + 1.6 * n2(x, y) + 0.25 * n3(x, y);
    const r = Math.max(0, 1 - Math.abs(nRidge(x, y)) / 0.07); // 噪声零线组成网状脊 = boxwork
    ridge[idx(x, y)] = r;
    z += 1.3 * r;
    // 右上角模拟 DTM 边缘的 nodata
    if (x - 870 > y * 0.8) z = NaN;
    elev[idx(x, y)] = z;
  }
}

// 坡度（度）和山体阴影
const slopeDeg = new Float32Array(N);
const shade = new Float32Array(N);
const L = [-0.5, 0.5, Math.SQRT1_2]; // 方位 315°、高度 45°（x 向东，y 向北）
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    const zc = elev[i];
    if (Number.isNaN(zc)) {
      slopeDeg[i] = NaN;
      shade[i] = NaN;
      continue;
    }
    const zl = elev[idx(Math.max(0, x - 1), y)];
    const zr = elev[idx(Math.min(W - 1, x + 1), y)];
    const zu = elev[idx(x, Math.max(0, y - 1))];
    const zd = elev[idx(x, Math.min(H - 1, y + 1))];
    const dzdx = ((Number.isNaN(zr) ? zc : zr) - (Number.isNaN(zl) ? zc : zl)) / (2 * RES);
    const dzdn = ((Number.isNaN(zu) ? zc : zu) - (Number.isNaN(zd) ? zc : zd)) / (2 * RES);
    slopeDeg[i] = (Math.atan(Math.hypot(dzdx, dzdn)) * 180) / Math.PI;
    const nx = -dzdx;
    const ny = -dzdn;
    const nz = 1;
    const len = Math.hypot(nx, ny, nz);
    shade[i] = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / len);
  }
}

// 粗糙度：3×3 窗口高程标准差
const rough = new Float32Array(N);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const z = elev[idx(xx, yy)];
        if (Number.isNaN(z)) continue;
        s += z;
        s2 += z * z;
        n++;
      }
    }
    rough[idx(x, y)] = n > 1 ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
  }
}

// 障碍：岩石、沙丘、陡坎、nodata
const hazard = new Uint8Array(N);
const dune = new Uint8Array(N);
const nearKeep = (x, y, r) => keepClear.some((p) => Math.hypot(p.x - x, p.y - y) < r);
for (let i = 0; i < N; i++) if (Number.isNaN(elev[i])) hazard[i] = 1;
for (let k = 0; k < 320; k++) {
  const cx = rand() * W;
  const cy = rand() * H;
  const r = 1.5 + rand() ** 2 * 7;
  if (nearKeep(cx, cy, 20)) continue;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (Math.hypot(x - cx, y - cy) <= r) hazard[idx(x, y)] = 1;
    }
  }
}
function fillEllipse(cx, cy, rx, ry, rot, mark) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const R = Math.max(rx, ry);
  for (let y = Math.floor(cy - R); y <= cy + R; y++) {
    for (let x = Math.floor(cx - R); x <= cx + R; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * c + dy * s) / rx;
      const v = (-dx * s + dy * c) / ry;
      if (u * u + v * v <= 1) mark(idx(x, y));
    }
  }
}
const duneFields = [
  { cx: 520, cy: 760, rx: 150, ry: 45, rot: -0.35 },
  { cx: 250, cy: 380, rx: 90, ry: 35, rot: 0.6 },
];
for (const d of duneFields) {
  fillEllipse(d.cx, d.cy, d.rx, d.ry, d.rot, (i) => {
    hazard[i] = 1;
    dune[i] = 1;
  });
}
// 陡坎：一条有缺口的线
for (let t = 0; t <= 1; t += 0.0008) {
  const x = Math.round(lerp(760, 900, t));
  const y = Math.round(lerp(380, 820, t) + 18 * Math.sin(t * 9));
  if (t > 0.42 && t < 0.5) continue; // 缺口
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx;
    const yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < W && yy < H) hazard[idx(xx, yy)] = 1;
  }
}
for (const p of keepClear) {
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) hazard[idx(p.x + dx, p.y + dy)] = 0;
}

// ---------------------------------------------------------------- 时间代价 + Dijkstra（与手册公式一致）

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const DD = DX.map((dx, d) => (dx !== 0 && DY[d] !== 0 ? RES * Math.SQRT2 : RES));
const maxSlope = Math.tan((PARAMS.max_slope_deg * Math.PI) / 180);

// cost[u*8+d] = 从 u 沿方向 d 走一步的秒数（k = PARAMS.k），不可通行为 Infinity。
// 和 B 的 build_graph.py 一致：两端格子都要可通行；斜走时两侧的直邻格也要可通行（不准切角）；
// 坡度上限按这一步的坡度判断。
const cost = new Float32Array(N * 8).fill(Infinity);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const u = idx(x, y);
    if (hazard[u]) continue;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d];
      const yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = idx(xx, yy);
      if (hazard[v]) continue;
      if (DX[d] !== 0 && DY[d] !== 0 && (hazard[idx(xx, y)] || hazard[idx(x, yy)])) continue;
      const g = (elev[v] - elev[u]) / DD[d];
      if (Math.abs(g) > maxSlope) continue;
      const vT = (6 * Math.exp(-3.5 * Math.abs(g + 0.05)) * 1000) / 3600; // m/s
      cost[u * 8 + d] = (DD[d] / (PARAMS.k * vT)) * (1 + PARAMS.alpha * rough[v]);
    }
  }
}

class Heap {
  constructor(cap = 1 << 20) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2);
      k.set(this.k);
      const v = new Int32Array(this.n * 2);
      v.set(this.v);
      this.k = k;
      this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop() {
    const topV = this.v[0];
    this.topK = this.k[0];
    const lastK = this.k[--this.n];
    const lastV = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= lastK) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = lastK;
    this.v[i] = lastV;
    return topV;
  }
}

/** reverse=false：从 src 出发到每格的秒数；reverse=true：每格走到 src 的秒数（转置图）。 */
function dijkstra(src, reverse = false) {
  const dist = new Float64Array(N).fill(Infinity);
  const pred = new Int32Array(N).fill(-1);
  const heap = new Heap();
  dist[src] = 0;
  heap.push(0, src);
  while (heap.n > 0) {
    const u = heap.pop();
    const du = heap.topK;
    if (du > dist[u]) continue;
    const ux = u % W;
    const uy = (u - ux) / W;
    for (let d = 0; d < 8; d++) {
      const xx = ux + DX[d];
      const yy = uy + DY[d];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = idx(xx, yy);
      const c = reverse ? cost[v * 8 + ((d + 4) & 7)] : cost[u * 8 + d];
      if (c === Infinity) continue;
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        pred[v] = u;
        heap.push(nd, v);
      }
    }
  }
  return { dist, pred };
}

function stepCost(u, v) {
  const ux = u % W;
  const uy = (u - ux) / W;
  const dx = (v % W) - ux;
  const dy = Math.floor(v / W) - uy;
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return { sec: cost[u * 8 + d], dist: DD[d] };
  throw new Error('not adjacent');
}

function extractCells(run, from, to) {
  const cells = [];
  for (let c = to; c !== -1; c = run.pred[c]) {
    cells.push(c);
    if (c === from) break;
  }
  if (cells[cells.length - 1] !== from) throw new Error('unreachable');
  return cells.reverse();
}

console.time('dijkstra');
const nodes = [hab, ...targets];
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const cellOf = (n) => idx(n.x, n.y);
const runs = {};
for (const n of nodes) runs[n.id] = dijkstra(cellOf(n));
const ret = dijkstra(cellOf(hab), true).dist; // 每格走回居住舱的秒数
console.timeEnd('dijkstra');

const travelMin = (a, b) => runs[a].dist[cellOf(byId[b])] / 60;
for (const a of nodes) for (const b of nodes) {
  if (a !== b && !Number.isFinite(travelMin(a.id, b.id))) throw new Error(`${a.id}→${b.id} unreachable`);
}

// ---------------------------------------------------------------- 路线规划（照 B 的 planner.py）
// 目标点子集 + 排列全枚举；比较规则：优先级之和 > 访问点数 > 总时间。

function permutationsK(arr, k) {
  if (k === 0) return [[]];
  const out = [];
  arr.forEach((x, i) => {
    for (const p of permutationsK([...arr.slice(0, i), ...arr.slice(i + 1)], k - 1)) out.push([x, ...p]);
  });
  return out;
}

/** travel(a, b) 返回分钟，a 可以是 'START'；available = 出舱上限 − 预留 − 已用时间 */
function planTsp(targetIds, dwellOf, travel, available) {
  let best = null;
  for (let count = targetIds.length; count >= 0; count--) {
    for (const perm of permutationsK(targetIds, count)) {
      const order = ['START', ...perm, 'hab'];
      let total = 0;
      let ok = true;
      for (let i = 0; i + 1 < order.length; i++) {
        const tt = travel(order[i], order[i + 1]);
        if (!Number.isFinite(tt)) {
          ok = false;
          break;
        }
        total += tt + (order[i + 1] === 'hab' ? 0 : dwellOf(order[i + 1]));
      }
      if (!ok || total > available) continue;
      const pr = perm.reduce((s, id) => s + byId[id].priority, 0);
      if (
        !best ||
        pr > best.pr ||
        (pr === best.pr && perm.length > best.n) ||
        (pr === best.pr && perm.length === best.n && total < best.total)
      )
        best = { perm, pr, n: perm.length, total };
    }
  }
  return best;
}

// 先只看行走时间，选出 nominal 顺序，再按比例定停留时间，让总时长约等于 NOMINAL_TARGET_MIN
const ids = targets.map((t) => t.id);
const travelNominal = (a, b) => (a === 'START' ? runs.hab : runs[a]).dist[cellOf(byId[b])] / 60;
const walkOnly = planTsp(ids, () => 0, travelNominal, Infinity);
const baseDwell = { t1: 30, t2: 25, t3: 20 };
const scale = Math.max(0.3, (NOMINAL_TARGET_MIN - walkOnly.total) / Object.values(baseDwell).reduce((a, b) => a + b, 0));
const dwell = Object.fromEntries(ids.map((id) => [id, Math.max(5, Math.round((baseDwell[id] * scale) / 5) * 5)]));
for (const t of targets) t.dwell_min = dwell[t.id];

const xyOf = (c) => [c % W, Math.floor(c / W)];
const deg = (r) => (r * 180) / Math.PI;

/**
 * 照 B 的 build_route_json 生成一个场景：
 * path 在停留时不重复点（停留时长加在离开后的下一格上）；legs 带 dwell / arrival / departure；
 * profile 每格一个点，坡度是这一步的坡度；unsafe 是“已用时间 + 回舱时间 > 上限 − 预留”的格子。
 */
function buildRoute({ id, title, params, perm, startCell, startRun, elapsed, scale, dwellOf, retScale }) {
  const limit = params.eva_budget_min - params.reserve_min;
  const route = {
    id,
    title,
    params: {
      k: params.k,
      alpha: params.alpha,
      max_slope_deg: params.max_slope_deg,
      eva_budget_min: params.eva_budget_min,
      reserve_min: params.reserve_min,
    },
    event: null,
    order: [],
    dropped: [],
    path: [],
    legs: [],
    profile: [],
    envelope_frames: [],
    unsafe: [],
  };
  const unsafe = new Map();
  const check = (c, tNow) => {
    const r = ret[c];
    if (!Number.isFinite(r) || tNow + (r / 60) * retScale > limit) {
      const [x, y] = xyOf(c);
      unsafe.set(`${x},${y}`, [x, y]);
    }
  };
  const seq = [
    { id: 'START', cell: startCell, dwell: 0, run: startRun },
    ...perm.map((tid) => ({ id: tid, cell: cellOf(byId[tid]), dwell: dwellOf(tid), run: runs[tid] })),
    { id: 'hab', cell: cellOf(hab), dwell: 0, run: runs.hab },
  ];
  let cum = elapsed;
  let acc = 0;
  const [sx, sy] = xyOf(startCell);
  route.path.push([sx, sy, cum]);
  route.profile.push({ d_m: 0, elev_m: elev[startCell], slope_deg: 0, t_min: cum });
  check(startCell, cum);
  for (let i = 0; i + 1 < seq.length; i++) {
    const u = seq[i];
    const v = seq[i + 1];
    const cells = extractCells(u.run, u.cell, v.cell);
    let legDist = 0;
    let legMax = 0;
    let legTravel = 0;
    for (let j = 1; j < cells.length; j++) {
      const { sec, dist } = stepCost(cells[j - 1], cells[j]);
      const m = (sec / 60) * scale;
      cum += m;
      legTravel += m;
      legDist += dist;
      acc += dist;
      const slope = deg(Math.atan(Math.abs(elev[cells[j]] - elev[cells[j - 1]]) / dist));
      legMax = Math.max(legMax, slope);
      const [x, y] = xyOf(cells[j]);
      route.path.push([x, y, cum]);
      route.profile.push({ d_m: acc, elev_m: elev[cells[j]], slope_deg: slope, t_min: cum });
      check(cells[j], cum);
    }
    const arrival = cum;
    cum += v.dwell;
    if (v.dwell > 0) check(v.cell, cum);
    route.legs.push({
      from: u.id,
      to: v.id,
      time_min: legTravel,
      dist_m: legDist,
      max_slope_deg: legMax,
      dwell_min: v.dwell,
      arrival_min: arrival,
      departure_min: cum,
    });
    route.order.push(u.id);
  }
  route.order.push('hab');
  route.unsafe = [...unsafe.values()];
  route.total_time_min = cum - elapsed;
  route.elapsed_time_min = cum;
  route.total_distance_m = acc;
  return route;
}

/** 照 B 的 save_png_frame：来得及回舱的格子涂成半透明红色 (255, 50, 50, 100)，其余透明 */
function bFrame(id, elapsed, retScale, limit) {
  const rgba = new Uint8ClampedArray(N * 4);
  const remain = (limit - elapsed) * 60;
  for (let i = 0; i < N; i++) {
    const r = ret[i] * retScale;
    if (Number.isFinite(r) && r >= 0 && r <= remain) {
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 50;
      rgba[i * 4 + 2] = 50;
      rgba[i * 4 + 3] = 100;
    }
  }
  const name = `${id}_env_${String(Math.round(elapsed)).padStart(3, '0')}.png`;
  writePng(path.join(OUT, 'scenarios', name), W, H, rgba);
  return name;
}

// ---------------------------------------------------------------- 输出

fs.mkdirSync(path.join(OUT, 'scenarios'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'photos'), { recursive: true });
for (const f of fs.readdirSync(path.join(OUT, 'scenarios'))) fs.rmSync(path.join(OUT, 'scenarios', f), { recursive: true, force: true });

// grid.json
fs.writeFileSync(
  path.join(OUT, 'grid.json'),
  JSON.stringify(
    {
      width: W,
      height: H,
      res_m: RES,
      geotransform: [8000, RES, 0, -250000, 0, -RES],
      crs_note: 'SYNTHETIC placeholder — no real projection',
      nodata: 'NaN',
      synthetic: true,
    },
    null,
    2,
  ),
);

// 底图 PNG
{
  const ortho = new Uint8ClampedArray(N * 4);
  const hs = new Uint8ClampedArray(N * 4);
  const sl = new Uint8ClampedArray(N * 4);
  const hz = new Uint8ClampedArray(N * 4);
  const grain = valueNoise(3, 9);
  const tone = valueNoise(80, 10);
  const slopeStops = [[0, 46, 160, 90], [6, 200, 210, 70], [12, 240, 140, 40], [15, 220, 40, 40], [25, 120, 0, 30]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const o = i * 4;
      if (Number.isNaN(elev[i])) {
        ortho[o + 3] = hs[o + 3] = sl[o + 3] = 255;
        hz[o] = 30; hz[o + 1] = 30; hz[o + 2] = 30; hz[o + 3] = 200;
        continue;
      }
      const s = shade[i];
      const g = 0.85 + 0.15 * grain(x, y) + 0.08 * tone(x, y);
      let r = 182;
      let gg = 124;
      let b = 86;
      if (dune[i]) { r = 92; gg = 72; b = 62; }
      r = lerp(r, 236, ridge[i] * 0.45);
      gg = lerp(gg, 200, ridge[i] * 0.45);
      b = lerp(b, 160, ridge[i] * 0.45);
      const k = (0.35 + 0.9 * s) * g;
      ortho[o] = r * k; ortho[o + 1] = gg * k; ortho[o + 2] = b * k; ortho[o + 3] = 255;
      if (hazard[i] && !dune[i]) { ortho[o] *= 0.45; ortho[o + 1] *= 0.42; ortho[o + 2] *= 0.42; }
      const v = Math.round(255 * clamp(s * 1.1, 0, 1));
      hs[o] = hs[o + 1] = hs[o + 2] = v; hs[o + 3] = 255;
      const [sr, sg, sb] = rampColor(slopeStops, slopeDeg[i]);
      sl[o] = sr; sl[o + 1] = sg; sl[o + 2] = sb; sl[o + 3] = 255;
      if (hazard[i]) { hz[o] = 255; hz[o + 1] = 60; hz[o + 2] = 60; hz[o + 3] = 210; }
    }
  }
  writePng(path.join(OUT, 'ortho.png'), W, H, ortho, 2);
  writePng(path.join(OUT, 'hillshade.png'), W, H, hs, 2);
  writePng(path.join(OUT, 'slope.png'), W, H, sl, 2);
  writePng(path.join(OUT, 'hazard.png'), W, H, hz, 6);

  // 热惯量：约 100 米一块，低分辨率
  const ti = new Uint8ClampedArray(N * 4);
  const tn = valueNoise(260, 11);
  const tiStops = [[150, 40, 20, 90], [250, 120, 40, 140], [350, 220, 80, 90], [450, 250, 170, 60], [550, 250, 245, 180]];
  for (let by = 0; by < H; by += 50) {
    for (let bx = 0; bx < W; bx += 50) {
      const cx = bx + 25;
      const cy = by + 25;
      let val = 360 + 120 * tn(cx, cy);
      if (dune[idx(cx, cy)]) val -= 120;
      val += 40 * ridge[idx(cx, cy)];
      const [r, g, b] = rampColor(tiStops, val);
      for (let y = by; y < Math.min(H, by + 50); y++) for (let x = bx; x < Math.min(W, bx + 50); x++) {
        const o = idx(x, y) * 4;
        ti[o] = r; ti[o + 1] = g; ti[o + 2] = b; ti[o + 3] = 255;
      }
    }
  }
  writePng(path.join(OUT, 'thermal.png'), W, H, ti, 2);
}

// geology.geojson（网格像素坐标）
{
  const ellipse = (cx, cy, rx, ry, rot, n = 40) => {
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const u = rx * Math.cos(a);
      const v = ry * Math.sin(a);
      ring.push([+(cx + u * Math.cos(rot) - v * Math.sin(rot)).toFixed(1), +(cy + u * Math.sin(rot) + v * Math.cos(rot)).toFixed(1)]);
    }
    return ring;
  };
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Sulfate-bearing unit', unit: 'Hs', color: '#e8c15a', note: 'Placeholder polygon (A to trace from CRISM / USGS map).' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [860, 0], [1000, 175], [1000, 420], [620, 470], [300, 560], [0, 520], [0, 0]]] },
      },
      {
        type: 'Feature',
        properties: { name: 'Boxwork ridge zone', unit: 'Bx', color: '#7fd1ff', note: 'Placeholder polygon.' },
        geometry: { type: 'Polygon', coordinates: [[[330, 450], [600, 420], [780, 560], [760, 700], [520, 690], [360, 600], [330, 450]]] },
      },
      ...duneFields.map((d, i) => ({
        type: 'Feature',
        properties: { name: `Dark sand ${i + 1}`, unit: 'Ds', color: '#b07cff', note: 'Basaltic sand — impassable on foot (placeholder).' },
        geometry: { type: 'Polygon', coordinates: [ellipse(d.cx, d.cy, d.rx + 8, d.ry + 8, d.rot)] },
      })),
    ],
  };
  fs.writeFileSync(path.join(OUT, 'geology.geojson'), JSON.stringify(fc));
}

// 路点照片占位图
{
  const PW = 800;
  const PH = 600;
  const tints = { t1: [1.0, 0.95, 0.9], t2: [1.05, 0.9, 0.85], t3: [0.9, 0.85, 0.85] };
  for (const t of targets) {
    const px = new Uint8ClampedArray(PW * PH * 4);
    const nz = valueNoise(4, t.id.charCodeAt(1));
    const big = valueNoise(60, t.id.charCodeAt(1) + 7);
    const horizon = 210 + 30 * Math.sin(t.id.charCodeAt(1));
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const o = (y * PW + x) * 4;
        const hz = horizon + 25 * big(x * 1.3, 0);
        let r, g, b;
        if (y < hz) {
          const k = y / hz;
          r = lerp(226, 196, k); g = lerp(186, 150, k); b = lerp(150, 120, k);
        } else {
          const depth = (y - hz) / (PH - hz);
          const n = 0.8 + 0.2 * nz(x / (0.4 + depth), y / (0.4 + depth)) + 0.15 * big(x, y);
          r = 170 * n; g = 110 * n; b = 74 * n;
          if (big(x * 2, y * 3) > 0.55) { r *= 0.55; g *= 0.5; b *= 0.5; }
        }
        const tt = tints[t.id];
        px[o] = r * tt[0]; px[o + 1] = g * tt[1]; px[o + 2] = b * tt[2]; px[o + 3] = 255;
      }
    }
    writePng(path.join(OUT, 'photos', `${t.id}.png`), PW, PH, px, 2);
    t.photo = `photos/${t.id}.png`;
    t.source = 'https://science.nasa.gov/mission/msl-curiosity/';
  }
}

// waypoints.json：用 B 的 run_scenarios.py 能读的格式（habitat + waypoints），
// D 的展示字段（name / why / source / photo）放在同一个对象里，B 会忽略它们
fs.writeFileSync(
  path.join(OUT, 'waypoints.json'),
  JSON.stringify(
    {
      habitat: { id: hab.id, name: hab.name, x: hab.x, y: hab.y },
      waypoints: targets.map(({ id, name, x, y, dwell_min, priority, why, source, photo }) => ({ id, name, x, y, dwell_min, priority, why, source, photo })),
    },
    null,
    2,
  ),
);

// env.json
fs.writeFileSync(
  path.join(OUT, 'env.json'),
  JSON.stringify(
    {
      sol: 12,
      season_note: 'Placeholder: northern spring (Ls ≈ 30°), EVA 09:00–15:00 local solar time',
      dose_note: 'Placeholder: RAD surface dose equivalent ≈ 0.64 mSv/sol (D to confirm value + source)',
      temp_c: [-70, -10],
      dust_tau: 0.5,
      eva_window: ['09:00', '15:00'],
      go: true,
      // B 的 run_scenarios.py 从 env.json 读规划参数
      k: PARAMS.k,
      alpha: PARAMS.alpha,
      max_slope_deg: PARAMS.max_slope_deg,
      eva_budget_min: PARAMS.eva_budget_min,
      reserve_min: PARAMS.reserve_min,
      slow_k_factor: 0.8,
      dust_budget_min: 180,
    },
    null,
    2,
  ),
);

// datasets.json（D 负责改成真实清单）
fs.writeFileSync(
  path.join(OUT, 'datasets.json'),
  JSON.stringify(
    [
      { name: 'HiRISE DTM (placeholder)', url: 'https://www.uahirise.org/dtm/', role: 'Elevation → slope, roughness, travel time', layers: ['hillshade', 'slope', 'hazard', 'route', 'envelope'] },
      { name: 'HiRISE orthoimage (placeholder)', url: 'https://www.uahirise.org/dtm/', role: 'Base image, hazard mapping', layers: ['ortho', 'hazard'] },
      { name: 'THEMIS thermal inertia (placeholder)', url: 'https://themis.mars.asu.edu/', role: 'Surface material context layer', layers: ['thermal'] },
      { name: 'CRISM mineral maps (placeholder)', url: 'https://pds-geosciences.wustl.edu/missions/mro/crism.htm', role: 'Geology / mineral polygons', layers: ['geology'] },
      { name: 'Curiosity raw images (placeholder)', url: 'https://science.nasa.gov/mission/msl-curiosity/', role: 'First-person waypoint photos' },
      { name: 'MSL RAD (placeholder)', url: 'https://science.nasa.gov/mission/msl-curiosity/', role: 'Surface radiation dose for EVA window' },
    ],
    null,
    2,
  ),
);

// ---------------------------------------------------------------- 场景（输出格式和 B 的 run_scenarios.py 完全一致）

const EVENT_TIME = 95; // B 的默认 --event-time
const SLOW_K_FACTOR = 0.8;
const DUST_BUDGET_MIN = 180; // B 的默认 dust_budget_min

function writeScenario(route, retScale) {
  const limit = route.params.eva_budget_min - route.params.reserve_min;
  const elapsed = route.event ? route.event.t_min : 0;
  if (!route.error) route.envelope_frames = [{ t_min: elapsed, png: bFrame(route.id, elapsed, retScale, limit) }];
  fs.writeFileSync(path.join(OUT, 'scenarios', `${route.id}.json`), JSON.stringify(route, null, 2));
  const end = route.path.length ? route.path[route.path.length - 1][2].toFixed(1) : '-';
  console.log(
    `${route.id.padEnd(8)} end ${end} min | ${route.order.join(' → ')} | dropped [${route.dropped.join(', ')}] | unsafe ${route.unsafe.length}${route.error ? ` | ERROR ${route.error}` : ''}`,
  );
}

// nominal：从居住舱出发
const nomPlan = planTsp(ids, (id) => dwell[id], travelNominal, PARAMS.eva_budget_min - PARAMS.reserve_min);
if (!nomPlan || nomPlan.perm.length !== ids.length) throw new Error('nominal cannot visit all targets — tune dwell');
const nominal = buildRoute({
  id: 'nominal',
  title: '按计划执行',
  params: PARAMS,
  perm: nomPlan.perm,
  startCell: cellOf(hab),
  startRun: runs.hab,
  elapsed: 0,
  scale: 1,
  dwellOf: (id) => dwell[id],
  retScale: 1,
});
writeScenario(nominal, 1);

// 事件位置：nominal 路线上最后一个 t ≤ 事件时间的点（B 的 get_position_at_time）
let sel = nominal.path[0];
for (const p of nominal.path) {
  if (p[2] <= EVENT_TIME) sel = p;
  else break;
}
const evtCell = idx(sel[0], sel[1]);

// 尚未完成的目标点（B 的 get_remaining_targets）：停留中的点只保留剩余停留时间
const completed = new Set();
const evtDwell = { ...dwell };
for (const leg of nominal.legs) {
  if (!ids.includes(leg.to)) continue;
  if (leg.departure_min <= EVENT_TIME) completed.add(leg.to);
  else if (leg.arrival_min <= EVENT_TIME) evtDwell[leg.to] = Math.max(0, leg.departure_min - EVENT_TIME);
}
const remaining = ids.filter((id) => !completed.has(id));
const evtRun = dijkstra(evtCell);

function eventScenario({ id, title, params, scale, type, description }) {
  const travel = (a, b) => ((a === 'START' ? evtRun : runs[a]).dist[cellOf(byId[b])] / 60) * scale;
  const plan = planTsp(remaining, (tid) => evtDwell[tid], travel, params.eva_budget_min - params.reserve_min - EVENT_TIME);
  let route;
  if (!plan) {
    route = {
      id,
      title,
      params: { k: params.k, alpha: params.alpha, max_slope_deg: params.max_slope_deg, eva_budget_min: params.eva_budget_min, reserve_min: params.reserve_min },
      event: null,
      order: [],
      dropped: [...remaining],
      path: [],
      legs: [],
      profile: [],
      envelope_frames: [],
      unsafe: [],
      error: 'Unreachable: Cannot find a safe path returning to Habitat within budget.',
    };
  } else {
    route = buildRoute({
      id,
      title,
      params,
      perm: plan.perm,
      startCell: evtCell,
      startRun: evtRun,
      elapsed: EVENT_TIME,
      scale,
      dwellOf: (tid) => evtDwell[tid],
      retScale: scale,
    });
    route.dropped = remaining.filter((t) => !plan.perm.includes(t));
  }
  route.event = { type, t_min: EVENT_TIME, pos: [sel[0], sel[1]], description };
  writeScenario(route, scale);
}

eventScenario({
  id: 'slow20',
  title: '移动速度降低20%',
  params: { ...PARAMS, k: PARAMS.k * SLOW_K_FACTOR },
  scale: 1 / SLOW_K_FACTOR,
  type: 'slow20',
  description: 'Movement speed reduced by 20%',
});
eventScenario({
  id: 'dust',
  title: '尘暴缩短EVA预算',
  params: { ...PARAMS, eva_budget_min: DUST_BUDGET_MIN },
  scale: 1,
  type: 'dust',
  description: 'Dust event reduces available EVA time',
});

fs.writeFileSync(
  path.join(OUT, 'scenarios', 'scenarios.json'),
  JSON.stringify(
    {
      scenarios: [
        { id: 'nominal', title: '按计划执行', json: 'nominal.json' },
        { id: 'slow20', title: '移动速度降低20%', json: 'slow20.json' },
        { id: 'dust', title: '尘暴缩短EVA预算', json: 'dust.json' },
      ],
    },
    null,
    2,
  ),
);

// A 的计算用栅格（work/，不部署）：给 C 的安全返回范围脚本用，B 也可以拿来跑
{
  const WORK = path.resolve('work');
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'elevation.bin'), Buffer.from(elev.buffer));
  fs.writeFileSync(path.join(WORK, 'rough.bin'), Buffer.from(rough.buffer));
  fs.writeFileSync(path.join(WORK, 'hazard.bin'), Buffer.from(hazard.buffer));
  fs.copyFileSync(path.join(OUT, 'grid.json'), path.join(WORK, 'grid.json'));
}

console.log(`event at T+${EVENT_TIME} min, position (${sel[0]}, ${sel[1]}), remaining [${remaining.join(', ')}]`);
console.log('dwell', dwell, 'walk-only nominal', walkOnly.total.toFixed(1), 'min');
console.log('done →', OUT);
