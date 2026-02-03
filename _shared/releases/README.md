# Niche-Knack Releases

This directory contains release artifacts and update server configuration for all Niche-Knack desktop applications.

## Directory Structure

```
releases/
├── engine/                    # Python AI engine binaries
│   ├── engine-linux           # Linux x86_64 binary
│   ├── engine-windows.exe     # Windows x86_64 binary
│   └── engine-macos           # macOS binary (unsigned)
├── apps/                      # Application releases (by app name)
│   ├── lamplighter/
│   ├── gnucash-reporter/
│   ├── by-metes-and-bounds/
│   ├── das-bomb/
│   ├── lifespeed/
│   ├── poetryscribe/
│   ├── messy-mind/
│   └── window-cleaner/
└── update-server/             # Auto-update configuration
    ├── releases.json          # Update manifest
    └── generate-manifest.sh   # Manifest generator
```

## Building Releases

### AI Engine

```bash
cd ai-engine
./build/build-linux.sh
./build/build-windows.bat
./build/build-macos.sh

# Copy to releases
cp dist/engine-* ../releases/engine/
```

### Individual App

```bash
cd apps/lamplighter
npm run tauri:build
# Outputs in src-tauri/target/release/bundle/
```

### All Apps

```bash
./releases/build-all.sh 1.2.3
```

## Update Server

The update server provides a simple JSON manifest that Tauri's updater plugin checks for new versions.

### Manifest Format

```json
{
  "lamplighter": {
    "version": "1.2.3",
    "notes": "Release notes here",
    "pub_date": "2025-01-15T00:00:00Z",
    "platforms": {
      "linux-x86_64": {
        "url": "https://releases.niche-knack.com/apps/lamplighter/lamplighter-1.2.3-linux.AppImage",
        "signature": "base64-encoded-signature"
      }
    }
  }
}
```

### Hosting Options

1. **GitHub Releases** - Free, reliable, uses GitHub's CDN
2. **Self-hosted** - Full control, requires server setup
3. **Cloudflare R2** - S3-compatible, low cost, global CDN

## Signing (Optional)

For auto-updates to work securely, releases should be signed:

```bash
# Generate key pair (one time)
tauri signer generate -w releases/update-server/private.key

# Sign during build (handled by tauri.conf.json)
# Configure pubkey in each app's tauri.conf.json
```

Note: Code signing for macOS/Windows distribution requires paid certificates. Apps work without signing but show security warnings.

## Version Management

All apps share version numbers when released together, or can be versioned independently.

Update version in:
- `package.json` (npm version)
- `src-tauri/tauri.conf.json` (Tauri version)
- `src-tauri/Cargo.toml` (Rust version)
