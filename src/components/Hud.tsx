import { useMemo } from 'react';
import { dataUrl } from '../lib/data';
import { bearing, distanceAt, endTime, headingAt, maxSlopeAhead, positionAt, type Stop } from '../lib/playback';
import type { Grid, Params, Scenario, Waypoint } from '../lib/types';
import { useT } from '../i18n';

interface Props {
  grid: Grid;
  scenario: Scenario;
  shown: Scenario;
  stops: Stop[];
  params: Params;
  t: number;
  /** waypoints.json 里居住舱的 id */
  habId: string;
  onClose: () => void;
}

const HALF_FOV = 60;

export default function Hud({ grid, scenario, shown, stops, params, t, habId, onClose }: Props) {
  const { t: tr } = useT();
  const pos = positionAt(scenario.path, t);
  const heading = headingAt(scenario.path, pos.i);
  const end = endTime(shown);

  const cur = stops.find((s) => s.depart > t);
  const dwelling = cur && t >= cur.arrive && t < cur.depart ? cur : null;
  const nav = dwelling ? stops[stops.indexOf(dwelling) + 1] ?? null : cur ?? null;
  const lastVisited = [...stops].reverse().find((s) => s.depart <= t);

  // 照片：停留中用当前点；去目标点的路上用目标点；回舱路上用最后去过的点
  const photoWp: Waypoint | undefined = (dwelling ?? (nav && nav.id !== habId ? nav : lastVisited))?.wp;
  const photo = photoWp?.photo ? dataUrl(photoWp.photo) : null;

  const navInfo = useMemo(() => {
    if (!nav) return null;
    const dx = nav.wp.x - pos.x;
    const dy = nav.wp.y - pos.y;
    return { brg: bearing(dx, dy), dist: Math.hypot(dx, dy) * grid.res_m, eta: Math.max(0, nav.arrive - t) };
  }, [nav, pos.x, pos.y, grid.res_m, t]);

  const evaLeft = params.eva_budget_min - t;
  const backIn = Math.max(0, end - t);
  const margin = params.eva_budget_min - end;
  const d = distanceAt(scenario.profile, t);
  const steep = maxSlopeAhead(scenario.profile, d, 200);

  const warnings: { text: string; level: 'info' | 'warn' | 'alert' }[] = [];
  if (scenario.event && t >= scenario.event.at_min && t - scenario.event.at_min < 40)
    warnings.push({ text: tr('wPlanUpdated', { change: scenario.event.change }), level: 'alert' });
  if (margin < params.reserve_min) warnings.push({ text: tr('wMarginLow'), level: 'alert' });
  if (scenario.unsafeMask?.[pos.i] && t < end) warnings.push({ text: tr('wUnsafe'), level: 'alert' });
  if (t > params.eva_budget_min - params.reserve_min && t < end) warnings.push({ text: tr('wReserve'), level: 'alert' });
  if (steep >= params.max_slope_deg * 0.8 && t < end) warnings.push({ text: tr('wSteep', { deg: steep.toFixed(0) }), level: 'warn' });
  if (t >= end) warnings.push({ text: tr('wDone'), level: 'info' });

  const rel = navInfo ? ((navInfo.brg - heading + 540) % 360) - 180 : 0;

  return (
    <div className="hud" role="dialog" aria-label="HUD">
      {photo ? <img className="hud-photo" src={photo} alt="" /> : <div className="hud-photo hud-photo-empty" />}
      <div className="hud-vignette" />
      <div className="hud-scan" />
      <svg className="hud-frame" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden>
        <path d="M30 90 V30 H90 M910 30 H970 V90 M970 510 V570 H910 M90 570 H30 V510" />
        <circle cx="500" cy="300" r="26" />
        <path d="M500 262 V284 M500 316 V338 M462 300 H484 M516 300 H538" />
      </svg>

      <Compass heading={heading} rel={navInfo ? rel : null} />

      <div className="hud-block hud-left">
        {dwelling && <div className="hud-big">{tr('dwelling', { name: dwelling.wp.name })}</div>}
        {nav && navInfo && (
          <>
            <div className="hud-k">{tr('next')}</div>
            <div className="hud-big">{nav.id === habId ? tr('home') : nav.wp.name}</div>
            <div className="hud-row">
              <span>{navInfo.dist.toFixed(0)} m</span>
              <span className="hud-dim"> {tr('straight')}</span>
            </div>
            <div className="hud-row">BRG {navInfo.brg.toFixed(0).padStart(3, '0')}°</div>
            <div className="hud-row">
              {tr('eta')} {navInfo.eta.toFixed(0)} {tr('min')}
            </div>
          </>
        )}
      </div>

      <div className="hud-block hud-right">
        <div className="hud-k">{tr('evaLeft')}</div>
        <div className={`hud-big ${evaLeft < params.reserve_min ? 'hud-alert' : ''}`}>
          {Math.max(0, evaLeft).toFixed(0)} {tr('min')}
        </div>
        <div className="hud-k">{tr('planReturn')}</div>
        <div className="hud-row">
          {backIn.toFixed(0)} {tr('min')}
        </div>
        <div className="hud-k">{tr('marginLbl')}</div>
        <div className={`hud-row ${margin < params.reserve_min ? 'hud-alert' : ''}`}>
          {margin.toFixed(0)} / {params.reserve_min} {tr('min')}
        </div>
      </div>

      <div className="hud-warnings">
        {warnings.map((w, i) => (
          <div key={i} className={`hud-msg hud-${w.level}`}>
            ▲ {w.text}
          </div>
        ))}
      </div>

      <div className="hud-foot">
        T+{t.toFixed(1)} · HDG {heading.toFixed(0).padStart(3, '0')}°{!photo || grid.synthetic ? ` · ${tr('photoPlaceholder')}` : ''}
      </div>
      <button className="hud-close" onClick={onClose}>
        {tr('hudClose')} ✕
      </button>
    </div>
  );
}

function Compass({ heading, rel }: { heading: number; rel: number | null }) {
  const ticks = [];
  const start = Math.ceil((heading - HALF_FOV) / 5) * 5;
  for (let a = start; a <= heading + HALF_FOV; a += 5) {
    const x = 50 + ((a - heading) / HALF_FOV) * 50;
    const norm = ((a % 360) + 360) % 360;
    const label = norm % 90 === 0 ? 'NESW'[norm / 90] : norm % 30 === 0 ? String(norm) : null;
    ticks.push(
      <g key={a}>
        <line x1={`${x}%`} x2={`${x}%`} y1={label ? 18 : 24} y2={34} />
        {label && (
          <text x={`${x}%`} y={13} textAnchor="middle" className={norm % 90 === 0 ? 'cardinal' : ''}>
            {label}
          </text>
        )}
      </g>,
    );
  }
  const clamped = rel == null ? null : Math.max(-HALF_FOV, Math.min(HALF_FOV, rel));
  return (
    <svg className="hud-compass" viewBox="0 0 600 50" preserveAspectRatio="none" aria-hidden>
      {ticks}
      <path d="M300 36 l-6 10 h12 z" className="hud-caret-self" />
      {clamped != null && (
        <g transform={`translate(${300 + (clamped / HALF_FOV) * 300} 0)`}>
          <path d={Math.abs(rel!) > HALF_FOV ? (rel! > 0 ? 'M-8 40 l12 5 l-12 5 z' : 'M8 40 l-12 5 l12 5 z') : 'M-7 40 h14 l-7 9 z'} className="hud-caret-target" />
        </g>
      )}
    </svg>
  );
}
