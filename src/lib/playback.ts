import type { Params, PathPoint, ProfilePoint, Scenario, Waypoint, Waypoints } from './types';

/** path 里最后一个 t ≤ 给定时间的下标（path 按时间递增） */
export function indexAt(path: PathPoint[], t: number): number {
  let lo = 0;
  let hi = path.length - 1;
  if (t <= path[0][2]) return 0;
  if (t >= path[hi][2]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path[mid][2] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** t 时刻航天员所在的格子坐标（连续值，按累计分钟线性插值） */
export function positionAt(path: PathPoint[], t: number): { x: number; y: number; i: number } {
  const i = indexAt(path, t);
  const a = path[i];
  const b = path[Math.min(i + 1, path.length - 1)];
  const span = b[2] - a[2];
  const f = span > 0 ? Math.min(1, Math.max(0, (t - a[2]) / span)) : 0;
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, i };
}

/** 行进方向（度，0 = 北/上，90 = 东/右），停留时沿用上一段的方向 */
export function headingAt(path: PathPoint[], i: number): number {
  for (let j = Math.min(i + 1, path.length - 1); j > 0; j--) {
    const dx = path[j][0] - path[j - 1][0];
    const dy = path[j][1] - path[j - 1][1];
    if (dx !== 0 || dy !== 0) return bearing(dx, dy);
  }
  return 0;
}

export function bearing(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

export function eventActive(s: Scenario, t: number): boolean {
  return !!s.event && t >= s.event.at_min;
}

/** t 时刻生效的参数：事件之后叠加 params_after */
export function paramsAt(s: Scenario, t: number): Params {
  if (s.event && t >= s.event.at_min && s.event.params_after) return { ...s.params, ...s.event.params_after };
  return s.params;
}

export function endTime(s: Scenario): number {
  return s.path[s.path.length - 1][2];
}

/** t 时刻该显示的安全返回范围图（读入时已解析好的地址） */
export function frameAt(s: Scenario, t: number): string | null {
  let best: string | null = null;
  for (const f of s.envelope_frames) {
    if (f.t_min <= t + 1e-6) best = f.url ?? f.png;
    else break;
  }
  return best;
}

export interface Stop {
  id: string;
  wp: Waypoint;
  arrive: number;
  depart: number;
}

export function waypointById(w: Waypoints, id: string): Waypoint | undefined {
  return id === w.hab.id ? w.hab : w.targets.find((t) => t.id === id);
}

/**
 * 按 order 在 path 上找每个路点的到达和离开时间。
 * 先找到第一段落在路点 1.5 格以内的连续点，再取其中离路点最近的那几个点：
 * 第一个的时间是到达，最后一个的时间是离开（停留期间 path 会重复同一个点）。
 */
export function scheduleOf(s: Scenario, w: Waypoints): Stop[] {
  const stops: Stop[] = [];
  const P = s.path;
  const TOL = 1.5;
  let from = 0;
  for (const id of s.order.slice(1)) {
    const wp = waypointById(w, id);
    if (!wp) continue;
    const dist = (k: number) => Math.hypot(P[k][0] - wp.x, P[k][1] - wp.y);
    let j = from;
    while (j < P.length && dist(j) > TOL) j++;
    if (j >= P.length) continue;
    let end = j;
    while (end + 1 < P.length && dist(end + 1) <= TOL) end++;
    let best = Infinity;
    for (let k = j; k <= end; k++) best = Math.min(best, dist(k));
    let first = -1;
    let last = -1;
    for (let k = j; k <= end; k++) {
      if (dist(k) <= best + 1e-9) {
        if (first < 0) first = k;
        last = k;
      }
    }
    stops.push({ id, wp, arrive: P[first][2], depart: P[last][2] });
    from = last + 1;
  }
  return stops;
}

/** 剖面上 t 时刻对应的累计距离 */
export function distanceAt(profile: ProfilePoint[], t: number): number {
  if (profile.length === 0) return 0;
  if (t <= profile[0].t_min) return profile[0].d_m;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (t <= b.t_min) {
      const span = b.t_min - a.t_min;
      return span > 0 ? a.d_m + ((b.d_m - a.d_m) * (t - a.t_min)) / span : b.d_m;
    }
  }
  return profile[profile.length - 1].d_m;
}

/** 剖面上距离 d 处的时间、高程、坡度（相邻两点线性插值），供剖面图悬停联动地图 */
export function profileAt(profile: ProfilePoint[], d: number): { t: number; elev: number; slope: number } | null {
  if (profile.length === 0) return null;
  if (d <= profile[0].d_m) return { t: profile[0].t_min, elev: profile[0].elev_m, slope: profile[0].slope_deg };
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (d <= b.d_m) {
      const f = b.d_m > a.d_m ? (d - a.d_m) / (b.d_m - a.d_m) : 0;
      return {
        t: a.t_min + (b.t_min - a.t_min) * f,
        elev: a.elev_m + (b.elev_m - a.elev_m) * f,
        slope: a.slope_deg + (b.slope_deg - a.slope_deg) * f,
      };
    }
  }
  const z = profile[profile.length - 1];
  return { t: z.t_min, elev: z.elev_m, slope: z.slope_deg };
}

/** 前方 ahead_m 米内的最大坡度 */
export function maxSlopeAhead(profile: ProfilePoint[], d: number, ahead_m: number): number {
  let m = 0;
  for (const p of profile) if (p.d_m >= d && p.d_m <= d + ahead_m) m = Math.max(m, p.slope_deg);
  return m;
}

/** “09:00” + 分钟 → “10:35” */
export function clockAt(start: string | undefined, t: number): string | null {
  if (!start) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(start);
  if (!m) return null;
  const total = Math.round(+m[1] * 60 + +m[2] + t);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
