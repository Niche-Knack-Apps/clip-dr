#!/bin/bash
# Development Flatpak build script
# Builds natively first, then packages into Flatpak
#
# This is faster for development iteration. For production releases,
# use the full manifest with vendored dependencies.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
FLATPAK_DIR="$PROJECT_ROOT/packaging/flatpak"

echo "=== Clip Dr. Flatpak Development Build ==="
echo "Project root: $PROJECT_ROOT"
echo ""

# Step 1: Build the application natively
echo "=== Step 1: Building application natively ==="
cd "$PROJECT_ROOT"

# Install npm dependencies if needed
if [[ ! -d "node_modules" ]]; then
    echo "Installing npm dependencies..."
    npm install
fi

# Build frontend
echo "Building frontend..."
npm run build

# Build Rust backend
echo "Building Rust backend (release mode)..."
cd src-tauri
cargo build --release
cd ..

# Verify binary exists
if [[ ! -f "src-tauri/target/release/clip-dr" ]]; then
    echo "Error: Binary not found at src-tauri/target/release/clip-dr"
    exit 1
fi

echo "Binary built: $(ls -lh src-tauri/target/release/clip-dr | awk '{print $5}')"
echo ""

# Step 2: Build Flatpak using the dev manifest
echo "=== Step 2: Building Flatpak package ==="
cd "$FLATPAK_DIR"

# Clean previous builds
rm -rf build-dir .flatpak-builder/build

# Build using development manifest
flatpak-builder --force-clean --disable-rofiles-fuse build-dir com.nicheknack.clip-dr.dev.yml

echo ""
echo "=== Step 3: Installing locally ==="

# Install for current user
flatpak-builder --user --install --force-clean build-dir com.nicheknack.clip-dr.dev.yml

echo ""
echo "=== Build complete! ==="
echo ""
echo "To run: flatpak run com.nicheknack.clip-dr"
echo ""
echo "To create a distributable bundle:"
echo "  flatpak-builder --repo=repo --force-clean build-dir com.nicheknack.clip-dr.dev.yml"
echo "  flatpak build-bundle repo clip-dr.flatpak com.nicheknack.clip-dr"
