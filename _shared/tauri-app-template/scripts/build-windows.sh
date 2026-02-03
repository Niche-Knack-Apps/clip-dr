#!/bin/bash
# Windows build script for Tauri app (cross-compile from Linux)
# Produces: .msi, portable .exe
# Usage: ./scripts/build-windows.sh [version]
#
# Requirements:
#   - rustup target add x86_64-pc-windows-msvc
#   - Wine (for cross-compilation)
#   - Or run on Windows with build-windows.bat

set -e

cd "$(dirname "$0")/.."

VERSION=${1:-"1.0.0"}

echo "Building Windows packages for version $VERSION..."

# Check if running on Windows (Git Bash/WSL)
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    echo "Running on Windows, using native build..."
    powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 "$VERSION"
    exit $?
fi

# Cross-compile from Linux
echo "Cross-compiling for Windows from Linux..."

# Check for Windows target
if ! rustup target list --installed | grep -q "x86_64-pc-windows-msvc"; then
    echo "Installing Windows target..."
    rustup target add x86_64-pc-windows-msvc
fi

# Build frontend
echo "Building frontend..."
npm ci
npm run build

# Build Tauri app for Windows
echo "Building Tauri app for Windows..."
npm run tauri:build:windows

# Output location
echo ""
echo "Build complete! Packages available at:"
echo "  - src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/"
echo "  - src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/"
