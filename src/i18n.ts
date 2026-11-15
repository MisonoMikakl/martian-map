import { createContext, useContext } from 'react';

// 界面文字。数据里的文字（路点名、科学理由、场景标题）按 JSON 原样显示。
const en = {
  appTitle: 'Martian Map',
  appSubtitle: 'EVA planning & replay · Gale crater',
  code: 'Code',
  synthetic: 'PLACEHOLDER DATA — synthetic terrain, not real NASA data',
  loading: 'Loading data…',
  loadError: 'Could not load {file} from public/data/.',
  noScenarios: 'No scenarios found in public/data/scenarios/.',

  layers: 'Layers',
  ortho: 'Orthoimage',
  hillshade: 'Hillshade',
  slope: 'Slope',
  thermal: 'Daytime thermal IR (qualitative)',
  hazard: 'Hazards',
  geology: 'Derived terrain classes',
  envelope: 'Safe-return envelope',
  route: 'Route',
  missing: 'missing',

  legendPlanned: 'Planned',
  legendTraveled: 'Walked',
  legendNew: 'Re-planned',
  legendOld: 'Abandoned plan',
  envelopeNote: 'Green area: starting from here you can still walk back to the habitat before the time limit (minus reserve). Walking there is not included.',

  scenario: 'Scenario',
  order: 'Visit order',
  dropped: 'Dropped',
  none: 'none',
  totalTime: 'Back at habitat',
  distance: 'Distance',
  margin: 'Margin at return',
  params: 'Assumptions',
  pK: 'Suit speed factor k',
  pAlpha: 'Roughness penalty α',
  pSlope: 'Max slope',
  pBudget: 'EVA limit',
  pReserve: 'Reserve',
  afterEvent: 'after event',

  legs: 'Legs',
  leg: 'Leg',
  time: 'Time',
  maxSlope: 'Max slope',
  eventPoint: 'event',

  profile: 'Elevation profile',
  elevation: 'Elevation',
  dist: 'Distance',

  env: 'EVA window',
  sol: 'Sol',
  temp: 'Temperature',
  dust: 'Dust opacity τ',
  dose: 'Radiation',
  window: 'Window',
  go: 'GO',
  nogo: 'NO-GO',

  datasets: 'NASA data used',

  play: 'Play',
  pause: 'Pause',
  restart: 'Restart',
  speed: 'Speed',
  perSec: 'min/s',

  eventTitle: 'Event at T+{t} min',
  eventDropped: 'Re-planned from current position — dropped {ids}',
  eventKept: 'Re-planned from current position — all targets kept',

  hud: 'HUD',
  hudClose: 'Close',
  next: 'NEXT',
  home: 'HABITAT',
  straight: 'straight-line',
  eta: 'ETA',
  evaLeft: 'EVA LEFT',
  planReturn: 'BACK IN',
  marginLbl: 'MARGIN',
  dwelling: 'AT {name}',
  wPlanUpdated: 'PLAN UPDATED: {change}',
  wMarginLow: 'RETURN MARGIN BELOW RESERVE',
  wSteep: 'STEEP AHEAD {deg}°',
  wReserve: 'USING RESERVE TIME',
  wDone: 'EVA COMPLETE',
  photoPlaceholder: 'placeholder photo',

  dwell: 'Dwell',
  priority: 'Priority',
  source: 'Source',
  min: 'min',

  baseline: 'baseline · no disruption',
  reserveZone: 'reserve',
  cutZone: 'lost',
  limit: 'limit',
  legend: 'Legend',
  site: 'Site',
  computedFrom: 'from',

  scen_nominal: 'Nominal plan',
  scen_slow20: 'Walking 20% slower than planned',
  scen_dust: 'Dust storm: EVA cut short',
  legendUnsafe: 'Can’t get back in time',
  cutShort: 'stop cut short',
  wUnsafe: 'OUTSIDE SAFE-RETURN RANGE',
  footer: 'Routes, timelines and envelopes are computed offline in Python on NASA terrain data. This page only replays them.',

  demo: 'Demo',
  demoExit: 'Exit demo (Esc)',
  demoReplay: 'Replay',
  demo1: 'Sol {sol} EVA · two astronauts, {n} science targets',
  demo1b: 'EVA · two astronauts, {n} science targets',
  demo2: 'One travel-time map → route, schedule and safe-return envelope',
  demo3: 'Green = from here the crew can still get home in time',
  demo4a: 'Replay: the crew heads out',
  demo4: '{title} → re-planned from where they stand',
  demo5: 'Helmet HUD: next target, time left, return margin',
  endTag: 'Metre-scale EVA routes with a safe-return envelope, re-planned the moment things go wrong.',
  endData: 'Built on NASA data',

  dataCheck: 'Data check',
  dataCheckHint: 'Problems found while reading public/data/. Fix them before submitting — this badge should not appear in the final site.',
  crash: 'This part of the page failed to render',
  crashHint: 'Most likely a problem in this scenario’s data file. Switch to another scenario:',
};

type Dict = typeof en;

