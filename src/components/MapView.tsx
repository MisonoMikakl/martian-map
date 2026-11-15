import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { cellToLatLng, gridBounds, gridToLatLng, gridToProjected, latLngToGrid } from '../lib/coords';
import { RASTER_LAYERS, dataUrl } from '../lib/data';
import { headingAt, indexAt, positionAt, type Stop } from '../lib/playback';
import type { AppData, PathPoint, Scenario, Waypoint } from '../lib/types';
import type { LayerKey, LayerState } from '../lib/layers';
import { useT } from '../i18n';
import { escapeHtml } from '../lib/html';

const EMPTY_PNG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const C = {
  casing: '#05070a',
  walked: '#ff7a2f',
  planned: '#f3ede2',
  fresh: '#3ad7ff',
  ghost: '#aab0b8',
  unsafe: '#ff4d6d',
};

/** mask 为 true 的点连成的若干段（单独一个点就连到下一个点，保证看得见） */
function unsafeRuns(path: PathPoint[], mask: boolean[] | undefined): L.LatLng[][] {
  if (!mask) return [];
  const runs: L.LatLng[][] = [];
  let cur: L.LatLng[] | null = null;
  for (let i = 0; i < path.length; i++) {
    if (mask[i]) {
      if (!cur) {
        cur = [];
        runs.push(cur);
      }
      cur.push(cellToLatLng(path[i][0], path[i][1]));
      if (i + 1 < path.length && !mask[i + 1]) cur.push(cellToLatLng(path[i + 1][0], path[i + 1][1]));
    } else {
      cur = null;
    }
  }
  return runs;
}

interface Props {
  data: AppData;
  scenario: Scenario;
  nominal: Scenario | null;
  t: number;
  layers: LayerState;
  onToggleLayer: (k: LayerKey) => void;
  stops: Stop[];
  frameUrl: string | null;
  /** 剖面图上鼠标所指的位置（网格坐标 + 该处数值），null 时不显示 */
  hover: { x: number; y: number; d: number; elev: number; slope: number } | null;
}

type TargetStatus = 'pending' | 'next' | 'visited' | 'dropped';

