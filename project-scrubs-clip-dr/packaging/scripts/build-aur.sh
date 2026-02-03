#!/bin/bash
# Build AUR package locally for testing
# Run this on an Arch Linux system

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH_DIR="$(dirname "$SCRIPT_DIR")/arch"

echo "Building AUR package..."
echo "PKGBUILD location: $ARCH_DIR"

cd "$ARCH_DIR"

# Clean previous builds
rm -f *.pkg.tar.zst
rm -rf src pkg

# Build the package
makepkg -sf

echo ""
echo "=== Build complete ==="
echo "Package: $(ls *.pkg.tar.zst 2>/dev/null || echo 'not found')"
echo ""
echo "To install: sudo pacman -U $(ls *.pkg.tar.zst)"
