# Clip Dr. Editing Operations — Condition Matrix

## Selection Conditions

| Condition | Split (S) | Clip (C) | Cut (X) | Delete (Del) | Trim | Copy (Ctrl+C) | Paste (Ctrl+V) |
|-----------|-----------|----------|---------|-------------|------|---------------|----------------|
| **Mono track** | Split at playhead | Clip I/O region | Ripple delete I/O region | Delete I/O region | Trim clip edges | Copy I/O region | Paste at playhead |
| **Stereo linked** | Split both ch at I/O | Clip both ch at I/O (stereo output) | Ripple both ch at I/O | Delete both ch at I/O | Trim both ch edges | Copy both ch at I/O (stereo) | Paste stereo at playhead |
| **Stereo unlinked, no ch selected** | Split both lanes at I/O | Clip both lanes at I/O (stereo, **offset preserved**) | Ripple both lanes at I/O (**offset preserved**) | Delete both lanes at I/O | Trim both lane edges | Copy both lanes at I/O (stereo, **offset preserved**) | Paste stereo at playhead |
| **Stereo unlinked, L selected** | Split L lane only at playhead | Clip L lane only at I/O (mono output) | Ripple L lane only at I/O | Delete L lane region at I/O | Trim L lane edges only | Copy L lane at I/O (mono) | Paste into L lane at playhead |
| **Stereo unlinked, R selected** | Split R lane only at playhead | Clip R lane only at I/O (mono output) | Ripple R lane only at I/O | Delete R lane region at I/O | Trim R lane edges only | Copy R lane at I/O (mono) | Paste into R lane at playhead |
| **Multi-track selected** | Split ALL selected at playhead | Clip from all at I/O (mixdown, default configurable) | Ripple delete I/O from ALL | Delete I/O from ALL | N/A (per-clip) | Copy mixdown of all at I/O (default, configurable) | Paste creates new track |

## Key Notes

- **"at I/O"** means the operation uses the in/out point region (if set), otherwise full track/clip
- **"offset preserved"** means when both lanes are unlinked and at different positions, the per-channel timing is maintained in the output
- **Multi-track copy** is mixdown by default, configurable in settings to copy per-track separately

## Selection Interactions

- **Click track header** → select only that track (deselect others)
- **Ctrl+click track header** → toggle that track in selection (add/remove)
- **Shift+click track header** → select range from last selected to clicked
- **Click channel lane** (unlinked stereo) → select that track + that channel
- **Click outside all tracks** → select ALL (composite view)

## Track Dropdown Menu (Stereo)

```
Clone L channel         [stereo output, L on both]
Clone R channel         [stereo output, R on both]
Keep L channel          [mono output, just L]
Keep R channel          [mono output, just R]
Convert to Mono (L+R)   [mono output, average]
─────────────────
Link/Unlink channels
─────────────────
Rename
Delete Track
```

## Track Dropdown Menu (Mono)

```
Convert to Stereo       [stereo output, duplicated]
─────────────────
Rename
Delete Track
```

## Central Dispatch Rule

**ALL editing operations MUST call `getEditTargets()` to determine what to affect.** This function is the SINGLE entry point for selection-aware editing. Never bypass it.

```typescript
interface EditTargets {
  trackIds: string[];
  channelIndex: number | null; // null = all channels
  mode: 'all' | 'single' | 'multi';
}
```
