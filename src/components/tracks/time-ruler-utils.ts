export interface RulerTick {
  time: number;
  x: number;
  label: string | null;
}

const INTERVALS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const MIN_TICK_PX = 60;
const MIN_LABEL_PX = 80;

export function generateTicks(
  containerWidth: number,
  timelineDuration: number,
  timeFormat: 'hms' | 'ms',
): RulerTick[] {
  if (timelineDuration <= 0 || containerWidth <= 0) return [];

  const pxPerSec = containerWidth / timelineDuration;

  // Pick smallest interval with >= MIN_TICK_PX spacing
  let interval = INTERVALS[INTERVALS.length - 1];
  for (const iv of INTERVALS) {
    if (iv * pxPerSec >= MIN_TICK_PX) {
      interval = iv;
      break;
    }
  }

  // Determine label frequency: every Nth tick gets a label (>= MIN_LABEL_PX apart)
  const tickPx = interval * pxPerSec;
  const labelEvery = Math.max(1, Math.ceil(MIN_LABEL_PX / tickPx));

  const ticks: RulerTick[] = [];
  let tickIndex = 0;

  for (let t = 0; t <= timelineDuration; t = tickIndex * interval) {
    const x = (t / timelineDuration) * containerWidth;

    let label: string | null = null;
    if (tickIndex % labelEvery === 0) {
      // Edge clipping: suppress labels too close to edges
      const leftClip = x < 15;
      const rightClip = containerWidth - x < 25;
      if (!leftClip && !rightClip) {
        label = formatRulerTime(t, interval, timeFormat);
      }
    }

    ticks.push({ time: t, x, label });
    tickIndex++;

    // Prevent infinite loop for edge case
    if (tickIndex > 100000) break;
  }

  return ticks;
}

export function formatRulerTime(
  seconds: number,
  interval: number,
  timeFormat: 'hms' | 'ms',
): string {
  // Sub-second intervals: show decimal seconds
  if (interval < 1) {
    return seconds.toFixed(1);
  }

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0 || seconds >= 3600) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  if (timeFormat === 'ms') {
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // hms format, under 1 hour
  return `${m}:${s.toString().padStart(2, '0')}`;
}
