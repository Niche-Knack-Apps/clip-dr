#!/bin/bash
# Build all Niche-Knack applications
# Usage: ./build-all.sh <version> [platform]
#
# Platforms: linux, windows, macos, all (default: all)

set -e

VERSION=${1:-"1.0.0"}
PLATFORM=${2:-"all"}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASES_DIR="$SCRIPT_DIR"

# Apps to build (in order)
APPS=(
    "lamplighter"
    "gnucash-reporter"
    "by-metes-and-bounds"
    "das-bomb"
    "lifespeed"
    "poetryscribe"
    "messy-mind"
    "window-cleaner"
)

echo "============================================"
echo "Niche-Knack Build Script"
echo "Version: $VERSION"
echo "Platform: $PLATFORM"
echo "============================================"
echo ""

# Build AI engine first
build_engine() {
    echo "Building AI Engine..."
    cd "$ROOT_DIR/ai-engine"

    if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "linux" ]; then
        echo "  Building for Linux..."
        ./build/build-linux.sh
        cp dist/engine-linux "$RELEASES_DIR/engine/"
    fi

    if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "windows" ]; then
        echo "  Building for Windows..."
        if [ -f build/build-windows.sh ]; then
            ./build/build-windows.sh
            cp dist/engine-windows.exe "$RELEASES_DIR/engine/"
        else
            echo "  Skipping Windows (no build script or not on Windows)"
        fi
    fi

    if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "macos" ]; then
        echo "  Building for macOS..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            ./build/build-macos.sh
            cp dist/engine-macos "$RELEASES_DIR/engine/"
        else
            echo "  Skipping macOS (must build on macOS)"
        fi
    fi

    echo "  Engine build complete!"
    echo ""
}

# Build a single app
build_app() {
    local app=$1
    local app_dir="$ROOT_DIR/$app"
    local out_dir="$RELEASES_DIR/apps/$app"

    echo "Building $app..."

    # Check if app has been migrated to Tauri
    if [ ! -f "$app_dir/src-tauri/tauri.conf.json" ]; then
        echo "  Skipping: Not yet migrated to Tauri"
        echo ""
        return
    fi

    cd "$app_dir"

    # Ensure output directory exists
    mkdir -p "$out_dir"

    # Install dependencies
    npm ci

    # Update version
    npm version "$VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true

    # Build for target platform(s)
    if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "linux" ]; then
        echo "  Building for Linux..."
        npm run tauri:build:linux

        # Copy artifacts
        find src-tauri/target/release/bundle -name "*.AppImage" -exec cp {} "$out_dir/${app}-${VERSION}-linux.AppImage" \;
        find src-tauri/target/release/bundle -name "*.deb" -exec cp {} "$out_dir/${app}-${VERSION}-linux.deb" \;
    fi

    if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "windows" ]; then
        echo "  Building for Windows..."
        npm run tauri:build:windows 2>/dev/null || echo "  Windows build skipped (cross-compile may not be configured)"

        # Copy artifacts if they exist
        find src-tauri/target -name "*.msi" -exec cp {} "$out_dir/${app}-${VERSION}-windows.msi" \; 2>/dev/null || true
    fi

    if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "macos" ]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            echo "  Building for macOS..."
            npm run tauri:build:mac

            # Copy artifacts
            find src-tauri/target/release/bundle -name "*.dmg" -exec cp {} "$out_dir/${app}-${VERSION}-macos.dmg" \;
        else
            echo "  Skipping macOS (must build on macOS)"
        fi
    fi

    echo "  $app build complete!"
    echo ""
}

# Main build sequence
echo "Step 1: Building AI Engine"
echo "-------------------------------------------"
build_engine

echo "Step 2: Building Applications"
echo "-------------------------------------------"
for app in "${APPS[@]}"; do
    build_app "$app"
done

echo "Step 3: Generating Release Manifest"
echo "-------------------------------------------"
cd "$RELEASES_DIR/update-server"
./generate-manifest.sh "$VERSION"

echo ""
echo "============================================"
echo "Build Complete!"
echo "============================================"
echo ""
echo "Artifacts available at:"
echo "  Engine: $RELEASES_DIR/engine/"
echo "  Apps:   $RELEASES_DIR/apps/"
echo "  Manifest: $RELEASES_DIR/update-server/releases.json"
echo ""
echo "Next steps:"
echo "  1. Test each app locally"
echo "  2. Sign artifacts (if configured)"
echo "  3. Upload to release server"
echo "  4. Update releases.json on server"
