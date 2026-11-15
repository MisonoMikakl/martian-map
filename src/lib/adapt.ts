// 把 B 的场景输出整理成网页需要的样子（B 的代码不改，适配都在这里）。
//
// B 的事件场景（slow20 / dust）只包含“事件发生之后”的部分：path 从事件点、事件时刻开始，
// legs / profile / order 也一样，params 是事件后的值。网页回放需要完整的一条，
// 所以用 nominal 的前半段拼上去。手册格式（path 从 0 开始）的场景原样返回。

import type { Leg, Params, PathPoint, Scenario } from './types';
import { distanceAt } from './playback';

const PARAM_KEYS: (keyof Params)[] = ['k', 'alpha', 'max_slope_deg', 'eva_budget_min', 'reserve_min'];
const fmt = (v: number) => String(+v.toFixed(3));

/** 事件前后参数的差别，例如 “k 0.6 → 0.48” 或 “eva_budget_min 240 → 180” */
export function paramDiff(before: Params, after: Partial<Params>): { diff: Partial<Params>; text: string } {
  const diff: Partial<Params> = {};
  const parts: string[] = [];
  for (const k of PARAM_KEYS) {
    const a = after[k];
    if (a != null && Math.abs(a - before[k]) > 1e-9) {
      diff[k] = a;
      parts.push(`${k} ${fmt(before[k])} → ${fmt(a)}`);
    }
  }
  return { diff, text: parts.join(', ') };
}

/** B 的事件场景是不是只有事件之后的部分 */
export function isPartial(s: Scenario): boolean {
  return !!s.event && s.path[0][2] > 0.01;
}

export function stitchEventScenario(s: Scenario, n: Scenario, habId: string): Scenario {
  const ev = s.event!;
  const at = ev.at_min;

  // path：nominal 里 t ≤ 事件时刻的点 + B 从事件点开始的点
  const path: PathPoint[] = [...n.path.filter((p) => p[2] <= at), ...s.path];

  // legs：事件前已经走完的段（到达时间 ≤ 事件时刻）+ 事件发生时正在走的那一段的前半截 + B 的段
  const done: Leg[] = [];
  let partial: Leg | null = null;
  for (const l of n.legs) {
    if (l.arrival_min == null) continue;
    const start = l.arrival_min - l.time_min;
    if (l.arrival_min <= at) done.push(l);
    else if (start < at) {
      const d0 = distanceAt(n.profile, start);
      const d1 = distanceAt(n.profile, at);
      let maxSlope = 0;
      for (const q of n.profile) if (q.t_min >= start && q.t_min <= at) maxSlope = Math.max(maxSlope, q.slope_deg);
      partial = {
        from: l.from,
        to: 'event',
        time_min: at - start,
        dist_m: Math.max(0, d1 - d0),
        max_slope_deg: maxSlope,
        arrival_min: at,
        dwell_min: 0,
        departure_min: at,
      };
    }
  }
  // 事件发生在某个目标点停留期间时，B 的第一段是“事件点 → 该目标点”，长度为 0，只带剩余停留；原样保留
  const legs = [...done, ...(partial ? [partial] : []), ...s.legs];

  // profile：nominal 事件前的部分 + B 的部分（B 的距离从 0 重新算，接上 nominal 在事件点的距离）
  const dAt = distanceAt(n.profile, at);
  const profile = [...n.profile.filter((q) => q.t_min <= at), ...s.profile.map((q) => ({ ...q, d_m: q.d_m + dAt }))];

  // order：居住舱 + 事件前到达过的目标点 + B 的 order（去掉开头的 "event"），相邻重复的合并
  const before = done.map((l) => l.to).filter((id) => id !== habId);
  const order: string[] = [];
  for (const id of [habId, ...before, ...s.order.filter((id) => id !== 'event')]) {
    if (order[order.length - 1] !== id) order.push(id);
  }

  // params：事件前用 nominal 的，事件后用 B 写的（B 的事件场景 params 已是事件后的值）
  const { diff, text } = paramDiff(n.params, s.params);

  // 安全返回范围帧：事件前借用 nominal 的
  const frames = [...n.envelope_frames.filter((f) => f.t_min < at), ...s.envelope_frames.filter((f) => f.t_min >= at)];

  return {
    ...s,
    path,
    legs,
    profile,
    order,
    params: n.params,
    event: { ...ev, params_after: { ...diff, ...ev.params_after }, change: text || ev.change },
    envelope_frames: frames,
  };
}

/** path 每个点是否落在 unsafe 格子上；事件场景事件前的点用 nominal 的 unsafe */
export function unsafeMask(s: Scenario, n: Scenario | null): boolean[] | undefined {
  const own = s.unsafeCells;
  const pre = s.event && n ? n.unsafeCells : own;
  if (!own?.length && !pre?.length) return undefined;
  const set = (cells?: [number, number][]) => new Set((cells ?? []).map(([x, y]) => `${x},${y}`));
  const ownSet = set(own);
  const preSet = set(pre);
  const at = s.event?.at_min ?? -Infinity;
  return s.path.map(([x, y, t]) => (t < at ? preSet : ownSet).has(`${x},${y}`));
}

/**
 * 把一张安全返回范围图重新着色成网页统一的样子：半透明绿色 + 边缘描亮。
 * 用于 B 的图（B 用红色表示“来得及回舱”的区域，和网页图例相反）。
 */
export async function recolorEnvelope(src: string): Promise<string | null> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = px[i * 4 + 3] > 0 ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      if (!inside[i]) {
        px[o + 3] = 0;
        continue;
      }
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inside[i - 1] || !inside[i + 1] || !inside[i - w] || !inside[i + w];
      px[o] = 70;
      px[o + 1] = 225;
      px[o + 2] = 140;
      px[o + 3] = edge ? 235 : 34;
    }
  }
  ctx.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ? URL.createObjectURL(blob) : null;
}
