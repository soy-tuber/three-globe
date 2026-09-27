// Number/time formatting for the Japanese UI.

export function yen(n: number, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const sign = n < 0 ? '−' : opts.sign ? '+' : '';
  const a = Math.abs(n);
  if (opts.compact) {
    if (a >= 1e8) return `${sign}¥${(a / 1e8).toFixed(a >= 1e9 ? 0 : 2)}億`;
    if (a >= 1e4) return `${sign}¥${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万`;
  }
  return `${sign}¥${Math.round(a).toLocaleString('ja-JP')}`;
}

export function int(n: number): string {
  return Math.round(n).toLocaleString('ja-JP');
}

export function duration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
}

export function km(n: number): string {
  return `${n.toFixed(n < 10 ? 1 : 0)} km`;
}
