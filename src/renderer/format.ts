export function bytes(value: number, digits = 1): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
  const scaled = value / 1000 ** exp;
  return scaled.toFixed(exp === 0 ? 0 : scaled >= 100 ? 0 : digits) + ' ' + units[exp];
}

export function rate(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? bytes(bytesPerSecond, 0) + '/s' : '—';
}

export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + 's';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm ' + Math.round(seconds % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

export function count(value: number): string {
  return value.toLocaleString();
}

/** Clock-style running time for video badges: 0:07, 1:23, 1:02:33. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}
