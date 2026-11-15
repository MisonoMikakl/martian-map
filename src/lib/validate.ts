// 读入数据时的整理和检查。
//
// 目标：A、B、D 的真实文件和手册格式略有出入时，页面照样能显示，
// 同时把每个问题写进 warnings，在页面右上角“数据检查”里列出来。
// 只有 grid.json、waypoints.json 坏掉才算致命错误。

import type { Dataset, Env, Grid, Leg, Params, PathPoint, ProfilePoint, Scenario, ScenarioEvent, Waypoint, Waypoints } from './types';

export const DEFAULT_PARAMS: Params = { k: 0.6, alpha: 0.5, max_slope_deg: 15, eva_budget_min: 240, reserve_min: 30 };

type Warn = (msg: string) => void;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
const fin = (v: unknown) => Number.isFinite(num(v));
const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

// ---------------------------------------------------------------- grid.json

export function normalizeGrid(raw: unknown, warn: Warn): Grid | null {
  if (!isObj(raw)) return null;
  const width = num(raw.width);
  const height = num(raw.height);
  if (!(width > 0 && height > 0)) {
    warn('grid.json：width / height 无效');
    return null;
  }
  let res = num(raw.res_m);
  if (!(res > 0)) {
    warn('grid.json：缺少 res_m，按 2 米处理');
    res = 2;
  }
  let gt = Array.isArray(raw.geotransform) && raw.geotransform.length === 6 ? raw.geotransform.map(num) : null;
  if (!gt || gt.some((v) => !Number.isFinite(v))) {
    warn('grid.json：geotransform 无效，鼠标坐标里的投影坐标不可信');
    gt = [0, res, 0, 0, 0, -res];
  }
  return {
    width,
    height,
    res_m: res,
    geotransform: gt,
    crs_note: str(raw.crs_note),
    nodata: str(raw.nodata),
    synthetic: raw.synthetic === true,
  };
}

// ---------------------------------------------------------------- waypoints.json

function waypoint(raw: unknown, where: string, warn: Warn, fallbackId?: string, fallbackName?: string): Waypoint | null {
  const rawId = isObj(raw) ? (raw.id ?? fallbackId) : undefined;
  if (!isObj(raw) || rawId == null || !fin(raw.x) || !fin(raw.y)) {
    warn(`waypoints.json：${where} 缺少 id / x / y，已跳过`);
    return null;
  }
  const id = String(rawId);
  return {
    id,
    name: str(raw.name) ?? fallbackName ?? id,
    x: num(raw.x),
    y: num(raw.y),
    dwell_min: fin(raw.dwell_min) ? num(raw.dwell_min) : undefined,
    priority: fin(raw.priority) ? num(raw.priority) : undefined,
    why: str(raw.why),
    source: str(raw.source),
    photo: str(raw.photo),
  };
}

/**
 * 两种格式都接受：
 * - 手册：{ "hab": {id, x, y, …}, "targets": [{id, x, y, …}] }
 * - B 的 run_scenarios.py：{ "habitat": {x, y, …}, "waypoints": [{id, …}] 或 {"t1": {…}} }
 * 居住舱没有 id 时用 "hab"（B 的 order / legs 里居住舱就叫 hab）。
 */
export function normalizeWaypoints(raw: unknown, grid: Grid, warn: Warn): Waypoints | null {
  if (!isObj(raw)) return null;
  const hab = waypoint(raw.hab ?? raw.habitat, 'hab / habitat', warn, 'hab', 'Habitat');
  if (!hab) return null;
  const list = raw.targets ?? raw.waypoints;
  let items: [unknown, string][] = [];
  if (Array.isArray(list)) items = list.map((t, i) => [t, `targets[${i}]`]);
  else if (isObj(list)) items = Object.entries(list).map(([k, v]) => [isObj(v) && v.id == null ? { ...v, id: k } : v, k]);
  else warn('waypoints.json：没有 targets（或 B 格式的 waypoints）');
  const targets = items.map(([t, where]) => waypoint(t, where, warn)).filter((t): t is Waypoint => !!t);
  for (const p of [hab, ...targets]) {
    if (p.x < 0 || p.y < 0 || p.x >= grid.width || p.y >= grid.height)
      warn(`waypoints.json：${p.id} 的坐标 (${p.x}, ${p.y}) 在网格外。坐标应为网格像素坐标，不是经纬度`);
  }
  return { hab, targets };
}

