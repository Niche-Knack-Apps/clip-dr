# Refactor: Unified Timeline Viewport Coordinate Mapping (v0.27.38)

## Context

Six components independently implement timeline↔pixel coordinate conversion. This refactor unifies **timeline/view** coordinate conversion across panels. It does **not** replace clip/source/buffer coordinate logic — those are separate semantic spaces.

### Coordinate spaces in Clip Dr.

1. **timelineTime** — absolute seconds on the global timeline
2. **viewportTime** — the visible zoomed window (start..end)
3. **contentX** — pixel position within scrollable timeline content
4. **clientX** — mouse event screen coordinates
5. **clipTime** — position within a clip's visible extent
6. **sourceTime** — position within the original audio file
7. **bufferTime** — position/sample index within an AudioBuffer

This refactor addresses spaces 1-4. Spaces 5-7 must remain separate.

## Design

### Layer 1: Pure mapper — `src/shared/timeline-coordinates.ts`

No Vue dependency. No `this`. Frozen for immutability.

```typescript
export interface TimeAxisMapper {
  timeToX(time: number): number;
  xToTimeRaw(x: number): number;
  xToTimeClamped(x: number): number;
  pixelsPerSecond(): number;
}

export function createTimeAxisMapper(
  startTime: number,
  endTime: number,
  width: number,
): TimeAxisMapper {
  const range = endTime - startTime;

  const timeToX = (time: number): number => {
    if (range <= 0 || width <= 0) return 0;
    return ((time - startTime) / range) * width;
  };

  const xToTimeRaw = (x: number): number => {
    if (width <= 0) return startTime;
    return (x / width) * range + startTime;
  };

  const xToTimeClamped = (x: number): number => {
    const t = xToTimeRaw(x);  // no `this` — direct closure reference
    return Math.max(startTime, Math.min(t, endTime));
  };

  const pixelsPerSecond = (): number => {
    return range > 0 ? width / range : 1;
  };

  return Object.freeze({ timeToX, xToTimeRaw, xToTimeClamped, pixelsPerSecond });
}

// DOM helper — separate from time math
export function clientXToLocalX(clientX: number, el: HTMLElement): number {
  return clientX - el.getBoundingClientRect().left;
}
```

**Key decisions:**
- Arrow functions → no `this` dependency → safe to destructure
- `Object.freeze` → guarantees purity, prevents accidental mutation
- `clientXToLocalX` is a standalone DOM utility, not part of the mapper

### Layer 2: Vue composable — `src/composables/useTimelineViewport.ts`

Thin reactive wrapper over the pure mapper.

```typescript
export function useTimelineViewport(
  startTime: MaybeRefOrGetter<number>,
  endTime: MaybeRefOrGetter<number>,
  containerWidth: MaybeRefOrGetter<number>,
) {
  const mapper = computed(() =>
    createTimeAxisMapper(toValue(startTime), toValue(endTime), toValue(containerWidth))
  );
  const pixelsPerSecond = computed(() => mapper.value.pixelsPerSecond());

  return {
    timeToX: (time: number) => mapper.value.timeToX(time),
    xToTimeRaw: (x: number) => mapper.value.xToTimeRaw(x),
    xToTimeClamped: (x: number) => mapper.value.xToTimeClamped(x),
    pixelsPerSecond,
  };
}
```

### Layer 3: Layout transform — `useTimelineViewportTransform`

Separate from the mapper — this is a **layout transform**, not time math. Only used by TrackList where scroll + panel offset apply.

```typescript
export function useTimelineViewportTransform(
  startTime: MaybeRefOrGetter<number>,
  endTime: MaybeRefOrGetter<number>,
  contentWidth: MaybeRefOrGetter<number>,
  scrollLeft: MaybeRefOrGetter<number>,
  panelWidth: MaybeRefOrGetter<number>,
) {
  const mapper = computed(() =>
    createTimeAxisMapper(toValue(startTime), toValue(endTime), toValue(contentWidth))
  );
  // content-space → viewport-space
  const timeToViewportX = (time: number): number =>
    mapper.value.timeToX(time) - toValue(scrollLeft) + toValue(panelWidth);
  // viewport-space → content-space → time
  const viewportXToTimeRaw = (x: number): number =>
    mapper.value.xToTimeRaw(x + toValue(scrollLeft) - toValue(panelWidth));

  return { mapper, timeToViewportX, viewportXToTimeRaw };
}
```

