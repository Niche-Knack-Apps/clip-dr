#!/bin/bash
# Copy Tauri build artifacts to standardized release directory
# Also builds Flatpak if flatpak-builder is available

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

APP_NAME="project-scrubs-clip-dr"
VERSION=$(node -p "require('./package.json').version")
RELEASES_DIR="../_shared/releases/$APP_NAME/tauri"
FLATPAK_DIR="$PROJECT_ROOT/packaging/flatpak"

echo "Copying $APP_NAME v$VERSION build artifacts to releases..."

mkdir -p "$RELEASES_DIR"/{linux,windows,mac,android,ios}

# Linux
find src-tauri/target/release/bundle -name "*.AppImage" -exec cp {} "$RELEASES_DIR/linux/" \; 2>/dev/null || true
find src-tauri/target/release/bundle -name "*.deb" -exec cp {} "$RELEASES_DIR/linux/" \; 2>/dev/null || true
find src-tauri/target/release/bundle -name "*.rpm" -exec cp {} "$RELEASES_DIR/linux/" \; 2>/dev/null || true

# Windows
find src-tauri/target -name "*.msi" -exec cp {} "$RELEASES_DIR/windows/" \; 2>/dev/null || true
find src-tauri/target -name "*.exe" -path "*/bundle/*" -exec cp {} "$RELEASES_DIR/windows/" \; 2>/dev/null || true

# macOS
find src-tauri/target/release/bundle -name "*.dmg" -exec cp {} "$RELEASES_DIR/mac/" \; 2>/dev/null || true
find src-tauri/target/release/bundle -name "*.app" -exec cp -r {} "$RELEASES_DIR/mac/" \; 2>/dev/null || true

# Android
find src-tauri/gen/android -name "*.apk" -exec cp {} "$RELEASES_DIR/android/" \; 2>/dev/null || true
find src-tauri/gen/android -name "*.aab" -exec cp {} "$RELEASES_DIR/android/" \; 2>/dev/null || true

# iOS
find src-tauri/gen/apple -name "*.ipa" -exec cp {} "$RELEASES_DIR/ios/" \; 2>/dev/null || true

echo "Tauri artifacts copied to $RELEASES_DIR"

# Build Flatpak if flatpak-builder is available and we're on Linux
if command -v flatpak-builder &> /dev/null && [[ -f "$FLATPAK_DIR/com.nicheknack.clip-doctor-scrubs.dev.yml" ]]; then
    echo ""
    echo "Building Flatpak..."

    # Check if the binary exists
    if [[ -f "src-tauri/target/release/clip-doctor-scrubs" ]]; then
        cd "$FLATPAK_DIR"

        # Clean previous builds
        rm -rf build-dir repo .flatpak-builder/build 2>/dev/null || true

        # Build to repo
        echo "  Creating Flatpak repo..."
        flatpak-builder --force-clean --disable-rofiles-fuse --repo=repo build-dir com.nicheknack.clip-doctor-scrubs.dev.yml

        # Create bundle with runtime repo URL for easy distribution
        FLATPAK_BUNDLE="clip-doctor-scrubs-${VERSION}.flatpak"
        echo "  Creating distributable bundle: $FLATPAK_BUNDLE"
        flatpak build-bundle repo "$FLATPAK_BUNDLE" com.nicheknack.clip-doctor-scrubs \
            --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo

        # Move to releases
        mv "$FLATPAK_BUNDLE" "$PROJECT_ROOT/$RELEASES_DIR/linux/"

        # Clean up build artifacts (keep cache for faster rebuilds)
        rm -rf build-dir repo

        echo "  Flatpak bundle created: $RELEASES_DIR/linux/$FLATPAK_BUNDLE"
    else
        echo "  Skipping Flatpak: binary not found at src-tauri/target/release/clip-doctor-scrubs"
    fi
else
    echo ""
    echo "Note: flatpak-builder not found, skipping Flatpak build"
    echo "  Install with: sudo apt install flatpak-builder (or equivalent)"
fi

echo ""
echo "Done! All artifacts copied to $RELEASES_DIR"
echo ""
echo "Linux artifacts:"
ls -lh "$RELEASES_DIR/linux/" 2>/dev/null || echo "  (none)"