// ---------------------------------------------------------------- env / datasets / geology

export function normalizeEnv(raw: unknown, warn: Warn): Env | null {
  if (raw == null) return null;
  if (!isObj(raw)) {
    warn('env.json：不是 JSON 对象');
    return null;
  }
  const env: Env = {
    sol: fin(raw.sol) ? num(raw.sol) : undefined,
    season_note: str(raw.season_note),
    dose_note: str(raw.dose_note),
    dust_tau: fin(raw.dust_tau) ? num(raw.dust_tau) : undefined,
    go: typeof raw.go === 'boolean' ? raw.go : undefined,
  };
  if (Array.isArray(raw.temp_c) && raw.temp_c.length === 2 && raw.temp_c.every(fin))
    env.temp_c = [num(raw.temp_c[0]), num(raw.temp_c[1])];
  else if (raw.temp_c != null) warn('env.json：temp_c 应为 [最低, 最高]');
  if (Array.isArray(raw.eva_window) && raw.eva_window.length === 2)
    env.eva_window = [String(raw.eva_window[0]), String(raw.eva_window[1])];
  else if (raw.eva_window != null) warn('env.json：eva_window 应为 ["09:00", "15:00"]');
  return env;
}

export function normalizeDatasets(raw: unknown, warn: Warn): Dataset[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warn('datasets.json：应为数组 [{ name, url, role }]');
    return [];
  }
  return raw
    .filter((d, i) => {
      const ok = isObj(d) && d.name != null;
      if (!ok) warn(`datasets.json：第 ${i + 1} 项缺少 name，已跳过`);
      return ok;
    })
    .map((d) => {
      const o = d as Obj;
      const name = String(o.name);
      let layers: string[] | undefined;
      if (Array.isArray(o.layers)) {
        layers = o.layers.map(String);
        const bad = layers.filter((k) => !LAYER_KEYS.includes(k));
        if (bad.length) warn(`datasets.json：${name} 的 layers 里有未知图层 ${bad.join(', ')}（可用：${LAYER_KEYS.join(', ')}）`);
      }
      return { name, url: str(o.url) ?? '', role: str(o.role) ?? '', layers };
    });
}

/** datasets.json 里 layers 可以引用的图层名 */
const LAYER_KEYS = ['ortho', 'hillshade', 'slope', 'thermal', 'hazard', 'geology', 'envelope', 'route'];

export function normalizeGeology(raw: unknown, warn: Warn): GeoJSON.FeatureCollection | null {
  if (raw == null) return null;
  if (!isObj(raw) || raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    warn('geology.geojson：不是 FeatureCollection，地质图层已关闭');
    return null;
  }
  return raw as unknown as GeoJSON.FeatureCollection;
}

// ---------------------------------------------------------------- scenarios/*.json

function params(raw: unknown, warn: Warn, label: string, fallback: Params): Params {
  const o = isObj(raw) ? raw : {};
  if (!isObj(raw)) warn(`没有 ${label}，按默认参数显示`);
  const out = { ...fallback };
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof Params)[]) {
    if (fin(o[k])) out[k] = num(o[k]);
    else if (isObj(raw)) warn(`${label} 缺少 ${k}，按 ${fallback[k]} 显示`);
  }
  return out;
}

const near = (p: PathPoint, w: Waypoint, tol = 1.5) => Math.hypot(p[0] - w.x, p[1] - w.y) <= tol;

/**
 * 停留的几种写法都兼容：
 * 1. 停留期间重复同一个点（[x,y,到达], [x,y,离开]）——前端默认的写法；
 * 2. 不重复，在离开路点后的下一格时间里跳过停留时长；
 * 3. 不重复，路点那一格直接写成离开时间（时间跳变在走进路点的那一步）。
 * 遇到 2、3，在时间跳变处补一个重复点，转成第 1 种。停留放在跳变两端里离路点更近的那个点上。
 */