## Migration

| Component | Replace | With |
|-----------|---------|------|
| **FullWaveform.vue** | `timeToPixel()` | `useTimelineViewport(0, duration, containerWidth)` |
| **ZoomedWaveform.vue** | `timeToX()`, `xToTime()` | `useTimelineViewport(selection.start, selection.end, containerWidth)` |
| **SilenceOverlay.vue** | `pixelsPerSecond`, `xToTime()` | `useTimelineViewport(startTime, endTime, containerWidth)` |
| **SelectionWindow.vue** | `pixelsPerSecond`, `xToTime()` | `useTimelineViewport(0, duration, containerWidth)` |
| **Playhead.vue** | `xPosition`, `xToTime()` | `useTimelineViewport(startTime, endTime, containerWidth)` |
| **TrackLane.vue** | inline time-axis math only | `useTimelineViewport(0, duration, containerWidth)` |

### TrackLane caution
Only use the shared mapper for **time-axis calculations**. Layout geometry (panel width offsets, scroll position, clip drag hit-testing, ghost positioning, snap guides) stays local.

### What NOT to migrate
- `ClipRegion.vue` source/buffer offset math (clipTime/sourceTime space)
- `useWaveform.ts` bucket indexing (bufferTime space)
- `getClipAwareBucketsForLayer` source offset math (sourceTime space)
- Any `sourceOffset`, `sourceIn`, `clipStart - trackStart` calculations

## Tests

### Round-trip invariants (most valuable)
- `timeToX(xToTimeRaw(x)) ≈ x` for arbitrary x
- `xToTimeRaw(timeToX(t)) ≈ t` for arbitrary t
- Precision holds at large durations (>1 hour, >10000px width)

### Edge cases
- Zero width → `xToTimeRaw` returns startTime, `timeToX` returns 0
- Zero range (start == end) → `timeToX` returns 0
- Negative x → raw returns before startTime, clamped returns startTime
- x > width → raw returns past endTime, clamped returns endTime

### Behavioral
- `pixelsPerSecond` matches expected ratio
- `clientXToLocalX` correctly subtracts bounding rect
- Destructured functions work (no `this` dependency)
- Frozen mapper can't be mutated

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/timeline-coordinates.ts` | **New** — pure `createTimeAxisMapper` + `clientXToLocalX` |
| `src/composables/useTimelineViewport.ts` | **New** — Vue reactive wrapper + `useTimelineViewportTransform` |
| `src/components/waveform/FullWaveform.vue` | Replace `timeToPixel` |
| `src/components/waveform/ZoomedWaveform.vue` | Replace `timeToX`/`xToTime` |
| `src/components/waveform/SilenceOverlay.vue` | Replace `pixelsPerSecond`/`xToTime` |
| `src/components/waveform/SelectionWindow.vue` | Replace `pixelsPerSecond`/`xToTime` |
| `src/components/waveform/Playhead.vue` | Replace `xPosition`/`xToTime` |
| `src/components/tracks/TrackLane.vue` | Replace time-axis inline math only |
| `src/__tests__/timeline-coordinates.test.ts` | **New** — round-trip, edge, precision, destructure tests |
| Version files (4) | 0.27.37 → 0.27.38 |

## Scope statement

> This refactor unifies **timeline/view** coordinate conversion across panels. It does **not** replace clip/source/buffer coordinate logic.
>
> **Architectural rule:**
> - **Timeline/view coordinates** → `createTimeAxisMapper` / `useTimelineViewport`
> - **Layout transforms** (scroll, panel offset) → `useTimelineViewportTransform`
> - **Clip/source/buffer coordinates** → separate mappers (existing code, future `ClipCoordinateMapper`)
> - **Never mix spaces implicitly**

## Verification

1. `npx vue-tsc --noEmit` — type check
2. `npm test` — all tests pass (existing + new round-trip/edge tests)
3. **Runtime: Visual** — playhead, selection, markers, silence overlays align across all three views
4. **Runtime: Interaction** — click-to-seek, drag selection, drag overlays land at correct times
5. **Runtime: Multi-track** — two tracks at different positions → all overlays align
6. **Runtime: Zoom** — extreme zoom in/out → no precision drift