export default function MapView({ data, scenario, nominal, t, layers, onToggleLayer, stops, frameUrl, hover }: Props) {
  const { t: tr, lang } = useT();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const rasters = useRef<Record<string, L.ImageOverlay>>({});
  const envelope = useRef<L.ImageOverlay | null>(null);
  const geology = useRef<L.GeoJSON | null>(null);
  const routeGroup = useRef<L.LayerGroup | null>(null);
  const lines = useRef<Record<string, L.Polyline>>({});
  const astro = useRef<L.Marker | null>(null);
  const evtPin = useRef<L.Marker | null>(null);
  const hoverPin = useRef<L.Marker | null>(null);
  const markers = useRef<Record<string, L.Marker>>({});
  const preload = useRef<HTMLImageElement[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(0);

  const { grid, waypoints } = data;

  // ---- 初始化地图（只做一次）
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, {
      crs: L.CRS.Simple,
      minZoom: -3,
      maxZoom: 4,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      attributionControl: false,
      zoomControl: false,
      // 方向键留给时间轴逐步前进 / 后退，地图用拖动和滚轮
      keyboard: false,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    const b = gridBounds(grid);
    m.fitBounds(b, { padding: [16, 16] });
    m.setMaxBounds(b.pad(0.6));
    setZoom(m.getZoom());

    m.createPane('rasters').style.zIndex = '200';
    m.createPane('geology').style.zIndex = '300';
    m.createPane('envelope').style.zIndex = '350';

    RASTER_LAYERS.forEach((l, i) => {
      rasters.current[l.id] = L.imageOverlay(dataUrl(l.file), b, {
        pane: 'rasters',
        opacity: l.opacity,
        zIndex: i + 1,
        className: 'blend' in l ? `raster blend-${l.blend}` : 'raster',
        interactive: false,
      });
    });
    envelope.current = L.imageOverlay(EMPTY_PNG, b, { pane: 'envelope', className: 'envelope', interactive: false });

    if (data.geology) {
      geology.current = L.geoJSON(data.geology, {
        pane: 'geology',
        coordsToLatLng: (c) => gridToLatLng(c[0], c[1]),
        style: (f) => ({
          color: (f?.properties?.color as string) ?? '#ffd166',
          weight: 1.5,
          dashArray: '5 4',
          fillOpacity: 0.16,
        }),
        onEachFeature: (f, layer) => {
          const p = f.properties ?? {};
          layer.bindTooltip(
            `<b>${escapeHtml(String(p.name ?? ''))}</b>${p.unit ? ` (${escapeHtml(String(p.unit))})` : ''}${
              p.note ? `<br>${escapeHtml(String(p.note))}` : ''
            }`,
            { sticky: true },
          );
        },
      });
    }

    // 路线：外描边 + 光晕 + 主线，SVG 渲染才能给新路线加流动动画
    const g = L.layerGroup().addTo(m);
    routeGroup.current = g;
    const mk = (o: L.PolylineOptions) =>
      L.polyline([], { interactive: false, lineCap: 'round', lineJoin: 'round', ...o, className: `rt ${o.className ?? ''}` }).addTo(g);
    lines.current = {
      plannedCasing: mk({ color: C.casing, weight: 7, opacity: 0.55 }),
      planned: mk({ color: C.planned, weight: 3, opacity: 0.95 }),
      ghost: mk({ color: C.ghost, weight: 2.5, dashArray: '2 7', opacity: 0.85 }),
      freshHalo: mk({ color: C.fresh, weight: 14, opacity: 0.16 }),
      freshCasing: mk({ color: C.casing, weight: 7.5, opacity: 0.6 }),
      fresh: mk({ color: C.fresh, weight: 3.5 }),
      freshFlow: mk({ color: '#e6fbff', weight: 1.6, dashArray: '3 14', className: 'rt-flow', opacity: 0.9 }),
      walkedHalo: mk({ color: C.walked, weight: 14, opacity: 0.2 }),
      walkedCasing: mk({ color: C.casing, weight: 8, opacity: 0.6 }),
      walked: mk({ color: C.walked, weight: 4.2 }),
      // B 的 unsafe：路线上来不及回舱的段，画在最上面
      unsafeHalo: mk({ color: C.unsafe, weight: 14, opacity: 0.25 }),
      unsafe: mk({ color: C.unsafe, weight: 4.5 }),
    };
    evtPin.current = L.marker(gridToLatLng(0, 0), {
      icon: L.divIcon({ className: 'evt-pin', html: '<span>⚡</span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
      interactive: false,
      zIndexOffset: 800,
    });
    hoverPin.current = L.marker(gridToLatLng(0, 0), {
      icon: L.divIcon({
        className: 'hover-pin',
        html: '<span class="hp-dot"></span><span class="hp-label"></span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      interactive: false,
      zIndexOffset: 1200,
    });
    astro.current = L.marker(gridToLatLng(0, 0), {
      icon: L.divIcon({
        className: 'astro',
        html: '<span class="astro-cone"></span><span class="astro-ring"></span><span class="astro-dot"></span>',
        iconSize: [22, 22],
      }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(m);

    m.on('mousemove', (e: L.LeafletMouseEvent) => setCursor(latLngToGrid(e.latlng)));
    m.on('mouseout', () => setCursor(null));
    m.on('zoom', () => setZoom(m.getZoom()));

    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    map.current = m;
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      markers.current = {};
    };
  }, [data, grid]);

  // ---- 图层开关
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const l of RASTER_LAYERS) {
      const o = rasters.current[l.id];
      const want = layers[l.id] && data.rasters[l.id];
      if (want && !m.hasLayer(o)) o.addTo(m);
      if (!want && m.hasLayer(o)) o.remove();
    }
    const geo = geology.current;
    if (geo) {
      if (layers.geology && !m.hasLayer(geo)) geo.addTo(m);
      if (!layers.geology && m.hasLayer(geo)) geo.remove();
    }
    const rg = routeGroup.current;
    if (rg) {
      if (layers.route && !m.hasLayer(rg)) rg.addTo(m);
      if (!layers.route && m.hasLayer(rg)) rg.remove();
    }
  }, [layers, data.rasters]);

  // ---- 安全返回范围：预加载当前场景的全部帧，按时间换 URL
  useEffect(() => {
    preload.current = scenario.envelope_frames.map((f) => {
      const img = new Image();
      img.src = f.url ?? dataUrl(`scenarios/${f.png}`);
      return img;
    });
  }, [scenario]);

  useEffect(() => {
    const m = map.current;
    const env = envelope.current;
    if (!m || !env) return;
    const want = layers.envelope && !!frameUrl;
    if (want) {
      env.setUrl(frameUrl!);
      if (!m.hasLayer(env)) env.addTo(m);
    } else if (m.hasLayer(env)) {
      env.remove();
    }
  }, [frameUrl, layers.envelope]);

  // ---- 路线
  const lls = useMemo(() => scenario.path.map((p) => cellToLatLng(p[0], p[1])), [scenario]);
  const nomLls = useMemo(() => (nominal ? nominal.path.map((p) => cellToLatLng(p[0], p[1])) : []), [nominal]);

  useEffect(() => {
    const L_ = lines.current;
    const m = map.current;
    if (!L_.planned || !m) return;
    const pos = positionAt(scenario.path, t);
    const here = cellToLatLng(pos.x, pos.y);
    const ev = scenario.event;
    const set = (keys: string[], v: L.LatLng[]) => keys.forEach((k) => L_[k].setLatLngs(v));
    const FRESH = ['fresh', 'freshCasing', 'freshHalo', 'freshFlow'];
    const PLANNED = ['planned', 'plannedCasing'];

    set(['walked', 'walkedCasing', 'walkedHalo'], [...lls.slice(0, pos.i + 1), here]);
    if (!ev) {
      set(PLANNED, [here, ...lls.slice(pos.i + 1)]);
      set(['ghost', ...FRESH], []);
    } else if (t < ev.at_min) {
      // 事件发生前按原计划显示（事件前两条路径相同）
      const src = nominal ?? scenario;
      const srcLls = nominal ? nomLls : lls;
      const j = indexAt(src.path, t);
      set(PLANNED, [here, ...srcLls.slice(j + 1)]);
      set(['ghost', ...FRESH], []);
    } else {
      set(PLANNED, []);
      L_.ghost.setLatLngs(nominal ? nomLls.slice(indexAt(nominal.path, ev.at_min)) : []);
      set(FRESH, [here, ...lls.slice(pos.i + 1)]);
    }

    const a = astro.current;
    if (a) {
      a.setLatLng(here);
      a.getElement()?.style.setProperty('--hdg', `${headingAt(scenario.path, pos.i)}deg`);
    }

    const pin = evtPin.current;
    if (pin) {
      if (ev && t >= ev.at_min) {
        const e = positionAt(scenario.path, ev.at_min);
        pin.setLatLng(cellToLatLng(e.x, e.y));
        if (!m.hasLayer(pin)) pin.addTo(m);
      } else if (m.hasLayer(pin)) {
        pin.remove();
      }
    }
  }, [t, scenario, nominal, lls, nomLls]);

  // ---- 来不及回舱的路段：事件前显示原计划（nominal）的，事件后显示本场景的
  const eventOn = !scenario.event || t >= scenario.event.at_min;
  const unsafeSrc = eventOn || !nominal ? scenario : nominal;
  const runs = useMemo(() => unsafeRuns(unsafeSrc.path, unsafeSrc.unsafeMask), [unsafeSrc]);
  useEffect(() => {
    const L_ = lines.current;
    if (!L_.unsafe) return;
    L_.unsafe.setLatLngs(runs);
    L_.unsafeHalo.setLatLngs(runs);
  }, [runs]);

  // ---- 剖面图悬停 → 地图上对应位置
  useEffect(() => {
    const m = map.current;
    const pin = hoverPin.current;
    if (!m || !pin) return;
    if (!hover) {
      if (m.hasLayer(pin)) pin.remove();
      return;
    }
    pin.setLatLng(cellToLatLng(hover.x, hover.y));
    if (!m.hasLayer(pin)) pin.addTo(m);
    const label = pin.getElement()?.querySelector('.hp-label');
    if (label)
      label.textContent = `${(hover.d / 1000).toFixed(2)} km · ${hover.elev.toFixed(0)} m · ${hover.slope.toFixed(1)}°`;
  }, [hover]);

  // ---- 路点标记
  const active = !!scenario.event && t >= scenario.event.at_min;
  const nextStop = stops.find((s) => s.depart > t);
  const statusOf = (w: Waypoint): TargetStatus => {
    // 有事件的场景：事件发生后才显示“放弃”；没有事件的场景（例如 nominal 本身放不下所有点）从一开始就显示。
    // 事件发生时正停在这个点上、停留被中途结束的（B 也算作 dropped），已经到过，按“已到达”显示。
    const s = stops.find((x) => x.id === w.id);
    if ((active || !scenario.event) && scenario.dropped.includes(w.id) && !s) return 'dropped';
    if (s && s.depart <= t) return 'visited';
    if (nextStop?.id === w.id) return 'next';
    return 'pending';
  };
  const statusKey = waypoints.targets.map(statusOf).join(',');

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const statuses = statusKey.split(',') as TargetStatus[];
    const all: [Waypoint, string][] = [
      [waypoints.hab, 'hab'],
      ...waypoints.targets.map((w, i): [Waypoint, string] => [w, statuses[i]]),
    ];
    for (const [w, status] of all) {
      const isHab = w.id === waypoints.hab.id;
      const meta: string[] = [];
      if (!isHab && w.priority != null) meta.push(`P${w.priority}`);
      if (!isHab && w.dwell_min != null) meta.push(`${w.dwell_min} ${tr('min')}`);
      const icon = L.divIcon({
        className: `wp wp-${status}`,
        html: `<span class="wp-dot">${isHab ? 'H' : escapeHtml(w.id.replace(/^t/, ''))}</span><span class="wp-label"><b>${escapeHtml(
          w.name,
        )}</b>${meta.length ? `<small>${escapeHtml(meta.join(' · '))}</small>` : ''}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      let mk = markers.current[w.id];
      if (!mk) {
        mk = L.marker(cellToLatLng(w.x, w.y), { icon, zIndexOffset: 500 }).addTo(m);
        markers.current[w.id] = mk;
      } else {
        mk.setIcon(icon);
      }
      mk.bindPopup(popupHtml(w, tr), { maxWidth: 300, className: 'wp-popup' });
    }
  }, [statusKey, waypoints, tr, lang]);

  const proj = cursor ? gridToProjected(grid, cursor.x, cursor.y) : null;
  const inside = cursor && cursor.x >= 0 && cursor.y >= 0 && cursor.x < grid.width && cursor.y < grid.height;

  return (
    <div className="map-wrap">
      <div ref={el} className="map" />
      <div className="map-vignette" />
      <LayerCard data={data} layers={layers} onToggle={onToggleLayer} />
      <LegendCard zoom={zoom} resM={grid.res_m} showUnsafe={data.scenarios.some((s) => s.unsafeMask?.some(Boolean))} />
      {inside && proj && (
        <div className="cursor-readout glass">
          x {Math.floor(cursor.x)} y {Math.floor(cursor.y)}
          <span className="dim">
            {' '}
            · X {proj.X.toFixed(0)} Y {proj.Y.toFixed(0)} m
          </span>
        </div>
      )}
    </div>
  );
}

function popupHtml(w: Waypoint, tr: ReturnType<typeof useT>['t']): string {
  const rows: string[] = [`<div class="pp-title">${escapeHtml(w.name)}</div>`];
  if (w.photo) rows.push(`<img class="pp-photo" src="${escapeHtml(dataUrl(w.photo))}" alt="">`);
  if (w.why) rows.push(`<div class="pp-why">${escapeHtml(w.why)}</div>`);
  const meta: string[] = [];
  if (w.dwell_min != null) meta.push(`<span>${tr('dwell')} ${w.dwell_min} ${tr('min')}</span>`);
  if (w.priority != null) meta.push(`<span>${tr('priority')} ${w.priority}</span>`);
  if (meta.length) rows.push(`<div class="pp-meta">${meta.join('')}</div>`);
  if (w.source && /^https?:\/\//.test(w.source))
    rows.push(`<a class="pp-src" href="${escapeHtml(w.source)}" target="_blank" rel="noopener">${tr('source')} ↗</a>`);
  return rows.join('');
}

function LayerCard({ data, layers, onToggle }: { data: AppData; layers: LayerState; onToggle: (k: LayerKey) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(() => window.innerWidth > 900);
  const items: { k: LayerKey; avail: boolean }[] = [
    ...RASTER_LAYERS.map((l) => ({ k: l.id as LayerKey, avail: data.rasters[l.id] })),
    { k: 'geology', avail: !!data.geology },
    { k: 'envelope', avail: true },
    { k: 'route', avail: true },
  ];
  // 每个图层用到的 NASA 数据（datasets.json 里的 layers 字段）
  const sources = (k: LayerKey) => data.datasets.filter((d) => d.layers?.includes(k));
  return (
    <div className="layer-card glass">
      <button className="card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t('layers')} <span>{open ? '−' : '+'}</span>
      </button>
      {open &&
        items.map(({ k, avail }) => (
          <label key={k} className={`lrow ${avail ? '' : 'disabled'}`}>
            <span className={`swatch sw-${k}`} />
            <span className="name">
              {t(k)}
              {!avail && <span className="missing"> · {t('missing')}</span>}
              {sources(k).length > 0 && (
                <span className="lsrc">
                  {(k === 'route' || k === 'envelope') && `${t('computedFrom')} `}
                  {sources(k).map((d, i) => (
                    <span key={d.name}>
                      {i > 0 && ' + '}
                      {d.url ? (
                        <a href={d.url} target="_blank" rel="noopener" title={d.role}>
                          {d.name}
                        </a>
                      ) : (
                        d.name
                      )}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <input type="checkbox" checked={layers[k] && avail} disabled={!avail} onChange={() => onToggle(k)} />
            <span className="switch" />
          </label>
        ))}
    </div>
  );
}

const NICE = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

function LegendCard({ zoom, resM, showUnsafe }: { zoom: number; resM: number; showUnsafe: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(() => window.innerWidth > 1200);
  // CRS.Simple：缩放级别 z 时 1 个网格单位 = 2^z 像素
  const mPerPx = resM / Math.pow(2, zoom);
  const target = 110 * mPerPx;
  const nice = NICE.reduce((best, v) => (v <= target ? v : best), NICE[0]);
  const px = nice / mPerPx;
  return (
    <div className="legend-card glass">
      <button className="card-head legend-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t('legend')} <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
      <>
      <div className="legend">
        <span>
          <i className="ln ln-walked" />
          {t('legendTraveled')}
        </span>
        <span>
          <i className="ln ln-planned" />
          {t('legendPlanned')}
        </span>
        <span>
          <i className="ln ln-fresh" />
          {t('legendNew')}
        </span>
        <span>
          <i className="ln ln-ghost" />
          {t('legendOld')}
        </span>
        <span>
          <i className="ln ln-env" />
          {t('envelope')}
        </span>
        {showUnsafe && (
          <span>
            <i className="ln ln-unsafe" />
            {t('legendUnsafe')}
          </span>
        )}
      </div>
      <p className="legend-note">{t('envelopeNote')}</p>
      </>
      )}
      <div className="scalebar">
        <span className="bar" style={{ width: px }} />
        <span>{nice >= 1000 ? `${nice / 1000} km` : `${nice} m`}</span>
        <span className="north" title="North">
          <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
            <path d="M5 0 L10 12 L5 9 L0 12 Z" />
          </svg>
          N
        </span>
      </div>
    </div>
  );
}
