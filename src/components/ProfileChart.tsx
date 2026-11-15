import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ProfilePoint } from '../lib/types';
import { useT } from '../i18n';

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);

interface Props {
  profile: ProfilePoint[];
  d: number;
  eventD: number | null;
  maxSlope: number;
  /** 鼠标在剖面上的距离（米），移出时为 null；用来在地图上标出对应位置 */
  onHover?: (d: number | null) => void;
}

export default function ProfileChart({ profile, d, eventD, maxSlope, onHover }: Props) {
  const { t, lang } = useT();
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = c;
    let last: number | null = null;
    const emit = (v: number | null) => {
      if (v === last || (v != null && last != null && Math.abs(v - last) < 1)) return;
      last = v;
      hoverRef.current?.(v);
    };
    c.on('updateAxisPointer', (ev: unknown) => {
      const info = (ev as { axesInfo?: { axisDim: string; value: number }[] }).axesInfo?.find((a) => a.axisDim === 'x');
      emit(info && Number.isFinite(info.value) ? info.value : null);
    });
    c.getZr().on('globalout', () => emit(null));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (profile.length === 0) {
      c.clear();
      return;
    }
    const maxD = profile[profile.length - 1].d_m;
    c.setOption(
      {
        animation: false,
        grid: { left: 52, right: 36, top: 14, bottom: 26 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: '#1b2129',
          borderColor: '#2c3540',
          textStyle: { color: '#e6e9ef', fontSize: 12 },
          formatter: (ps: unknown) => {
            const arr = ps as { seriesId: string; data: [number, number] }[];
            const e = arr.find((p) => p.seriesId === 'elev');
            const s = arr.find((p) => p.seriesId === 'slope');
            if (!e) return '';
            return `${t('dist')} ${(e.data[0] / 1000).toFixed(2)} km<br>${t('elevation')} ${e.data[1].toFixed(1)} m${
              s ? `<br>${t('slope')} ${s.data[1].toFixed(1)}°` : ''
            }`;
          },
        },
        xAxis: {
          type: 'value',
          min: 0,
          max: maxD,
          axisLabel: { color: '#8b95a5', formatter: (v: number) => `${(v / 1000).toFixed(1)} km` },
          axisLine: { lineStyle: { color: '#3a4350' } },
          splitLine: { show: false },
        },
        yAxis: [
          {
            type: 'value',
            scale: true,
            axisLabel: { color: '#8b95a5', formatter: (v: number) => `${v.toFixed(0)}` },
            splitLine: { lineStyle: { color: '#232a33' } },
            name: 'm',
            nameTextStyle: { color: '#8b95a5' },
          },
          {
            type: 'value',
            min: 0,
            max: 30,
            axisLabel: { color: '#6b7584', formatter: '{value}°' },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            id: 'slope',
            type: 'line',
            yAxisIndex: 1,
            data: profile.map((p) => [p.d_m, p.slope_deg]),
            showSymbol: false,
            lineStyle: { width: 1, color: '#5d6878' },
            markLine: {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: maxSlope }],
              lineStyle: { color: '#ff5c7a', type: 'dotted', width: 1 },
              label: { formatter: `${maxSlope}°`, color: '#ff5c7a', fontSize: 10 },
            },
          },
          {
            id: 'elev',
            type: 'line',
            data: profile.map((p) => [p.d_m, p.elev_m]),
            showSymbol: false,
            lineStyle: { width: 2, color: '#ff8a3d' },
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(255,138,61,0.35)' },
                { offset: 1, color: 'rgba(255,138,61,0.02)' },
              ]),
            },
          },
        ],
      },
      { notMerge: true },
    );
  }, [profile, maxSlope, lang, t]);

  // 当前位置和事件位置的竖线，按 10 米取整，避免每帧都重绘。
  // 上面的 setOption 用 notMerge 会清掉竖线，所以它的依赖（语言、坡度上限）变了也要重画。
  const dKey = Math.round(d / 10);
  useEffect(() => {
    const c = chart.current;
    if (!c || profile.length === 0) return;
    const marks: object[] = [{ xAxis: dKey * 10, lineStyle: { color: '#ffffff', width: 1.5, type: 'solid' } }];
    if (eventD != null) marks.push({ xAxis: eventD, lineStyle: { color: '#ff5c7a', width: 1.5, type: 'dashed' } });
    c.setOption({
      series: [{ id: 'elev', markLine: { silent: true, symbol: 'none', animation: false, label: { show: false }, data: marks } }],
    });
  }, [dKey, eventD, profile, maxSlope, lang, t]);

  return <div ref={el} className="profile" />;
}
