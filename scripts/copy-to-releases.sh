#!/bin/bash
# Copy Tauri build artifacts to standardized release directory
# Builds for all platforms: Linux (native + Flatpak), Windows (VM), macOS (VM), Android, iOS
#
# VM builds use the shared infrastructure in _shared/vm-build/
# VMs: win11-build (Windows), arch-build (Arch Linux), macos-build (macOS/iOS)
# Manage VMs: _shared/vm-build/vm-manager.sh {start|stop|status}

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# App-specific configuration
APP_NAME="project-scrubs-clip-dr"
BINARY_NAME="clip-doctor-scrubs"
APP_ID="com.nicheknack.clip-doctor-scrubs"
VERSION=$(node -p "require('./package.json').version")
RELEASES_DIR="../_shared/releases/$APP_NAME"
FLATPAK_DIR="$PROJECT_ROOT/packaging/flatpak"

# Source shared VM build infrastructure
VMBUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../_shared/vm-build" && pwd)"
source "${VMBUILD_DIR}/vm-build.sh"

echo "========================================"
echo "Building $APP_NAME v$VERSION"
echo "========================================"
echo ""

mkdir -p "$RELEASES_DIR"/{linux,windows,mac,android,ios}

# =============================================================================
# PHASE 1: Copy local build artifacts (from native tauri build)
# =============================================================================
echo "[Phase 1] Copying local build artifacts..."

# Linux (from native build)
find src-tauri/target/release/bundle -name "*.AppImage" -exec cp {} "$RELEASES_DIR/linux/" \; 2>/dev/null || true
find src-tauri/target/release/bundle -name "*.deb" -exec cp {} "$RELEASES_DIR/linux/" \; 2>/dev/null || true
find src-tauri/target/release/bundle -name "*.rpm" -exec cp {} "$RELEASES_DIR/linux/" \; 2>/dev/null || true

# Windows (if cross-compiled or from VM)
find src-tauri/target -name "*.msi" -exec cp {} "$RELEASES_DIR/windows/" \; 2>/dev/null || true
find src-tauri/target -name "*.exe" -path "*/bundle/*" -exec cp {} "$RELEASES_DIR/windows/" \; 2>/dev/null || true

# macOS (if cross-compiled or from VM)
find src-tauri/target/release/bundle -name "*.dmg" -exec cp {} "$RELEASES_DIR/mac/" \; 2>/dev/null || true
find src-tauri/target/release/bundle -name "*.app" -exec cp -r {} "$RELEASES_DIR/mac/" \; 2>/dev/null || true

# Android
find src-tauri/gen/android -name "*.apk" -exec cp {} "$RELEASES_DIR/android/" \; 2>/dev/null || true
find src-tauri/gen/android -name "*.aab" -exec cp {} "$RELEASES_DIR/android/" \; 2>/dev/null || true

# iOS
find src-tauri/gen/apple -name "*.ipa" -exec cp {} "$RELEASES_DIR/ios/" \; 2>/dev/null || true

echo "  Local artifacts copied."

# =============================================================================
# PHASE 2: Build Flatpak (Linux)
# =============================================================================
echo ""
echo "[Phase 2] Building Flatpak..."

if command -v flatpak-builder &> /dev/null && [[ -f "$FLATPAK_DIR/$APP_ID.dev.yml" ]]; then
    if [[ -f "src-tauri/target/release/$BINARY_NAME" ]]; then
        (
            cd "$FLATPAK_DIR"

            # Clean previous builds
            rm -rf build-dir repo .flatpak-builder/build 2>/dev/null || true

            # Build to repo
            echo "  Creating Flatpak repo..."
            flatpak-builder --force-clean --disable-rofiles-fuse --repo=repo build-dir $APP_ID.dev.yml

            # Create bundle with runtime repo URL for easy distribution
            FLATPAK_BUNDLE="${BINARY_NAME}-${VERSION}.flatpak"
            echo "  Creating distributable bundle: $FLATPAK_BUNDLE"
            flatpak build-bundle repo "$FLATPAK_BUNDLE" $APP_ID \
                --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo

            # Move to releases
            mv "$FLATPAK_BUNDLE" "$PROJECT_ROOT/$RELEASES_DIR/linux/"

            # Clean up build artifacts (keep cache for faster rebuilds)
            rm -rf build-dir repo

            echo "  Flatpak bundle created: $RELEASES_DIR/linux/$FLATPAK_BUNDLE"
        ) || echo "  WARNING: Flatpak build failed (non-fatal, continuing)"
    else
        echo "  Skipping Flatpak: binary not found at src-tauri/target/release/$BINARY_NAME"
    fi
else
    echo "  Skipping: flatpak-builder not found or no manifest"
    echo "  Install with: sudo apt install flatpak-builder"
fi

# =============================================================================
# PHASE 3: Windows Build (Podman cross-compilation)
# =============================================================================
echo ""
echo "[Phase 3] Windows Build (Podman)..."
WIN_BUILDER="$PROJECT_ROOT/../_shared/builders/windows/build.sh"
if [[ -f "$WIN_BUILDER" ]]; then
    "$WIN_BUILDER" "$APP_NAME" || true
else
    echo "  Skipping: Windows builder not found at $WIN_BUILDER"
fi

# =============================================================================
# PHASE 4: macOS VM Build (macos-build) - also handles iOS
# =============================================================================
echo ""
echo "[Phase 4] macOS VM Build..."
vm_build_tauri_macos "$APP_NAME" "$RELEASES_DIR/mac" "$PROJECT_ROOT" || true

echo ""
echo "[Phase 4b] iOS Build (via macOS VM)..."
vm_build_ios "$APP_NAME" "$RELEASES_DIR/ios" "$PROJECT_ROOT" || true

# =============================================================================
# PHASE 5: Arch Linux Build (Podman)
# =============================================================================
echo ""
echo "[Phase 5] Arch Linux Build (Podman)..."
ARCH_BUILDER="$PROJECT_ROOT/../_shared/builders/arch/build.sh"
if [[ -f "$ARCH_BUILDER" ]]; then
    "$ARCH_BUILDER" "$APP_NAME" || true
else
    echo "  Skipping: Arch builder not found at $ARCH_BUILDER"
fi

# =============================================================================
# SUMMARY
# =============================================================================
echo ""
echo "========================================"
echo "Build Complete: $APP_NAME v$VERSION"
echo "========================================"
echo ""
echo "Release artifacts in $RELEASES_DIR:"
echo ""
echo "Linux:"
ls -lh "$RELEASES_DIR/linux/" 2>/dev/null || echo "  (none)"
echo ""
echo "Windows:"
ls -lh "$RELEASES_DIR/windows/" 2>/dev/null || echo "  (none)"
echo ""
echo "macOS:"
ls -lh "$RELEASES_DIR/mac/" 2>/dev/null || echo "  (none)"
echo ""
echo "Android:"
ls -lh "$RELEASES_DIR/android/" 2>/dev/null || echo "  (none)"
echo ""
echo "iOS:"
ls -lh "$RELEASES_DIR/ios/" 2>/dev/null || echo "  (none)"
echo ""
echo "========================================"
echo "Build Infrastructure:"
echo "  Windows:    Podman container (niche-knack/windows-builder)"
echo "  Arch Linux: Podman container (niche-knack/arch-builder)"
echo "  macOS:      localhost:${MACOS_BUILD_SSH_PORT:-2224} ($(vm_is_reachable macos 2>/dev/null && echo 'REACHABLE' || echo 'OFFLINE/VM'))"
echo "========================================"
