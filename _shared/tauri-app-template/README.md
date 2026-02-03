# Niche-Knack Tauri App Template

Standard Tauri 2.0 shell for all Niche-Knack desktop applications.

## Features

- **Tauri 2.0** - Fast, lightweight desktop runtime (~5MB base)
- **TypeScript Frontend** - Type-safe IPC communication
- **AI Engine Integration** - JSON-RPC bridge to Python AI backend
- **Job Management** - Queue, progress tracking, cancellation
- **Settings Persistence** - Auto-saved to app data directory
- **Auto-Update Ready** - Configured for self-hosted update server

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://rustup.rs/) >= 1.70
- Platform-specific dependencies (see below)

### Linux (Ubuntu/Debian)

```bash
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
```

### macOS

```bash
xcode-select --install
```

### Windows

- Visual Studio Build Tools with C++ workload

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run tauri:dev

# Build for production
npm run tauri:build
```

## Project Structure

```
tauri-app-template/
├── src/                      # Frontend (TypeScript)
│   ├── index.html           # Main HTML
│   ├── main.ts              # Entry point + Tauri IPC
│   └── styles.css           # Base styles
├── src-tauri/               # Backend (Rust)
│   ├── src/
│   │   ├── main.rs          # Tauri entry
│   │   ├── lib.rs           # Command registration
│   │   ├── commands/        # IPC command handlers
│   │   │   ├── engine.rs    # Engine control
│   │   │   ├── jobs.rs      # Job management
│   │   │   ├── project.rs   # Project/file handling
│   │   │   └── settings.rs  # Settings storage
│   │   └── engine/          # AI engine bridge
│   │       ├── client.rs    # Spawn & communicate
│   │       └── types.rs     # JSON-RPC types
│   ├── Cargo.toml
│   └── tauri.conf.json
├── scripts/                  # Build scripts
│   ├── dev.sh
│   ├── build-linux.sh
│   ├── build-windows.sh
│   └── build-macos.sh
└── package.json
```

## Customizing for Your App

1. **Update metadata** in `src-tauri/tauri.conf.json`:
   - `productName`
   - `identifier`
   - `windows.title`

2. **Update package name** in `package.json`

3. **Replace frontend** in `src/`:
   - Keep `main.ts` exports for IPC
   - Replace `index.html` and `styles.css` with your UI

4. **Add app-specific commands** in `src-tauri/src/commands/`

5. **Configure engine path** based on your bundled Python engine

## Frontend API

The template exports ready-to-use APIs for communicating with the backend:

```typescript
import { engine, jobs, settings } from './main';

// Engine control
await engine.start();
await engine.stop();
const health = await engine.health();

// Generic engine call
const result = await engine.call('models.load', { modelId: 'whisper-small' });

// Job management
const { job_id } = await jobs.start('ocr', { imagePath: '/path/to/image.png' });
const status = await jobs.status(job_id);
await jobs.cancel(job_id);

// Listen for job events
const unlisten = await jobs.onEvent((event) => {
  console.log(event.type, event.data);
});

// Settings
const current = await settings.get();
await settings.set({ ...current, theme: 'dark' });
```

## Build Scripts

```bash
# Development
./scripts/dev.sh

# Production builds
./scripts/build-linux.sh 1.0.0    # AppImage, .deb
./scripts/build-windows.sh 1.0.0  # .msi, portable .exe
./scripts/build-macos.sh 1.0.0    # .dmg, .app
```

## Auto-Update

Configure your update server in `tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://your-server.com/releases/{{target}}/{{arch}}/{{current_version}}"
      ]
    }
  }
}
```

See the [Tauri Updater docs](https://v2.tauri.app/plugin/updater/) for key generation.

## GPU/VRAM Constraints

All AI workloads must function within a **6GB GPU VRAM budget**. See the development contract for model VRAM estimates and memory management guidelines.

## License

Proprietary - Niche-Knack Apps
