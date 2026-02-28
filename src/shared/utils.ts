export function generateId(): string {
  return crypto.randomUUID();
}

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export function parseTime(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    const [mins, secsAndMs] = parts;
    const [secs, ms] = secsAndMs.split('.');
    return parseInt(mins) * 60 + parseInt(secs) + (parseInt(ms || '0') / 100);
  }
  return parseFloat(timeStr) || 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  return (...args: Parameters<T>) => {
    const now = performance.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  };
}

export function fuzzyMatch(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;

  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;

  let matches = 0;
  const len = Math.min(s1.length, s2.length);

  for (let i = 0; i < len; i++) {
    if (s1[i] === s2[i]) matches++;
  }

  return matches / Math.max(s1.length, s2.length);
}

export function binarySearch<T>(
  arr: T[],
  target: number,
  getValue: (item: T) => number
): number {
  let low = 0;
  let high = arr.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = getValue(arr[mid]);

    if (value === target) return mid;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }

  return low;
}

export function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function getFileExtension(path: string): string {
  const name = getFileName(path);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 ? name.slice(dotIndex).toLowerCase() : '';
}

// ── Color utilities ──

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function lightenHex(hex: string): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 60);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 60);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 60);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ── Audio volume utilities ──

export function linearToDb(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function formatDb(linear: number): string {
  if (linear <= 0) return '-inf';
  const db = linearToDb(linear);
  if (db > 0) return `+${db.toFixed(1)}`;
  return db.toFixed(1);
}
