import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import MapView from './components/MapView';
import Panel from './components/Panel';
import Timeline from './components/Timeline';
import Hud from './components/Hud';
import Boundary from './components/Boundary';
import DataCheck from './components/DataCheck';
import { DemoCaption, DemoChrome, DemoEndCard } from './components/Demo';
import { DataError, loadAll, RASTER_LAYERS } from './lib/data';
import { DEFAULT_LAYERS, type LayerKey, type LayerState } from './lib/layers';
import { DEMO_LENGTH, demoFrame, pickDemoScenario } from './lib/demo';
import { distanceAt, endTime, frameAt, paramsAt, positionAt, profileAt, scheduleOf } from './lib/playback';
import type { AppData, Scenario } from './lib/types';
import { fmtNum, LangContext, makeT, scenarioTitle, useT, type Lang } from './i18n';
import { REPO_URL } from './config';

function readLang(): Lang {
  try {
    const v = localStorage.getItem('mm-lang');
    if (v === 'en' || v === 'zh') return v;
  } catch {
    /* 隐私模式下 localStorage 不可用 */
  }
  return 'en';
}

export default function App() {
  const [lang, setLang] = useState<Lang>(readLang);
  const ctx = useMemo(() => ({ lang, t: makeT(lang) }), [lang]);
  const [data, setData] = useState<AppData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadAll()
      .then(setData)
      .catch((e) => setErr(e instanceof DataError ? ctx.t('loadError', { file: e.message }) : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('mm-lang', lang);
    } catch {
      /* 忽略 */
    }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  return (
    <LangContext.Provider value={ctx}>
      {err ? (
        <div className="splash error">{err}</div>
      ) : !data ? (
        <div className="splash">{ctx.t('loading')}</div>
      ) : data.scenarios.length === 0 ? (
        <div className="splash error">
          {ctx.t('noScenarios')}
          <ul className="splash-list">
            {data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <Main data={data} lang={lang} setLang={setLang} />
      )}
    </LangContext.Provider>
  );
}

function Main({ data, lang, setLang }: { data: AppData; lang: Lang; setLang: (l: Lang) => void }) {
  const { t: tr } = useT();
  const initialId = () => {
    const h = location.hash.replace('#', '');
    return data.scenarios.some((s) => s.id === h) ? h : data.scenarios[0].id;
  };
  const [sid, setSid] = useState(initialId);
  const [userT, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [userLayers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [userHud, setHud] = useState(false);
  const [toast, setToast] = useState(false);
  /** 演示开始后的秒数；null = 不在演示 */
  const [demo, setDemo] = useState<number | null>(null);
  /** 每开始 / 重播一次加 1，让演示循环从 0 秒重新计时 */
  const [demoRun, setDemoRun] = useState(0);
  /** 剖面图上鼠标所指的距离（米） */
  const [hoverD, setHoverD] = useState<number | null>(null);

  const scenario = data.scenarios.find((s) => s.id === sid) ?? data.scenarios[0];
  const nominal = data.scenarios.find((s) => s.id === 'nominal') ?? null;
  const end = endTime(scenario);

  // 演示时，时间 / 图层 / HUD 由演示脚本决定；退出后恢复用户自己的状态
  const available = useCallback(
    (k: LayerKey) => (RASTER_LAYERS.some((l) => l.id === k) ? !!data.rasters[k] : k === 'geology' ? !!data.geology : true),
    [data],
  );
  const df = demo != null ? demoFrame(demo, scenario, available) : null;
  const t = df ? df.t : userT;
  const layers = df ? df.layers : userLayers;
  const hud = df ? df.hud : userHud;

  // 事件前显示原计划（nominal），事件后显示本场景的新计划
  const preEvent = !!scenario.event && t < scenario.event.at_min && !!nominal && nominal !== scenario;
  const shown: Scenario = preEvent ? nominal! : scenario;
  const scenarioStops = useMemo(() => scheduleOf(scenario, data.waypoints), [scenario, data.waypoints]);
  const nominalStops = useMemo(() => (nominal ? scheduleOf(nominal, data.waypoints) : []), [nominal, data.waypoints]);
  const stops = preEvent ? nominalStops : scenarioStops;
  const params = paramsAt(scenario, t);
  const frameUrl = frameAt(scenario, t);
  const eventActive = !!scenario.event && t >= scenario.event.at_min;

  // 剖面图悬停 → 地图标记：距离 → 该处时间 → 路线上的位置
  const hover = useMemo(() => {
    if (hoverD == null) return null;
    const p = profileAt(shown.profile, hoverD);
    if (!p) return null;
    const pos = positionAt(shown.path, p.t);
    return { x: pos.x, y: pos.y, d: hoverD, elev: p.elev, slope: p.slope };
  }, [hoverD, shown]);
  useEffect(() => setHoverD(null), [sid]);

  // 演示会切到 slow20；退出演示（Esc / 退出按钮 / 再按 D）时回到演示前的场景
  const preDemoSid = useRef<string | null>(null);

  // 演示不改用户自己的时间 / 图层 / HUD，退出时它们原样恢复
  const exitDemo = useCallback(() => {
    setDemo(null);
    const prev = preDemoSid.current;
    preDemoSid.current = null;
    if (prev) {
      setSid(prev);
      history.replaceState(null, '', `#${prev}`);
    }
  }, []);

  const startDemo = useCallback(() => {
    if (preDemoSid.current == null) preDemoSid.current = sid;
    const id = pickDemoScenario(data.scenarios);
    setSid(id);
    history.replaceState(null, '', `#${id}`);
    setPlaying(false);
    setDemo(0);
    setDemoRun((n) => n + 1);
  }, [data.scenarios, sid]);

  /** 结尾卡片上的“重播”：从 0 秒重新开始（循环可能还在跑，所以要换一轮） */
  const replayDemo = useCallback(() => {
    setDemo(0);
    setDemoRun((n) => n + 1);
  }, []);

  const selectScenario = useCallback((id: string) => {
    preDemoSid.current = null;
    setDemo(null);
    setSid(id);
    setT(0);
    setPlaying(false);
    history.replaceState(null, '', `#${id}`);
  }, []);

  // 地址栏里改 #nominal / #slow20 / #dust 也能切换场景
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#', '');
      if (data.scenarios.some((s) => s.id === h)) selectScenario(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [data.scenarios, selectScenario]);

  // ---- 播放循环
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      // 限制单帧步长，切回标签页时不会一下跳很远；0.25 秒对低帧率机器也够宽
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const next = tRef.current + dt * speed;
      if (next >= end) {
        setT(end);
        setPlaying(false);
        return;
      }
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);

  // ---- 演示循环：按真实时间推进，30 秒后停在结尾卡片
  const demoRef = useRef(demo);
  demoRef.current = demo;
  const demoRunning = demo != null && demo < DEMO_LENGTH;
  useEffect(() => {
    if (!demoRunning) return;
    const t0 = performance.now() - (demoRef.current ?? 0) * 1000;
    let raf = 0;
    const step = (now: number) => {
      const e = (now - t0) / 1000;
      if (e >= DEMO_LENGTH) {
        setDemo(DEMO_LENGTH);
        return;
      }
      setDemo(e);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [demoRunning, demoRun]);

  // ---- 事件提示：越过事件时刻时弹出 6 秒
  useEffect(() => {
    if (!eventActive) {
      setToast(false);
      return;
    }
    setToast(true);
    const id = setTimeout(() => setToast(false), 6000);
    return () => clearTimeout(id);
  }, [eventActive, sid]);

  // ---- 快捷键：空格播放/暂停，←/→ 逐步（Shift ×10），Home/End，H 切换 HUD，1/2/3 切换场景，D 演示，Esc 退出演示
  const axisRef = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl / Cmd / Alt 组合键留给浏览器（Ctrl+D 收藏、Ctrl+1 切标签页……）
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 只有文字输入框和下拉框需要自己的按键；时间滑块、图层开关、按钮获得焦点时快捷键照常可用
      const el = e.target instanceof HTMLElement ? e.target : null;
      const inputType = el instanceof HTMLInputElement ? el.type : null;
      if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return;
      if (inputType && inputType !== 'range' && inputType !== 'checkbox') return;
      if (e.code === 'Space' || e.key === ' ') {
        if (inputType === 'checkbox') return; // 空格切换图层开关
        // 刚用鼠标点过的按钮还有焦点，空格会再“点”它一次，和我们的播放切换互相抵消
        if (el instanceof HTMLButtonElement) el.blur();
      }
      if (e.key === 'Escape') {
        if (demoRef.current != null) exitDemo();
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        if (demoRef.current != null) exitDemo();
        else startDemo();
        return;
      }
      if (demoRef.current != null) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        setPlaying(false);
        // 先写回 ref：按住方向键时连续触发，不等重新渲染
        const v = Math.min(axisRef.current, Math.max(0, Math.round(tRef.current + step)));
        tRef.current = v;
        setT(v);
        return;
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setPlaying(false);
        setT(e.key === 'Home' ? 0 : end);
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (tRef.current >= end) setT(0);
        setPlaying((p) => (tRef.current >= end ? true : !p));
      } else if (e.key === 'h' || e.key === 'H') {
        setHud((v) => !v);
      } else if (/^[1-9]$/.test(e.key)) {
        const s = data.scenarios[+e.key - 1];
        if (s) selectScenario(s.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data.scenarios, end, selectScenario, startDemo, exitDemo]);

  const toggleLayer = useCallback((k: LayerKey) => setLayers((l) => ({ ...l, [k]: !l[k] })), []);
  // 演示中用户自己拖时间轴 / 点播放：就地停止演示，留在当前场景继续操作
  const userSetT = useCallback((v: number) => {
    if (demoRef.current != null) {
      preDemoSid.current = null;
      setDemo(null);
    }
    setT(v);
  }, []);
  const userPlay = useCallback((p: boolean) => {
    if (demoRef.current != null) {
      preDemoSid.current = null;
      setDemo(null);
      setT(0);
    }
    setPlaying(p);
  }, []);

  const env = data.env;
  // 时间轴固定按出舱上限画，能直接看出预留和余量
  const axisMax = Math.max(scenario.params.eva_budget_min, end, nominal ? endTime(nominal) : 0);
  axisRef.current = axisMax;
  const profileD = distanceAt(shown.profile, t);
  const eventD = scenario.event && scenario.profile.length ? distanceAt(scenario.profile, scenario.event.at_min) : null;
  const dropped = scenario.dropped
    .map((id) => data.waypoints.targets.find((w) => w.id === id)?.name ?? id)
    .join(', ');

  const crash = (where: string) => (error: Error) => (
    <CrashCard where={where} error={error} scenarios={data.scenarios} current={sid} onPick={selectScenario} />
  );

  return (
    <div className={`app ${demo != null ? 'demo' : ''}`}>
      <header className="top">
        <div className="brand">
          <MarsGlyph />
          <div style={{ minWidth: 0 }}>
            <h1>{tr('appTitle')}</h1>
            <div className="sub">{tr('appSubtitle')}</div>
          </div>
        </div>
        <div className="mission">
          {env?.sol != null && (
            <span className="mchip">
              <span className="k">{tr('sol')}</span>
              <span className="v">{env.sol}</span>
            </span>
          )}
          {env?.eva_window && (
            <span className="mchip">
              <span className="k">{tr('window')}</span>
              <span className="v">
                {env.eva_window[0]}–{env.eva_window[1]}
              </span>
            </span>
          )}
          {env?.temp_c && (
            <span className="mchip opt">
              <span className="v">
                {env.temp_c[0]}…{env.temp_c[1]} °C
              </span>
            </span>
          )}
          {env?.dust_tau != null && (
            <span className="mchip opt">
              <span className="k">τ</span>
              <span className="v">{env.dust_tau}</span>
            </span>
          )}
          {env?.go != null && <span className={`mchip ${env.go ? 'go' : 'nogo'}`}>{env.go ? tr('go') : tr('nogo')}</span>}
        </div>
        <div className="top-actions">
          <DataCheck warnings={data.warnings} />
          <button className={`btn demo-btn ${demo != null ? 'on' : ''}`} onClick={demo != null ? exitDemo : startDemo} title="D">
            {demo != null ? '■' : '▶'} {tr('demo')}
          </button>
          {REPO_URL && (
            <a href={REPO_URL} target="_blank" rel="noopener" className="btn">
              {tr('code')} ↗
            </a>
          )}
          <button className="btn" onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}>
            {lang === 'en' ? '中文' : 'EN'}
          </button>
        </div>
      </header>

      <main className="stage">
        <Boundary resetKey={sid} fallback={crash('map')}>
          <MapView
            data={data}
            scenario={scenario}
            nominal={nominal}
            t={t}
            layers={layers}
            onToggleLayer={toggleLayer}
            stops={stops}
            frameUrl={frameUrl}
            hover={df ? null : hover}
          />
        </Boundary>
        {data.grid.synthetic && <div className="synthetic">{tr('synthetic')}</div>}
        <button className={`btn hud-toggle ${hud ? 'on' : ''}`} onClick={() => setHud(!userHud)} title="H">
          <span className="dot" />
          {tr('hud')}
        </button>
        {toast && scenario.event && (
          <div className="toast" role="status">
            <span className="toast-icon">⚡</span>
            <div>
              <b>{tr('eventTitle', { t: fmtNum(scenario.event.at_min) })}</b> · {scenarioTitle(scenario, tr)}
              <div className="sub">{dropped ? tr('eventDropped', { ids: dropped }) : tr('eventKept')}</div>
            </div>
          </div>
        )}
        {hud && (
          <Boundary resetKey={sid} fallback={crash('hud')}>
            <Hud
              grid={data.grid}
              scenario={scenario}
              shown={shown}
              stops={stops}
              params={params}
              t={t}
              habId={data.waypoints.hab.id}
              onClose={() => setHud(false)}
            />
          </Boundary>
        )}
        {df && (
          <>
            <DemoCaption frame={df} data={data} scenario={scenario} />
            {df.phase === 'end' && <DemoEndCard data={data} onReplay={replayDemo} onExit={exitDemo} />}
            <DemoChrome elapsed={demo!} onExit={exitDemo} />
          </>
        )}
      </main>

      <Boundary resetKey={sid} fallback={crash('timeline')}>
        <Timeline
          t={t}
          end={end}
          axisMax={axisMax}
          playing={playing}
          speed={speed}
          event={scenario.event}
          stops={stops}
          params={params}
          baseParams={scenario.params}
          habId={data.waypoints.hab.id}
          clockStart={env?.eva_window?.[0]}
          onT={userSetT}
          onPlay={userPlay}
          onSpeed={setSpeed}
        />
      </Boundary>

      <Boundary resetKey={sid} fallback={crash('panel')}>
        <Panel
          data={data}
          scenario={scenario}
          shown={shown}
          stops={stops}
          params={params}
          t={t}
          onScenario={selectScenario}
          profileD={profileD}
          eventD={eventD}
          onProfileHover={setHoverD}
        />
      </Boundary>
    </div>
  );
}

function CrashCard(p: { where: string; error: Error; scenarios: Scenario[]; current: string; onPick: (id: string) => void }): ReactNode {
  const { t } = useT();
  const body = (
    <div className="crash">
      <b>⚠ {t('crash')}</b>
      <code>
        {p.current}.json · {p.where}: {p.error.message}
      </code>
      <span className="dim small">{t('crashHint')}</span>
      <div className="crash-actions">
        {p.scenarios
          .filter((s) => s.id !== p.current)
          .map((s) => (
            <button key={s.id} className="btn" onClick={() => p.onPick(s.id)}>
              {scenarioTitle(s, t)}
            </button>
          ))}
      </div>
    </div>
  );
  if (p.where === 'panel') return <aside className="panel">{body}</aside>;
  if (p.where === 'timeline') return <div className="timeline">{body}</div>;
  return <div className="crash-wrap">{body}</div>;
}

function MarsGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id="mg" cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#f08a4b" />
          <stop offset="0.55" stopColor="#c1440e" />
          <stop offset="1" stopColor="#5a1a04" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="url(#mg)" />
      <path d="M6 13c4 1 7-1 10 0s6 3 10 1" stroke="#7a2a08" strokeWidth="1.6" fill="none" opacity="0.7" />
      <circle cx="21" cy="20" r="2.4" fill="#8f3409" opacity="0.8" />
      <circle cx="11" cy="20.5" r="1.4" fill="#8f3409" opacity="0.7" />
      <ellipse cx="16" cy="16" rx="15.5" ry="4" stroke="#ff9d5c" strokeWidth="0.8" fill="none" opacity="0.45" transform="rotate(-18 16 16)" />
    </svg>
  );
}
