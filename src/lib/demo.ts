// 30 秒演示：按手册“30 秒视频分镜”自动驱动地图、时间和 HUD。
// demoFrame 是纯函数：给定演示开始后的秒数，返回这一刻的画面状态，
// 所以每次录出来都一样，可以反复重录。
//
//  0–5 s   图层逐层叠上（影像、地形、热惯量、地质、障碍）
//  5–12 s  路线出现，安全返回范围铺开，航天员出发
// 12–22 s  回放到中途注入事件，范围收缩、砍掉目标点、新路线出现
// 22–30 s  HUD 一闪，然后结尾字幕 + 所用 NASA 数据

import { ALL_OFF, type LayerKey, type LayerState } from './layers';
import type { Scenario } from './types';

export const DEMO_LENGTH = 30;

export type DemoPhase = 'layers' | 'plan' | 'envelope' | 'walk' | 'event' | 'hud' | 'end';

export interface DemoFrame {
  t: number;
  layers: LayerState;
  hud: boolean;
  phase: DemoPhase;
  /** 0–5 秒里最近叠上的图层，字幕里显示 */
  lastLayer: LayerKey | null;
}

/** 演示用哪个场景：优先 slow20，其次任何带事件的场景 */
export function pickDemoScenario(scenarios: Scenario[]): string {
  return (scenarios.find((s) => s.id === 'slow20') ?? scenarios.find((s) => s.event) ?? scenarios[0]).id;
}

const STACK: LayerKey[] = ['ortho', 'hillshade', 'thermal', 'geology', 'hazard'];
/** 只在叠图阶段短暂出现、下一层出来就关掉的图层，避免画面太乱 */
const TRANSIENT = new Set<LayerKey>(['thermal', 'geology']);

function interp(keys: [number, number][], s: number): number {
  if (s <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (s <= keys[i][0]) {
      const [s0, v0] = keys[i - 1];
      const [s1, v1] = keys[i];
      return s1 > s0 ? v0 + ((v1 - v0) * (s - s0)) / (s1 - s0) : v1;
    }
  }
  return keys[keys.length - 1][1];
}

export function demoFrame(s: number, scenario: Scenario, available: (k: LayerKey) => boolean): DemoFrame {
  const end = scenario.path[scenario.path.length - 1][2];
  const at = scenario.event && scenario.event.at_min > 0 && scenario.event.at_min < end ? scenario.event.at_min : null;

  // 图层：可用的底图在 0.3–4.7 秒之间均匀叠上
  const layers: LayerState = { ...ALL_OFF };
  const stack = STACK.filter(available);
  const gap = stack.length ? 4.4 / stack.length : 0;
  let lastLayer: LayerKey | null = null;
  stack.forEach((k, i) => {
    const on = 0.3 + i * gap;
    const off = TRANSIENT.has(k) ? (i + 1 < stack.length ? 0.3 + (i + 1) * gap : 4.8) : Infinity;
    if (s >= on && s < off) layers[k] = true;
    if (s >= on && s < 5) lastLayer = k;
  });
  if (s >= 5) layers.route = true;
  if (s >= 6) layers.envelope = true;

  // 时间：关键帧之间线性插值
  const keys: [number, number][] =
    at != null
      ? [
          [0, 0],
          [7, 0],
          [12, at * 0.5],
          [16, at],
          [16.8, at],
          [22, Math.max(at, end - 20)],
          [25.5, end],
          [DEMO_LENGTH, end],
        ]
      : [
          [0, 0],
          [7, 0],
          [22, Math.max(0, end - 20)],
          [25.5, end],
          [DEMO_LENGTH, end],
        ];
  const t = interp(keys, s);

  const phase: DemoPhase =
    s < 5 ? 'layers' : s < 7 ? 'plan' : s < 12 ? 'envelope' : s < (at != null ? 16 : 22) ? 'walk' : s < 22 ? 'event' : s < 25.5 ? 'hud' : 'end';

  return { t, layers, hud: phase === 'hud', phase, lastLayer };
}
