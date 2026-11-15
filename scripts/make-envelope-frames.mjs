// 安全返回范围逐帧图（C 的离线脚本，在 B 跑完之后运行）。
//
// B 每个场景只输出一张安全返回范围图（事件时刻那一张，红色），网页回放时范围不会收缩。
// 这个脚本用和 B 的 build_graph.py 完全相同的规则，重算“每一格走回居住舱要多久”，
// 每 10 分钟（再加上事件时刻）写一帧绿色半透明 PNG，并写一个清单 envelope.json。
// 网页发现清单就用这些帧；没有清单时退回到 B 的那一张图。
// 只读文件，只写 public/data/scenarios/envelope/ 和 envelope.json，不改 B 的任何输出。
//
// 判断规则（和 B 的 save_png_frame 一致）：回舱时间 ≤ (出舱上限 − 预留 − 当前时刻)。
// 事件场景：事件前用 nominal 的参数，事件后用本场景 JSON 里的参数（B 写的是事件后的值）。
//
// 输入：public/data/grid.json、waypoints.json（手册格式或 B 的格式都行）、
//       scenarios/{nominal,slow20,dust}.json，以及 A 的 elevation.bin / rough.bin / hazard.bin
//       （先找 work/，再找 public/data/）
// 用法：npm run envelope    （可选参数：--data public/data --work work --step 10）

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const DATA = path.resolve(args.data ?? 'public/data');
const WORK = path.resolve(args.work ?? 'work');
const STEP = Number(args.step ?? 10);
const SCEN = path.join(DATA, 'scenarios');
const OUTDIR = path.join(SCEN, 'envelope');
const IDS = ['nominal', 'slow20', 'dust'];

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- 输入

const grid = readJson(path.join(DATA, 'grid.json'));
const W = Number(grid.width);
const H = Number(grid.height);
const RES = Number(grid.res_m);
const N = W * H;

function readBin(name, Type) {
  const file = [path.join(WORK, name), path.join(DATA, name)].find((p) => fs.existsSync(p));
  if (!file) fail(`找不到 ${name}（在 ${WORK} 或 ${DATA}）`);
  const buf = fs.readFileSync(file);
  const arr = new Type(new Uint8Array(buf).buffer); // 复制一份，保证对齐；x86 / ARM 都是小端
  if (arr.length !== N) fail(`${name} 有 ${arr.length} 个值，应为 ${W}×${H}=${N}`);
  return arr;
}
const elev = readBin('elevation.bin', Float32Array);
const rough = readBin('rough.bin', Float32Array);
const hazard = readBin('hazard.bin', Uint8Array);

const wpRaw = readJson(path.join(DATA, 'waypoints.json'));
const habRaw = wpRaw.hab ?? wpRaw.habitat;
if (!habRaw || !Number.isFinite(Number(habRaw.x)) || !Number.isFinite(Number(habRaw.y))) fail('waypoints.json 里没有 hab / habitat 坐标');
const habCell = Math.floor(Number(habRaw.y)) * W + Math.floor(Number(habRaw.x));

const scenarios = {};
for (const id of IDS) {
  const p = path.join(SCEN, `${id}.json`);
  if (!fs.existsSync(p)) continue;
  const s = readJson(p);
  if (s.error) {
    console.warn(`! ${id}.json 带 error，跳过：${s.error}`);
    continue;
  }
  scenarios[id] = s;
}
if (!scenarios.nominal) fail('缺少 scenarios/nominal.json');

// ---------------------------------------------------------------- 图（照 B 的 build_graph.py）

