const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Leaflet 弹窗用 HTML 字符串，数据里的文字要先转义 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => MAP[c]);
}
