import type { AppData, EnvelopeFrame, Scenario } from './types';
import {
  normalizeDatasets,
  normalizeEnv,
  normalizeGeology,
  normalizeGrid,
  normalizeScenario,
  normalizeWaypoints,
} from './validate';
import { isPartial, recolorEnvelope, stitchEventScenario, unsafeMask } from './adapt';

export const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
export const dataUrl = (p: string) => DATA_BASE + p;

/** 三个场景的文件名固定，见手册文件清单（B 的 scenarios.json 也是这三个） */
export const SCENARIO_IDS = ['nominal', 'slow20', 'dust'] as const;

/** 栅格图层。hazard.png 是前端额外需要的显示文件（扩展），由 hazard.bin 导出 */
export const RASTER_LAYERS = [
  { id: 'ortho', file: 'ortho.png', opacity: 1, on: true },
  { id: 'hillshade', file: 'hillshade.png', opacity: 0.5, on: false, blend: 'multiply' },
  { id: 'slope', file: 'slope.png', opacity: 0.55, on: false },
  { id: 'thermal', file: 'thermal.png', opacity: 0.6, on: false },
  { id: 'hazard', file: 'hazard.png', opacity: 0.85, on: true },
] as const;

/** 缺失或不是合法 JSON 都返回 undefined；文件存在但内容是 null 返回 null */
async function getJson(p: string): Promise<unknown> {
  try {
    const r = await fetch(dataUrl(p), { cache: 'no-cache' });
    if (!r.ok) return undefined;
    return await r.json();
  } catch {
    return undefined; // 文件缺失时开发服务器可能返回 index.html，解析失败也当缺失
  }
}

export function probeImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

export class DataError extends Error {}

/** C 的 scripts/make-envelope-frames.mjs 写的逐帧清单 */
function readManifest(raw: unknown): Record<string, EnvelopeFrame[]> | null {
  if (!raw || typeof raw !== 'object') return null;
  const frames = (raw as { frames?: unknown }).frames;
  if (!frames || typeof frames !== 'object') return null;
  const out: Record<string, EnvelopeFrame[]> = {};
  for (const [id, list] of Object.entries(frames as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    out[id] = list
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .filter((f) => Number.isFinite(Number(f.t_min)) && typeof f.png === 'string')
      .map((f) => ({ t_min: Number(f.t_min), png: String(f.png) }))
      .sort((a, b) => a.t_min - b.t_min);
  }
  return out;
}

export async function loadAll(): Promise<AppData> {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const [gridRaw, wpRaw, envRaw, dsRaw, geoRaw, manifestRaw, ...scRaw] = await Promise.all([
    getJson('grid.json'),
    getJson('waypoints.json'),
    getJson('env.json'),
    getJson('datasets.json'),
    getJson('geology.geojson'),
    getJson('scenarios/envelope.json'),
    ...SCENARIO_IDS.map((id) => getJson(`scenarios/${id}.json`)),
  ]);

  const grid = gridRaw === undefined ? null : normalizeGrid(gridRaw, warn);
  if (!grid) throw new DataError('grid.json');
  const waypoints = wpRaw === undefined ? null : normalizeWaypoints(wpRaw, grid, warn);
  if (!waypoints) throw new DataError('waypoints.json');

  if (envRaw === undefined) warn('缺少 env.json，不显示出舱窗口');
  if (dsRaw === undefined) warn('缺少 datasets.json，不显示 NASA 数据清单');
  if (geoRaw === undefined) warn('缺少 geology.geojson，地质图层不可用');

  // ---- 场景：逐个整理
  let scenarios: Scenario[] = [];
  SCENARIO_IDS.forEach((id, i) => {
    const raw = scRaw[i];
    if (raw === undefined) {
      warn(`缺少 scenarios/${id}.json，或不是合法 JSON`);
      return;
    }
    const err = raw && typeof raw === 'object' ? (raw as { error?: unknown }).error : undefined;
    if (err) {
      warn(`${id}.json：B 规划失败，这个场景不显示（${String(err)}）`);
      return;
    }
    const s = normalizeScenario(raw, waypoints, (m) => warn(`${id}.json：${m}`));
    if (s) scenarios.push({ ...s, id, title: s.title || id });
  });

  // ---- B 的事件场景只有事件之后的部分：用 nominal 拼成完整的一条
  const nominal = scenarios.find((s) => s.id === 'nominal') ?? null;
  scenarios = scenarios.map((s) => {
    if (!isPartial(s)) return s;
    if (!nominal) {
      warn(`${s.id}.json：只有事件之后的路线，缺少 nominal.json，事件前的部分无法显示`);
      return s;
    }
    return stitchEventScenario(s, nominal, waypoints.hab.id);
  });
  if (!nominal && scenarios.some((s) => s.event))
    warn('缺少 nominal 场景：事件场景里“原计划 / 放弃的路线”无法显示');
  for (const s of scenarios) s.unsafeMask = unsafeMask(s, nominal);

  // ---- 安全返回范围：优先用 C 的逐帧清单；没有就用 B 的图（重新着色成绿色）
  const manifest = readManifest(manifestRaw);
  if (manifest) {
    for (const s of scenarios) if (manifest[s.id]?.length) s.envelope_frames = manifest[s.id];
  }
  for (const s of scenarios) for (const f of s.envelope_frames) f.url = dataUrl(`scenarios/${f.png}`);
  const bStyle = !manifest && scenarios.every((s) => s.envelope_frames.length <= 2);
  if (bStyle) {
    const cache = new Map<string, Promise<string | null>>();
    await Promise.all(
      scenarios.flatMap((s) =>
        s.envelope_frames.map(async (f) => {
          if (!cache.has(f.url!)) cache.set(f.url!, recolorEnvelope(f.url!));
          const u = await cache.get(f.url!)!;
          if (u) f.url = u;
        }),
      ),
    );
  }

  const found = await Promise.all([
    ...RASTER_LAYERS.map((l) => probeImage(dataUrl(l.file))),
    ...scenarios.map((s) => (s.envelope_frames.length ? probeImage(s.envelope_frames[0].url!) : Promise.resolve(true))),
  ]);
  const rasters = Object.fromEntries(RASTER_LAYERS.map((l, i) => [l.id, found[i]]));
  RASTER_LAYERS.forEach((l, i) => {
    if (!found[i]) warn(`缺少 ${l.file}，图层不可用`);
  });
  scenarios.forEach((s, i) => {
    if (!found[RASTER_LAYERS.length + i])
      warn(`${s.id}.json：安全返回范围图片 ${s.envelope_frames[0].png} 加载失败（图片应和场景 JSON 放在同一个文件夹）`);
  });

  const env = envRaw === undefined ? null : normalizeEnv(envRaw, warn);
  const datasets = normalizeDatasets(dsRaw, warn);
  const geology = normalizeGeology(geoRaw, warn);

  for (const w of warnings) console.warn('[Martian Map 数据检查]', w);

  return { grid, waypoints, env, datasets, geology, scenarios, rasters, warnings };
}
