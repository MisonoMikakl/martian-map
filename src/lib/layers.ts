import { RASTER_LAYERS } from './data';

export type RasterId = (typeof RASTER_LAYERS)[number]['id'];
export type LayerKey = RasterId | 'geology' | 'envelope' | 'route';
export type LayerState = Record<LayerKey, boolean>;

export const DEFAULT_LAYERS: LayerState = {
  ...(Object.fromEntries(RASTER_LAYERS.map((l) => [l.id, l.on])) as Record<RasterId, boolean>),
  geology: false,
  envelope: true,
  route: true,
};

export const ALL_OFF: LayerState = Object.fromEntries(Object.keys(DEFAULT_LAYERS).map((k) => [k, false])) as LayerState;