export function fillDwell(path: PathPoint[], w: Waypoints): { path: PathPoint[]; inserted: number } {
  const steps: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const moved = path[i][0] !== path[i - 1][0] || path[i][1] !== path[i - 1][1];
    const dt = path[i][2] - path[i - 1][2];
    if (moved && dt > 0) steps.push(dt);
  }
  if (steps.length === 0) return { path, inserted: 0 };
  steps.sort((a, b) => a - b);
  const med = steps[steps.length >> 1];
  const thr = Math.max(1, med * 10);
  const all = [w.hab, ...w.targets];
  const wpDist = (p: PathPoint) => Math.min(...all.map((q) => Math.hypot(p[0] - q.x, p[1] - q.y)));
  const out: PathPoint[] = [path[0]];
  let inserted = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const moved = a[0] !== b[0] || a[1] !== b[1];
    if (moved && b[2] - a[2] > thr) {
      // b 更靠近路点：先走到 b 再停（写法 3）；否则在 a 停（写法 2）
      if (wpDist(b) < wpDist(a)) out.push([b[0], b[1], a[2] + med]);
      else out.push([a[0], a[1], b[2] - med]);
      inserted++;
    }
    out.push(b);
  }
  return { path: out, inserted };
}

export function normalizeScenario(raw: unknown, w: Waypoints, warn: Warn): Scenario | null {
  if (!isObj(raw)) {
    warn('不是 JSON 对象，已跳过');
    return null;
  }

  // path
  let path: PathPoint[] = (Array.isArray(raw.path) ? raw.path : [])
    .filter((p): p is unknown[] => Array.isArray(p) && p.length >= 3)
    .map((p) => [num(p[0]), num(p[1]), num(p[2])] as PathPoint)
    .filter((p) => p.every(Number.isFinite));
  if (path.length < 2) {
    warn('path 为空或格式不对（应为 [[x, y, 累计分钟], …]），这个场景已跳过');
    return null;
  }
  const rawLen = Array.isArray(raw.path) ? raw.path.length : 0;
  if (path.length < rawLen) warn(`path 里有 ${rawLen - path.length} 个点格式不对，已忽略`);
  if (path.some((p, i) => i > 0 && p[2] < path[i - 1][2])) {
    warn('path 的时间不是递增的，已按时间排序');
    path = [...path].sort((a, b) => a[2] - b[2]);
  }
  // 停留的几种写法都转成“重复点”。B 的写法就是不重复点，属于正常情况，不报提示。
  path = fillDwell(path, w).path;
  const startT = path[0][2];
  const endT = path[path.length - 1][2];

  const p = params(raw.params, warn, 'params', DEFAULT_PARAMS);

  // event：手册写 at_min / change，B 写 t_min / type / pos / description
  let event: ScenarioEvent | null = null;
  if (isObj(raw.event)) {
    const at = fin(raw.event.at_min) ? num(raw.event.at_min) : fin(raw.event.t_min) ? num(raw.event.t_min) : NaN;
    if (Number.isFinite(at)) {
      const pos = raw.event.pos;
      event = {
        at_min: at,
        change: str(raw.event.change) ?? str(raw.event.description) ?? str(raw.event.type) ?? '',
        type: str(raw.event.type),
        description: str(raw.event.description),
        pos: Array.isArray(pos) && pos.length >= 2 && fin(pos[0]) && fin(pos[1]) ? [num(pos[0]), num(pos[1])] : undefined,
      };
      if (isObj(raw.event.params_after)) {
        const pa: Partial<Params> = {};
        for (const k of Object.keys(DEFAULT_PARAMS) as (keyof Params)[])
          if (fin(raw.event.params_after[k])) pa[k] = num(raw.event.params_after[k]);
        event.params_after = pa;
      }
      if (at < 0 || at > endT) warn(`event 时刻 ${at} 不在路线时间范围内`);
    } else {
      warn('event 缺少 at_min（B 格式为 t_min），按没有事件处理');
    }
  }

  // B 的 order / legs 用 "START" 表示起点：从居住舱出发时就是居住舱，从事件点出发时记为 "event"；
  // B 把居住舱固定叫 "hab"，waypoints.json 里的 id 可能不同
  const startId = event && startT > 0.01 ? 'event' : w.hab.id;
  const mapId = (id: string) => (id === 'START' ? startId : id === 'hab' ? w.hab.id : id);

  // order / dropped：缺了就从 path 推出来
  const ids = new Set([w.hab.id, 'event', ...w.targets.map((t) => t.id)]);
  let order: string[];
  if (Array.isArray(raw.order) && raw.order.length >= 2) {
    order = raw.order.map((v) => mapId(String(v)));
    const unknown = order.filter((id) => !ids.has(id));
    if (unknown.length) warn(`order 里的 ${unknown.join(', ')} 在 waypoints.json 里找不到`);
  } else {
    const firsts = w.targets
      .map((t) => ({ id: t.id, i: path.findIndex((q) => near(q, t)) }))
      .filter((o) => o.i >= 0)
      .sort((a, b) => a.i - b.i)
      .map((o) => o.id);
    order = [w.hab.id, ...firsts, w.hab.id];
    warn(`没有 order，按路线经过的顺序推断为 ${order.join(' → ')}`);
  }
  let dropped: string[];
  if (Array.isArray(raw.dropped)) dropped = raw.dropped.map(String);
  else {
    dropped = w.targets.map((t) => t.id).filter((id) => !order.includes(id));
    if (raw.dropped != null || dropped.length) warn(`没有 dropped，按 order 推断为 [${dropped.join(', ')}]`);
  }

  // legs / profile / envelope_frames
  const optNum = (v: unknown) => (fin(v) ? num(v) : undefined);
  const legs: Leg[] = Array.isArray(raw.legs)
    ? raw.legs.filter(isObj).map((l) => ({
        from: mapId(String(l.from ?? '?')),
        to: mapId(String(l.to ?? '?')),
        time_min: fin(l.time_min) ? num(l.time_min) : 0,
        dist_m: fin(l.dist_m) ? num(l.dist_m) : 0,
        max_slope_deg: fin(l.max_slope_deg) ? num(l.max_slope_deg) : 0,
        arrival_min: optNum(l.arrival_min),
        dwell_min: optNum(l.dwell_min),
        departure_min: optNum(l.departure_min),
      }))
    : [];
  if (!Array.isArray(raw.legs)) warn('没有 legs，分段表为空');

  const profile: ProfilePoint[] = Array.isArray(raw.profile)
    ? raw.profile
        .filter(isObj)
        .map((q) => ({ d_m: num(q.d_m), elev_m: num(q.elev_m), slope_deg: fin(q.slope_deg) ? num(q.slope_deg) : 0, t_min: num(q.t_min) }))
        .filter((q) => Number.isFinite(q.d_m) && Number.isFinite(q.elev_m) && Number.isFinite(q.t_min))
    : [];
  if (profile.length === 0) warn('没有 profile，剖面图为空');

  const frames = Array.isArray(raw.envelope_frames)
    ? raw.envelope_frames
        .filter((f): f is Obj => isObj(f) && fin(f.t_min) && f.png != null)
        .map((f) => ({ t_min: num(f.t_min), png: String(f.png) }))
        .sort((a, b) => a.t_min - b.t_min)
    : [];
  if (frames.length === 0) warn('没有 envelope_frames，不显示安全返回范围');

  // B：超出安全返回范围的格子
  const unsafeCells = Array.isArray(raw.unsafe)
    ? raw.unsafe
        .filter((c): c is unknown[] => Array.isArray(c) && c.length >= 2 && fin(c[0]) && fin(c[1]))
        .map((c) => [num(c[0]), num(c[1])] as [number, number])
    : undefined;

  return {
    id: '',
    title: str(raw.title) ?? '',
    params: p,
    event,
    order,
    dropped: dropped.map(mapId),
    path,
    legs,
    profile,
    envelope_frames: frames,
    unsafeCells,
  };
}
