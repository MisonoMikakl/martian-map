// public/data/ 下各文件的格式，和执行手册“系统架构与接口约定”一节一一对应。
// 标了 “扩展” 的字段是前端额外支持的可选字段，没有也能正常显示。

export interface Grid {
  width: number;
  height: number;
  res_m: number;
  /** GDAL geotransform: [x0, px_w, rot, y0, rot, px_h] */
  geotransform: number[];
  crs_note?: string;
  nodata?: string;
  /** 扩展：占位数据标记，网页据此显示横幅 */
  synthetic?: boolean;
}

export interface Waypoint {
  id: string;
  name: string;
  x: number;
  y: number;
  dwell_min?: number;
  priority?: number;
  why?: string;
  source?: string;
  photo?: string;
}

export interface Waypoints {
  hab: Waypoint;
  targets: Waypoint[];
}

export interface Params {
  k: number;
  alpha: number;
  max_slope_deg: number;
  eva_budget_min: number;
  reserve_min: number;
}

export interface ScenarioEvent {
  /** 事件时刻（手册写 at_min，B 写 t_min，读入时统一成 at_min） */
  at_min: number;
  /** 一句话说明，例如 “k 0.6 → 0.48” */
  change: string;
  /** 事件之后生效的参数（例如 dust 场景缩短后的 eva_budget_min） */
  params_after?: Partial<Params>;
  /** B：事件类型（slow20 / dust）、发生位置 [x, y]、英文描述 */
  type?: string;
  pos?: [number, number];
  description?: string;
}

export interface Leg {
  from: string;
  to: string;
  /** 行走用时（不含停留） */
  time_min: number;
  dist_m: number;
  max_slope_deg: number;
  /** B：到达目标点的累计分钟、停留、离开的累计分钟 */
  arrival_min?: number;
  dwell_min?: number;
  departure_min?: number;
}

export interface ProfilePoint {
  d_m: number;
  elev_m: number;
  slope_deg: number;
  t_min: number;
}

export interface EnvelopeFrame {
  t_min: number;
  png: string;
  /** 读入后解析好的图片地址（相对 scenarios/ 的路径，或重新着色后的 blob 地址） */
  url?: string;
}

/** [x, y, 累计分钟]，x/y 是网格格子索引 */
export type PathPoint = [number, number, number];

export interface Scenario {
  id: string;
  title: string;
  params: Params;
  event?: ScenarioEvent | null;
  order: string[];
  dropped: string[];
  path: PathPoint[];
  legs: Leg[];
  profile: ProfilePoint[];
  envelope_frames: EnvelopeFrame[];
  /** B：超出安全返回范围的格子 [[x, y], …] */
  unsafeCells?: [number, number][];
  /** 读入后计算：path 每个点是否在 unsafe 格子上（和 path 一一对应） */
  unsafeMask?: boolean[];
}

export interface Env {
  sol?: number;
  season_note?: string;
  dose_note?: string;
  temp_c?: [number, number];
  dust_tau?: number;
  eva_window?: [string, string];
  go?: boolean;
}

/** 扩展：public/data/datasets.json，D 维护的 NASA 数据来源清单 */
export interface Dataset {
  name: string;
  url: string;
  role: string;
  /** 扩展：这份数据支撑哪些图层（ortho / hillshade / slope / thermal / hazard / geology / envelope / route），图层面板里显示来源 */
  layers?: string[];
}

export interface AppData {
  grid: Grid;
  waypoints: Waypoints;
  env: Env | null;
  datasets: Dataset[];
  geology: GeoJSON.FeatureCollection | null;
  scenarios: Scenario[];
  /** 每个栅格图层文件是否存在 */
  rasters: Record<string, boolean>;
  /** 数据检查发现的问题，显示在页面右上角 */
  warnings: string[];
}
