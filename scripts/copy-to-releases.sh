#!/bin/bash
# Copy Tauri build artifacts to standardized release directory
# Builds for all platforms: Linux (native + Flatpak), Windows (VM), macOS (VM), Android, iOS
#
# VM Configuration (set these environment variables or edit the defaults below):
#   WINDOWS_VM_HOST    - Windows VM hostname/IP for SSH builds
#   MACOS_VM_HOST      - macOS VM hostname/IP for SSH builds
#   ARCH_VM_HOST       - Arch Linux VM hostname/IP for alternate Linux builds
#   VM_USER            - SSH username for VM connections (default: builder)
#   VM_PROJECT_PATH    - Path to project on VMs (default: ~/Projects/$APP_NAME)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# App-specific configuration
APP_NAME="project-scrubs-clip-dr"
BINARY_NAME="clip-doctor-scrubs"
APP_ID="com.nicheknack.clip-doctor-scrubs"
VERSION=$(node -p "require('./package.json').version")
RELEASES_DIR="../_shared/releases/$APP_NAME/tauri"
FLATPAK_DIR="$PROJECT_ROOT/packaging/flatpak"

# VM Configuration (override with environment variables)
WINDOWS_VM_HOST="${WINDOWS_VM_HOST:-}"
MACOS_VM_HOST="${MACOS_VM_HOST:-}"
ARCH_VM_HOST="${ARCH_VM_HOST:-}"
VM_USER="${VM_USER:-builder}"
VM_PROJECT_PATH="${VM_PROJECT_PATH:-~/Projects/$APP_NAME}"

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

        cd "$PROJECT_ROOT"
        echo "  Flatpak bundle created: $RELEASES_DIR/linux/$FLATPAK_BUNDLE"
    else
        echo "  Skipping Flatpak: binary not found at src-tauri/target/release/$BINARY_NAME"
    fi
else
    echo "  Skipping: flatpak-builder not found or no manifest"
    echo "  Install with: sudo apt install flatpak-builder"
fi

# =============================================================================
# PHASE 3: Windows VM Build
# =============================================================================
echo ""
echo "[Phase 3] Windows VM Build..."

if [[ -n "$WINDOWS_VM_HOST" ]]; then
    echo "  Connecting to Windows VM at $WINDOWS_VM_HOST..."
    # TODO: Implement Windows VM build
    # ssh $VM_USER@$WINDOWS_VM_HOST "cd $VM_PROJECT_PATH && npm install && npm run tauri:build"
    # scp $VM_USER@$WINDOWS_VM_HOST:"$VM_PROJECT_PATH/src-tauri/target/release/bundle/msi/*.msi" "$RELEASES_DIR/windows/"
    # scp $VM_USER@$WINDOWS_VM_HOST:"$VM_PROJECT_PATH/src-tauri/target/release/bundle/nsis/*.exe" "$RELEASES_DIR/windows/"
    echo "  [PLACEHOLDER] Windows VM build not yet configured"
else
    echo "  Skipping: WINDOWS_VM_HOST not set"
    echo "  Set WINDOWS_VM_HOST environment variable to enable Windows builds"
fi

# =============================================================================
# PHASE 4: macOS VM Build
# =============================================================================
echo ""
echo "[Phase 4] macOS VM Build..."

if [[ -n "$MACOS_VM_HOST" ]]; then
    echo "  Connecting to macOS VM at $MACOS_VM_HOST..."
    # TODO: Implement macOS VM build
    # ssh $VM_USER@$MACOS_VM_HOST "cd $VM_PROJECT_PATH && npm install && npm run tauri:build"
    # scp $VM_USER@$MACOS_VM_HOST:"$VM_PROJECT_PATH/src-tauri/target/release/bundle/dmg/*.dmg" "$RELEASES_DIR/mac/"
    # scp -r $VM_USER@$MACOS_VM_HOST:"$VM_PROJECT_PATH/src-tauri/target/release/bundle/macos/*.app" "$RELEASES_DIR/mac/"
    echo "  [PLACEHOLDER] macOS VM build not yet configured"
else
    echo "  Skipping: MACOS_VM_HOST not set"
    echo "  Set MACOS_VM_HOST environment variable to enable macOS builds"
fi

# =============================================================================
# PHASE 5: Arch Linux VM Build (alternate Linux builds/testing)
# =============================================================================
echo ""
echo "[Phase 5] Arch Linux VM Build..."

if [[ -n "$ARCH_VM_HOST" ]]; then
    echo "  Connecting to Arch Linux VM at $ARCH_VM_HOST..."
    # TODO: Implement Arch VM build
    # ssh $VM_USER@$ARCH_VM_HOST "cd $VM_PROJECT_PATH && npm install && npm run tauri:build"
    # scp $VM_USER@$ARCH_VM_HOST:"$VM_PROJECT_PATH/src-tauri/target/release/bundle/appimage/*.AppImage" "$RELEASES_DIR/linux/"
    echo "  [PLACEHOLDER] Arch Linux VM build not yet configured"
else
    echo "  Skipping: ARCH_VM_HOST not set"
    echo "  Set ARCH_VM_HOST environment variable to enable Arch Linux builds"
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
echo "VM Build Status:"
echo "  Windows:    ${WINDOWS_VM_HOST:-NOT CONFIGURED}"
echo "  macOS:      ${MACOS_VM_HOST:-NOT CONFIGURED}"
echo "  Arch Linux: ${ARCH_VM_HOST:-NOT CONFIGURED}"
echo "========================================"
