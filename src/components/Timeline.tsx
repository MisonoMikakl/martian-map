import type { Stop } from '../lib/playback';
import { clockAt } from '../lib/playback';
import type { Params, ScenarioEvent } from '../lib/types';
import { useT } from '../i18n';

interface Props {
  t: number;
  /** 回到居住舱的时刻（播放到这里停） */
  end: number;
  /** 时间轴的右端，固定为出舱上限 */
  axisMax: number;
  playing: boolean;
  speed: number;
  event: ScenarioEvent | null | undefined;
  stops: Stop[];
  params: Params;
  baseParams: Params;
  /** waypoints.json 里居住舱的 id */
  habId: string;
  clockStart?: string;
  onT: (t: number) => void;
  onPlay: (p: boolean) => void;
  onSpeed: (s: number) => void;
}

const SPEEDS = [2, 5, 10, 20, 40];

export default function Timeline(p: Props) {
  const { t: tr } = useT();
  const { t, end, axisMax, playing, speed, event, stops, params, baseParams, habId, clockStart, onT, onPlay, onSpeed } = p;
  const clock = clockAt(clockStart, t);
  const done = t >= end - 1e-6;

  // 位置要和滑块拇指对齐：两端各缩进半个拇指宽（8px）
  const at = (min: number) => `calc(8px + (100% - 16px) * ${Math.min(1, Math.max(0, min / axisMax))})`;
  const span = (a: number, b: number) => ({ left: at(a), width: `calc((100% - 16px) * ${Math.max(0, b - a) / axisMax})` });

  // 行走段和停留段
  const segs: { a: number; b: number; kind: 'walk' | 'dwell'; id?: string }[] = [];
  let prev = 0;
  for (const s of stops) {
    if (s.arrive > prev) segs.push({ a: prev, b: s.arrive, kind: 'walk' });
    if (s.depart > s.arrive) segs.push({ a: s.arrive, b: s.depart, kind: 'dwell', id: s.id });
    prev = s.depart;
  }
  const limit = params.eva_budget_min;
  const cut = baseParams.eva_budget_min > limit;
  const ticks: number[] = [];
  for (let m = 0; m <= axisMax + 1e-6; m += 30) ticks.push(m);

  return (
    <div className="timeline">
      <button
        className="play"
        onClick={() => {
          if (done) onT(0);
          onPlay(done ? true : !playing);
        }}
        title={`${playing ? tr('pause') : done ? tr('restart') : tr('play')} (space)`}
        aria-label={playing ? tr('pause') : tr('play')}
      >
        {playing ? '❚❚' : done ? '↺' : '▶'}
      </button>
      <div className="clock">
        <div className="t">
          T+{t.toFixed(1).padStart(5, '0')}
          <small>{tr('min')}</small>
        </div>
        {clock && <div className="sub">{clock} LMST</div>}
      </div>

      <div className="track" title="← → 1 min · Shift ×10 · Home / End">
        <div className="lanes">
          {segs.map((s, i) => (
            <span key={i} className={`seg ${s.kind} ${s.id === habId ? 'hab' : ''}`} style={span(s.a, s.b)}>
              {s.kind === 'dwell' && s.id ? s.id.replace(/^t/, '') : null}
            </span>
          ))}
          <span className="seg reserve" style={span(limit - params.reserve_min, limit)} title={tr('reserveZone')} />
          {cut && <span className="seg cut" style={span(limit, baseParams.eva_budget_min)} title={tr('cutZone')} />}
          <span className="progress" style={{ width: at(t) }} />
        </div>
        <span className="mark limit" style={{ left: at(limit) }}>
          <span>
            {tr('limit')} {limit}
          </span>
        </span>
        {event && (
          <span className="mark event" style={{ left: at(event.at_min) }}>
            <span>⚡ {event.change}</span>
          </span>
        )}
        <input
          className="scrub"
          type="range"
          min={0}
          max={axisMax}
          step={0.1}
          value={Math.min(t, axisMax)}
          onChange={(e) => onT(+e.target.value)}
          aria-label="time"
        />
        <div className="axis">
          {ticks.map((m) => (
            <span key={m} style={{ left: at(m) }}>
              {m}
            </span>
          ))}
        </div>
      </div>

      <label className="speed">
        {tr('speed')}
        <select value={speed} onChange={(e) => onSpeed(+e.target.value)}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              ×{s} {tr('perSec')}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
