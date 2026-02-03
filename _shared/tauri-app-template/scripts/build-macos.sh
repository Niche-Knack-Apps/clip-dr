#!/bin/bash
# macOS build script for Tauri app
# Produces: .dmg, .app bundle
# Usage: ./scripts/build-macos.sh [version]
#
# Note: Must be run on macOS. Cross-compilation from Linux is not supported.

set -e

cd "$(dirname "$0")/.."

VERSION=${1:-"1.0.0"}

echo "Building macOS packages for version $VERSION..."

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "Error: macOS builds must be run on macOS."
    echo "Cross-compilation from Linux is not supported for macOS targets."
    exit 1
fi

# Check dependencies
if ! command -v cargo &> /dev/null; then
    echo "Error: Rust/Cargo not found. Please install rustup."
    exit 1
fi

# Build frontend
echo "Building frontend..."
npm ci
npm run build

# Build Tauri app
echo "Building Tauri app..."
npm run tauri:build:mac

# Output location
echo ""
echo "Build complete! Packages available at:"
echo "  - src-tauri/target/release/bundle/dmg/"
echo "  - src-tauri/target/release/bundle/macos/"
echo ""
echo "Note: App is unsigned. For distribution, you'll need:"
echo "  1. Apple Developer account"
echo "  2. Code signing certificate"
echo "  3. Notarization"
