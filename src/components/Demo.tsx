import type { AppData, Scenario } from '../lib/types';
import type { DemoFrame } from '../lib/demo';
import { DEMO_LENGTH } from '../lib/demo';
import { scenarioTitle, useT } from '../i18n';

/** 演示时地图下方的字幕 */
export function DemoCaption({ frame, data, scenario }: { frame: DemoFrame; data: AppData; scenario: Scenario }) {
  const { t } = useT();
  const n = data.waypoints.targets.length;
  const names = (ids: string[]) => ids.map((id) => data.waypoints.targets.find((w) => w.id === id)?.name ?? id).join(', ');
  let main = '';
  let sub = '';
  switch (frame.phase) {
    case 'layers':
      main = data.env?.sol != null ? t('demo1', { sol: data.env.sol, n }) : t('demo1b', { n });
      sub = frame.lastLayer ? `+ ${t(frame.lastLayer)}` : '';
      break;
    case 'plan':
      main = t('demo2');
      break;
    case 'envelope':
      main = t('demo3');
      break;
    case 'walk':
      main = t('demo4a');
      break;
    case 'event':
      main = t('demo4', { title: scenarioTitle(scenario, t) });
      sub = scenario.dropped.length ? t('eventDropped', { ids: names(scenario.dropped) }) : t('eventKept');
      break;
    case 'hud':
      main = t('demo5');
      break;
    case 'end':
      return null;
  }
  return (
    <div className="caption" key={main}>
      <div className="cap-main">{main}</div>
      {sub && (
        <div className="cap-sub" key={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** 演示最后几秒的结尾卡片：一句话总结 + 所用 NASA 数据 */
export function DemoEndCard({ data, onReplay, onExit }: { data: AppData; onReplay: () => void; onExit: () => void }) {
  const { t } = useT();
  return (
    <div className="endcard">
      <div className="endcard-inner">
        <h2>{t('appTitle')}</h2>
        <p className="tag">{t('endTag')}</p>
        {data.datasets.length > 0 && (
          <>
            <div className="endcard-k">{t('endData')}</div>
            <div className="endcard-data">
              {data.datasets.map((d, i) => (
                <span key={i}>{d.name}</span>
              ))}
            </div>
          </>
        )}
        <div className="endcard-actions">
          <button className="btn" onClick={onReplay}>
            ↺ {t('demoReplay')}
          </button>
          <button className="btn" onClick={onExit}>
            {t('demoExit')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 演示进度条和退出按钮 */
export function DemoChrome({ elapsed, onExit }: { elapsed: number; onExit: () => void }) {
  const { t } = useT();
  return (
    <>
      <div className="demo-bar">
        <i style={{ width: `${Math.min(100, (elapsed / DEMO_LENGTH) * 100)}%` }} />
      </div>
      <button className="btn demo-exit" onClick={onExit}>
        {t('demoExit')}
      </button>
    </>
  );
}