const valid = new Uint8Array(N);
for (let i = 0; i < N; i++) valid[i] = hazard[i] !== 1 && Number.isFinite(elev[i]) && Number.isFinite(rough[i]) && rough[i] >= 0 ? 1 : 0;

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** u→v 一步的秒数；不可走返回 Infinity */
function edgeSec(ux, uy, vx, vy, P) {
  const u = uy * W + ux;
  const v = vy * W + vx;
  if (!valid[u] || !valid[v]) return Infinity;
  const diag = ux !== vx && uy !== vy;
  if (diag && (!valid[uy * W + vx] || !valid[vy * W + ux])) return Infinity; // 不准切角
  const dist = diag ? RES * Math.SQRT2 : RES;
  const g = (elev[v] - elev[u]) / dist;
  if ((Math.atan(Math.abs(g)) * 180) / Math.PI > P.max_slope_deg) return Infinity;
  const vT = 6 * Math.exp(-3.5 * Math.abs(g + 0.05));
  const sec = (dist / 1000 / (P.k * vT)) * 3600 * (1 + P.alpha * rough[v]);
  return Number.isFinite(sec) && sec > 0 ? sec : Infinity;
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

/** 每一格走回居住舱的秒数（在转置图上从居住舱跑 Dijkstra，和 B 的 get_return_field 相同） */
function returnField(P) {
  const dist = new Float64Array(N).fill(Infinity);
  const heap = new Heap();
  dist[habCell] = 0;
  heap.push(0, habCell);
  while (heap.n > 0) {
    const v = heap.pop();
    const dv = heap.topK;
    if (dv > dist[v]) continue;
    const vx = v % W;
    const vy = (v - vx) / W;
    for (let d = 0; d < 8; d++) {
      const ux = vx + DX[d];
      const uy = vy + DY[d];
      if (ux < 0 || uy < 0 || ux >= W || uy >= H) continue;
      const c = edgeSec(ux, uy, vx, vy, P); // 边 u→v
      if (c === Infinity) continue;
      const u = uy * W + ux;
      const nd = dv + c;
      if (nd < dist[u]) {
        dist[u] = nd;
        heap.push(nd, u);
      }
    }
  }
  return dist;
}

const fields = new Map();
function fieldFor(P) {
  const key = `${P.k}|${P.alpha}|${P.max_slope_deg}`;
  if (!fields.has(key)) {
    const t0 = Date.now();
    fields.set(key, returnField(P));
    console.log(`  return field k=${P.k} α=${P.alpha} max=${P.max_slope_deg}° (${Date.now() - t0} ms)`);
  }
  return { key, field: fields.get(key) };
}

// ---------------------------------------------------------------- 帧

function writeFrame(file, field, remainSec) {
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = field[i] <= remainSec ? 1 : 0;
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!inside[i]) continue;
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !inside[i - 1] || !inside[i + 1] || !inside[i - W] || !inside[i + W];
      const o = i * 4;
      png.data[o] = 70;
      png.data[o + 1] = 225;
      png.data[o + 2] = 140;
      png.data[o + 3] = edge ? 235 : 34;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const paramsOf = (p, base) => ({
  k: num(p?.k, base.k),
  alpha: num(p?.alpha, base.alpha),
  max_slope_deg: num(p?.max_slope_deg, base.max_slope_deg),
  eva_budget_min: num(p?.eva_budget_min, base.eva_budget_min),
  reserve_min: num(p?.reserve_min, base.reserve_min),
});
const DEFAULTS = { k: 0.6, alpha: 0.5, max_slope_deg: 15, eva_budget_min: 240, reserve_min: 30 };

fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });

const nominalP = paramsOf(scenarios.nominal.params, DEFAULTS);
const T_END = nominalP.eva_budget_min;
const written = new Map(); // 同样的参数 + 时刻只写一次，几个场景共用
const manifest = { generated_by: 'scripts/make-envelope-frames.mjs', step_min: STEP, frames: {} };

for (const [id, s] of Object.entries(scenarios)) {
  const ev = s.event ?? null;
  const at = ev ? num(ev.at_min ?? ev.t_min, null) : null;
  // B 的事件场景 params 已是事件后的值；手册格式则是 params + params_after
  const afterP = ev ? paramsOf({ ...s.params, ...(ev.params_after ?? {}) }, nominalP) : null;
  const beforeP = ev ? (ev.params_after ? paramsOf(s.params, nominalP) : nominalP) : paramsOf(s.params, nominalP);
  const times = new Set();
  for (let t = 0; t <= T_END + 1e-9; t += STEP) times.add(+t.toFixed(3));
  if (at != null) times.add(at);
  const list = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const P = at != null && t >= at ? afterP : beforeP;
    const { key, field } = fieldFor(P);
    const remain = (P.eva_budget_min - P.reserve_min - t) * 60;
    const wkey = `${key}|${P.eva_budget_min}|${P.reserve_min}|${t}`;
    let name = written.get(wkey);
    if (!name) {
      name = `envelope/${id}_${String(Math.round(t * 10)).padStart(4, '0')}.png`;
      writeFrame(path.join(SCEN, name), field, remain);
      written.set(wkey, name);
    }
    list.push({ t_min: t, png: name });
  }
  manifest.frames[id] = list;
  console.log(`${id.padEnd(8)} ${list.length} frames${at != null ? ` (event at T+${at})` : ''}`);
}

fs.writeFileSync(path.join(SCEN, 'envelope.json'), JSON.stringify(manifest, null, 2));
console.log(`done → ${written.size} PNGs in ${OUTDIR}`);
