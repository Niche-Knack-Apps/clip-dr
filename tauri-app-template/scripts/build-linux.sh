#!/bin/bash
# Linux build script for Tauri app
# Produces: AppImage, .deb
# Usage: ./scripts/build-linux.sh [version]

set -e

cd "$(dirname "$0")/.."

VERSION=${1:-"1.0.0"}

echo "Building Linux packages for version $VERSION..."

# Check dependencies
if ! command -v cargo &> /dev/null; then
    echo "Error: Rust/Cargo not found. Please install rustup."
    exit 1
fi

# Install required libraries if on Ubuntu/Debian
if command -v apt &> /dev/null; then
    echo "Checking system dependencies..."
    sudo apt-get update
    sudo apt-get install -y \
        libwebkit2gtk-4.1-dev \
        libappindicator3-dev \
        librsvg2-dev \
        patchelf \
        libssl-dev
fi

# Build frontend
echo "Building frontend..."
npm ci
npm run build

# Build Tauri app
echo "Building Tauri app..."
npm run tauri:build:linux

# Output location
echo ""
echo "Build complete! Packages available at:"
echo "  - src-tauri/target/release/bundle/appimage/"
echo "  - src-tauri/target/release/bundle/deb/"
