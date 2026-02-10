#!/bin/bash
# Generate Flatpak dependency manifests
# Run this script before building the Flatpak to update dependency sources

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
FLATPAK_DIR="$PROJECT_ROOT/packaging/flatpak"

echo "Generating Flatpak dependency sources..."
echo "Project root: $PROJECT_ROOT"

# Check for required tools
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 is required"
    exit 1
fi

# Install generators if not present
pip3 install --user flatpak-cargo-generator 2>/dev/null || true

echo ""
echo "=== Generating Cargo sources ==="
cd "$PROJECT_ROOT/src-tauri"

if [[ -f "Cargo.lock" ]]; then
    python3 -m flatpak_cargo_generator Cargo.lock -o "$FLATPAK_DIR/cargo-sources.json"
    echo "Generated: $FLATPAK_DIR/cargo-sources.json"
else
    echo "Warning: Cargo.lock not found. Run 'cargo build' first."
fi

echo ""
echo "=== Generating NPM sources ==="
cd "$PROJECT_ROOT"

if [[ -f "package-lock.json" ]]; then
    # flatpak-node-generator approach
    if command -v flatpak-node-generator &> /dev/null; then
        flatpak-node-generator npm package-lock.json -o "$FLATPAK_DIR/npm-sources.json"
        echo "Generated: $FLATPAK_DIR/npm-sources.json"
    else
        echo "Warning: flatpak-node-generator not found."
        echo "Install with: pip3 install flatpak-node-generator"
        echo "Or use: https://github.com/nicereddy/nicereddy-flatpak-node-generator"
    fi
else
    echo "Warning: package-lock.json not found. Run 'npm install' first."
fi

echo ""
echo "=== Done ==="
echo "Source manifests generated in: $FLATPAK_DIR"
echo ""
echo "Next steps:"
echo "  1. cd $FLATPAK_DIR"
echo "  2. flatpak-builder --force-clean build-dir com.nicheknack.clip-dr.yml"
