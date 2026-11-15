import L from 'leaflet';
import type { Grid } from './types';

// 全项目唯一的坐标换算处。
//
// 网格像素坐标：x 向右，y 向下，(0,0) 是左上角那一格的左上角，
// 和 GDAL 的像素坐标、geology.geojson 里的坐标一致。
// Leaflet CRS.Simple：lat 向上、lng 向右，所以 lat = -y，lng = x。
// 不要在别处手写 -y。

export function gridToLatLng(x: number, y: number): L.LatLng {
  return L.latLng(-y, x);
}

export function latLngToGrid(ll: L.LatLng): { x: number; y: number } {
  return { x: ll.lng, y: -ll.lat };
}

/** 格子索引（path、waypoints 里的整数 x/y）→ 该格中心点 */
export function cellToLatLng(ix: number, iy: number): L.LatLng {
  return gridToLatLng(ix + 0.5, iy + 0.5);
}

/** 整个网格的范围，所有 PNG 图层都拉伸到这个范围 */
export function gridBounds(g: Grid): L.LatLngBounds {
  return L.latLngBounds(gridToLatLng(0, g.height), gridToLatLng(g.width, 0));
}

/** 网格像素坐标 → 投影坐标（米），用 grid.json 里的 geotransform */
export function gridToProjected(g: Grid, x: number, y: number): { X: number; Y: number } {
  const [x0, a, b, y0, d, e] = g.geotransform;
  return { X: x0 + x * a + y * b, Y: y0 + x * d + y * e };
}
