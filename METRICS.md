# Niche-Knack Desktop Apps - Performance Metrics

This document tracks baseline and post-optimization metrics for all desktop applications.

## Measurement Methodology

### Cold Startup Time
- Fresh boot (reboot system or clear filesystem cache)
- Time from launch command to window visible and interactive
- Measured with `time` command or Electron's ready-to-show event

### Warm Startup Time
- Second launch immediately after closing
- App data cached in memory/disk
- Time from launch command to window visible

### Idle RAM
- Measured 30 seconds after startup
- No user interaction
- Use `ps aux` or system monitor

### Bundle Size
- Production build (AppImage for Linux)
- Includes all dependencies
- Measured with `du -h` or `ls -lh`

---

## Phase 0: Baseline Metrics (Pre-Optimization)

| App | Electron Ver | Cold Start | Warm Start | Idle RAM | Bundle Size | Pain Point |
|-----|-------------|------------|------------|----------|-------------|------------|
| lamplighter | 28.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | ___ |
| gnucash-reporter | 34.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | ___ |
| by-metes-and-bounds | 28.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | ___ |
| das-bomb | 28.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | Sync binary checks blocking startup |
| lifespeed | 28.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | Unbounded file watcher events |
| poetryscribe | 28.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | Dual SQLite libraries |
| messy-mind | 29.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | 6 services loaded synchronously |
| window-cleaner | 34.0.0 | ___ ms | ___ ms | ___ MB | ___ MB | 20+ services, eager model loading |

### Native Modules by App

| App | Native Modules |
|-----|----------------|
| lamplighter | None |
| gnucash-reporter | None |
| by-metes-and-bounds | None |
| das-bomb | None (external binaries: syft, grype) |
| lifespeed | None |
| poetryscribe | sql.js, better-sqlite3 |
| messy-mind | better-sqlite3, tesseract.js |
| window-cleaner | better-sqlite3, sharp, onnxruntime-node, @tensorflow/tfjs-node |

---

## Phase 3: Post-Electron Optimization

Expected improvement: 20-40% across metrics

| App | Cold Start | Warm Start | Idle RAM | Bundle Size | Notes |
|-----|------------|------------|----------|-------------|-------|
| lamplighter | ___ ms | ___ ms | ___ MB | ___ MB | +v8-compile-cache |
| gnucash-reporter | ___ ms | ___ ms | ___ MB | ___ MB | +v8-compile-cache |
| by-metes-and-bounds | ___ ms | ___ ms | ___ MB | ___ MB | +v8-compile-cache |
| das-bomb | ___ ms | ___ ms | ___ MB | ___ MB | +async checks, process queue |
| lifespeed | ___ ms | ___ ms | ___ MB | ___ MB | +debounced watcher |
| poetryscribe | ___ ms | ___ ms | ___ MB | ___ MB | +single SQLite |
| messy-mind | ___ ms | ___ ms | ___ MB | ___ MB | +lazy services |
| window-cleaner | ___ ms | ___ ms | ___ MB | ___ MB | +service factory |

---

## Post-Tauri Migration

Target metrics:
- Cold startup: < 1 second
- Warm startup: < 500ms
- Idle RAM: < 100MB
- Bundle size: < 50MB

| App | Cold Start | Warm Start | Idle RAM | Bundle Size | Migration Wave |
|-----|------------|------------|----------|-------------|----------------|
| lamplighter | ___ ms | ___ ms | ___ MB | ___ MB | Wave 1 |
| gnucash-reporter | ___ ms | ___ ms | ___ MB | ___ MB | Wave 1 |
| by-metes-and-bounds | ___ ms | ___ ms | ___ MB | ___ MB | Wave 2 |
| das-bomb | ___ ms | ___ ms | ___ MB | ___ MB | Wave 2 |
| lifespeed | ___ ms | ___ ms | ___ MB | ___ MB | Wave 2 |
| poetryscribe | ___ ms | ___ ms | ___ MB | ___ MB | Wave 2 |
| messy-mind | ___ ms | ___ ms | ___ MB | ___ MB | Wave 3 |
| window-cleaner | ___ ms | ___ ms | ___ MB | ___ MB | Wave 3 |

---

## Comparison Summary

| Metric | Electron Baseline | Electron Optimized | Tauri | Improvement |
|--------|-------------------|--------------------| ------|-------------|
| Avg Cold Start | ___ ms | ___ ms | ___ ms | ___% |
| Avg Warm Start | ___ ms | ___ ms | ___ ms | ___% |
| Avg Idle RAM | ___ MB | ___ MB | ___ MB | ___% |
| Avg Bundle Size | ___ MB | ___ MB | ___ MB | ___% |

---

## Measurement Scripts

### Linux Cold Start Measurement
```bash
#!/bin/bash
# Clear filesystem cache (requires sudo)
sync && echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null

# Measure startup time
APP_PATH="./dist/linux-unpacked/app-name"
time (
    $APP_PATH &
    APP_PID=$!
    # Wait for window to appear (adjust selector as needed)
    while ! xdotool search --name "App Window Title" 2>/dev/null; do
        sleep 0.1
    done
    kill $APP_PID 2>/dev/null
)
```

### RAM Measurement
```bash
#!/bin/bash
APP_NAME="app-name"
sleep 30  # Wait for idle state
ps aux | grep -E "^[^ ]+ +[0-9]+ .* ${APP_NAME}" | awk '{sum += $6} END {print sum/1024 " MB"}'
```

### Bundle Size Measurement
```bash
#!/bin/bash
for app in lamplighter gnucash-reporter by-metes-and-bounds das-bomb lifespeed poetryscribe messy-mind window-cleaner; do
    size=$(du -sh "$app/dist/"*.AppImage 2>/dev/null | cut -f1)
    echo "$app: $size"
done
```

---

## Notes

- All measurements should be taken on the same hardware for consistency
- Disable background processes and network during testing
- Run each measurement 3 times and average
- Document hardware specs used for testing

### Test Hardware
- CPU: ___
- RAM: ___ GB
- Storage: ___ (SSD/HDD)
- OS: ___
- Kernel: ___
