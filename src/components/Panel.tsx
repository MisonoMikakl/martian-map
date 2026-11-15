import type { CSSProperties } from 'react';
import type { AppData, Params, Scenario } from '../lib/types';
import { endTime, type Stop } from '../lib/playback';
import { fmtNum, scenarioTitle, useT, type Key } from '../i18n';
import ProfileChart from './ProfileChart';

interface Props {
  data: AppData;
  scenario: Scenario;
  /** 当前显示的计划：事件前是 nominal，事件后是本场景 */
  shown: Scenario;
  stops: Stop[];
  params: Params;
  t: number;
  onScenario: (id: string) => void;
  profileD: number;
  eventD: number | null;
  onProfileHover: (d: number | null) => void;
}

const TONE: Record<string, string> = { nominal: 'var(--env)', slow20: 'var(--warn)', dust: 'var(--alert)' };

export default function Panel({ data, scenario, shown, stops, params, t, onScenario, profileD, eventD, onProfileHover }: Props) {
  const { t: tr } = useT();
  const hab = data.waypoints.hab;
  const name = (id: string) =>
    id === 'event' ? tr('eventPoint') : id === hab.id ? hab.name : data.waypoints.targets.find((w) => w.id === id)?.name ?? id;
  const short = (id: string) => (id === hab.id ? 'H' : id === 'event' ? '⚡' : id.replace(/^t/, ''));

  const end = endTime(shown);
  const dist = shown.legs.reduce((s, l) => s + l.dist_m, 0);
  const margin = params.eva_budget_min - end;

  // 每一段路的起止时间：B 给了到达时间就直接用；否则按顺序累加，段与段之间隔着目标点的停留
  let start = 0;
  const windows = shown.legs.map((l) => {
    if (l.arrival_min != null) {
      start = l.departure_min ?? l.arrival_min;
      return { a: l.arrival_min - l.time_min, b: l.arrival_min };
    }
    const w = { a: start, b: start + l.time_min };
    const st = stops.find((s) => s.id === l.to && Math.abs(s.arrive - w.b) < 2);
    start = w.b + (st ? st.depart - st.arrive : 0);
    return w;
  });

  return (
    <aside className="panel">
      <section>
        <h3>{tr('scenario')}</h3>
        <div className="scen">
          {data.scenarios.map((s, i) => (
            <button key={s.id} className={s.id === scenario.id ? 'on' : ''} onClick={() => onScenario(s.id)}>
              <span className="tone" style={{ background: TONE[s.id] ?? 'var(--dim)', boxShadow: `0 0 8px ${TONE[s.id] ?? 'transparent'}` }} />
              <span>
                <div className="title">{scenarioTitle(s, tr)}</div>
                <div className="desc">{s.event ? `⚡ T+${fmtNum(s.event.at_min)} · ${s.event.change}` : tr('baseline')}</div>
              </span>
              <kbd>{i + 1}</kbd>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="order">
          <span className="lbl">{tr('order')}</span>
          {shown.order.map((id, i) => (
            <span key={i} className="order-item">
              {i > 0 && <span className="arrow">→</span>}
              <span className={`chip ${id === hab.id ? 'chip-hab' : ''}`} title={name(id)}>
                {short(id)}
              </span>
            </span>
          ))}
        </div>
        <div className="order">
          <span className="lbl">{tr('dropped')}</span>
          {shown.dropped.length === 0 ? (
            <span className="dim small">{tr('none')}</span>
          ) : (
            shown.dropped.map((id) => (
              <span key={id} className="chip chip-dropped" title={name(id)}>
                {short(id)}
                <b>{name(id)}</b>
                {/* 事件发生时正停在这个点上：到过了，但停留被中途结束 */}
                {shown.order.includes(id) && <small className="cut">{tr('cutShort')}</small>}
              </span>
            ))
          )}
        </div>
        <div className="stats">
          <Stat label={tr('totalTime')} value={`T+${end.toFixed(0)}`} unit={tr('min')} />
          <Stat label={tr('distance')} value={(dist / 1000).toFixed(2)} unit="km" />
          <Stat
            label={tr('margin')}
            value={margin.toFixed(0)}
            unit={tr('min')}
            tone={margin < params.reserve_min ? 'warn' : 'ok'}
          />
        </div>
      </section>

      <section>
        <h3>{tr('legs')}</h3>
        <table className="legs">
          <thead>
            <tr>
              <th>{tr('leg')}</th>
              <th>{tr('time')}</th>
              <th>{tr('dist')}</th>
              <th>{tr('maxSlope')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.legs.map((l, i) => {
              const w = windows[i];
              const cur = t >= w.a && t < w.b;
              const done = t >= w.b;
              const pct = cur ? (((t - w.a) / (w.b - w.a)) * 100).toFixed(1) : '0';
              return (
                <tr key={i} className={cur ? 'cur' : done ? 'done' : ''}>
                  <td title={`${name(l.from)} → ${name(l.to)}`}>
                    {short(l.from)} → {short(l.to)}
                  </td>
                  <td>
                    {l.time_min.toFixed(1)}′
                    {cur && (
                      <span className="minibar">
                        <i style={{ width: `${pct}%` } as CSSProperties} />
                      </span>
                    )}
                  </td>
                  <td>{Math.round(l.dist_m).toLocaleString()} m</td>
                  <td className={l.max_slope_deg >= params.max_slope_deg * 0.8 ? 'warn' : ''}>{l.max_slope_deg.toFixed(1)}°</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3>{tr('profile')}</h3>
        <ProfileChart
          profile={shown.profile}
          d={profileD}
          eventD={eventD}
          maxSlope={params.max_slope_deg}
          onHover={onProfileHover}
        />
      </section>

      <section>
        <h3>{tr('params')}</h3>
        <ParamTable base={scenario.params} now={params} />
      </section>

      {data.env && (
        <section>
          <h3>{tr('env')}</h3>
          <dl className="kv">
            {data.env.sol != null && <Row k="sol" v={String(data.env.sol)} />}
            {data.env.eva_window && <Row k="window" v={`${data.env.eva_window[0]} – ${data.env.eva_window[1]} LMST`} />}
            {data.env.temp_c && <Row k="temp" v={`${data.env.temp_c[0]} … ${data.env.temp_c[1]} °C`} />}
            {data.env.dust_tau != null && <Row k="dust" v={String(data.env.dust_tau)} />}
            {data.env.dose_note && <Row k="dose" v={data.env.dose_note} prose />}
          </dl>
          {data.env.season_note && <p className="note">{data.env.season_note}</p>}
        </section>
      )}

      {data.datasets.length > 0 && (
        <section>
          <h3>{tr('datasets')}</h3>
          <ul className="datasets">
            {data.datasets.map((d, i) => (
              <li key={i}>
                <a href={d.url} target="_blank" rel="noopener">
                  {d.name} ↗
                </a>
                <span className="role">{d.role}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="panel-foot">{tr('footer')}</p>
    </aside>
  );
}

function Stat({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-l">{label}</div>
      <div className="stat-v">
        {value}
        <small>{unit}</small>
      </div>
    </div>
  );
}

function Row({ k, v, prose }: { k: Key; v: string; prose?: boolean }) {
  const { t } = useT();
  return (
    <>
      <dt>{t(k)}</dt>
      <dd className={prose ? 'prose' : ''}>{v}</dd>
    </>
  );
}

function ParamTable({ base, now }: { base: Params; now: Params }) {
  const { t } = useT();
  const rows: [Key, keyof Params, string][] = [
    ['pK', 'k', ''],
    ['pAlpha', 'alpha', ''],
    ['pSlope', 'max_slope_deg', '°'],
    ['pBudget', 'eva_budget_min', ` ${t('min')}`],
    ['pReserve', 'reserve_min', ` ${t('min')}`],
  ];
  return (
    <dl className="kv">
      {rows.map(([label, key, unit]) => (
        <span key={key} style={{ display: 'contents' }}>
          <dt>{t(label)}</dt>
          <dd>
            {base[key] !== now[key] ? (
              <>
                <s className="dim">
                  {fmtNum(base[key])}
                  {unit}
                </s>{' '}
                <b className="changed">
                  → {fmtNum(now[key])}
                  {unit}
                </b>
              </>
            ) : (
              <>
                {fmtNum(now[key])}
                {unit}
              </>
            )}
          </dd>
        </span>
      ))}
    </dl>
  );
}