const zh: Dict = {
  appTitle: 'Martian Map',
  appSubtitle: '出舱规划与回放 · Gale 撞击坑',
  code: '代码',
  synthetic: '占位数据：合成地形，不是真实 NASA 数据',
  loading: '正在加载数据…',
  loadError: '无法从 public/data/ 读取 {file}。',
  noScenarios: 'public/data/scenarios/ 里没有场景文件。',

  layers: '图层',
  ortho: '正射影像',
  hillshade: '山体阴影',
  slope: '坡度',
  thermal: '昼间热红外（定性）',
  hazard: '障碍',
  geology: '推导地貌分类',
  envelope: '安全返回范围',
  route: '路线',
  missing: '缺失',

  legendPlanned: '计划路线',
  legendTraveled: '已走',
  legendNew: '新路线',
  legendOld: '放弃的路线',
  envelopeNote: '绿色区域：从这里出发，扣除预留后仍来得及走回居住舱。不包含走到那里的时间。',

  scenario: '场景',
  order: '访问顺序',
  dropped: '放弃',
  none: '无',
  totalTime: '回到居住舱',
  distance: '总距离',
  margin: '回舱时余量',
  params: '参数假设',
  pK: '宇航服速度系数 k',
  pAlpha: '粗糙度惩罚 α',
  pSlope: '坡度上限',
  pBudget: '出舱上限',
  pReserve: '预留',
  afterEvent: '事件后',

  legs: '分段',
  leg: '路段',
  time: '用时',
  maxSlope: '最大坡度',
  eventPoint: '事件点',

  profile: '高程剖面',
  elevation: '高程',
  dist: '距离',

  env: '出舱窗口',
  sol: '火星日',
  temp: '气温',
  dust: '尘埃光学厚度 τ',
  dose: '辐射',
  window: '窗口',
  go: '可出舱',
  nogo: '不可出舱',

  datasets: '所用 NASA 数据',

  play: '播放',
  pause: '暂停',
  restart: '重来',
  speed: '速度',
  perSec: '分钟/秒',

  eventTitle: '第 {t} 分钟发生事件',
  eventDropped: '从当前位置重新规划，放弃 {ids}',
  eventKept: '从当前位置重新规划，保留全部目标点',

  hud: 'HUD',
  hudClose: '关闭',
  next: '下一站',
  home: '居住舱',
  straight: '直线',
  eta: '预计到达',
  evaLeft: '出舱剩余',
  planReturn: '回舱还需',
  marginLbl: '余量',
  dwelling: '正在 {name}',
  wPlanUpdated: '计划已更新：{change}',
  wMarginLow: '返回余量低于预留',
  wSteep: '前方坡度 {deg}°',
  wReserve: '正在使用预留时间',
  wDone: '出舱结束',
  photoPlaceholder: '占位照片',

  dwell: '停留',
  priority: '优先级',
  source: '依据',
  min: '分钟',

  baseline: '基准 · 无意外',
  reserveZone: '预留',
  cutZone: '被削减',
  limit: '上限',
  legend: '图例',
  site: '地点',
  computedFrom: '算自',

  scen_nominal: '按计划执行',
  scen_slow20: '行进比计划慢 20%',
  scen_dust: '尘暴：出舱时间缩短',
  legendUnsafe: '来不及回舱',
  cutShort: '停留中途结束',
  wUnsafe: '已超出安全返回范围',
  footer: '路线、时间表和安全返回范围都在 Python 里用 NASA 地形数据离线算好，网页只负责回放。',

  demo: '演示',
  demoExit: '退出演示（Esc）',
  demoReplay: '重播',
  demo1: '第 {sol} 个火星日出舱 · 两名航天员，{n} 个科学目标',
  demo1b: '出舱 · 两名航天员，{n} 个科学目标',
  demo2: '一张“每格要走多久”的时间图 → 路线、时间表、安全返回范围',
  demo3: '绿色 = 从这里出发仍来得及回舱',
  demo4a: '回放：航天员出发',
  demo4: '{title} → 从当前位置重新规划',
  demo5: '头盔 HUD：下一站、剩余时间、返回余量',
  endTag: '米级出舱路线 + 安全返回范围，意外一发生就重新规划。',
  endData: '基于 NASA 数据',

  dataCheck: '数据检查',
  dataCheckHint: '读取 public/data/ 时发现的问题。提交前请处理掉，正式网站上不应出现这个标记。',
  crash: '这部分页面渲染出错',
  crashHint: '多半是这个场景的数据文件有问题。可以先切换到其他场景：',
};

export type Lang = 'en' | 'zh';
export type Key = keyof Dict;
const dicts: Record<Lang, Dict> = { en, zh };

export type T = (key: Key, vars?: Record<string, string | number>) => string;

export function makeT(lang: Lang): T {
  return (key, vars) => {
    let s = dicts[lang][key];
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  };
}

/** 三个已知场景用界面语言的标题，其他场景用数据里的 title（B 的标题是中文） */
export function scenarioTitle(s: { id: string; title: string }, t: T): string {
  if (s.id === 'nominal') return t('scen_nominal');
  if (s.id === 'slow20') return t('scen_slow20');
  if (s.id === 'dust') return t('scen_dust');
  return s.title;
}

/** 数字显示：最多 3 位小数，去掉多余的 0（0.6 × 0.8 = 0.48000000000000004 显示为 0.48） */
export const fmtNum = (v: number) => String(+v.toFixed(3));

export const LangContext = createContext<{ lang: Lang; t: T }>({ lang: 'en', t: makeT('en') });
export const useT = () => useContext(LangContext);
