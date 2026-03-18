#!/usr/bin/env bash
# prepare-models.sh — Copy ML models from /mnt/data/models/ into the Tauri resource bundle.
#
# Called automatically by `beforeBuildCommand` in tauri.conf.json.
# If a source model does not exist but is already in resources, the build continues.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$PROJECT_ROOT/src-tauri/resources/models"

# --cleanup mode: remove copied models after build
if [[ "${1:-}" == "--cleanup" ]]; then
    rm -f "$DEST_DIR/ggml-tiny.bin"
    rm -rf "$DEST_DIR/moonshine"
    echo "[prepare-models] Cleaned up copied models."
    exit 0
fi

copy_model() {
    local src="$1" dest="$2" label="$3"
    if [[ -e "$src" ]]; then
        mkdir -p "$(dirname "$dest")"
        cp -r --no-preserve=ownership "$src" "$dest"
        echo "[prepare-models] $label ready."
    elif [[ -e "$dest" ]]; then
        echo "[prepare-models] $label already in resources. Skipping."
    else
        echo "[prepare-models] WARNING: $label not found at $src"
    fi
}

mkdir -p "$DEST_DIR"

# Whisper GGML model
copy_model "/mnt/data/models/audio/whisper/ggml-tiny.bin" \
    "$DEST_DIR/ggml-tiny.bin" "Whisper ggml-tiny"

# Moonshine tiny model
copy_model "/mnt/data/models/audio/moonshine/tiny" \
    "$DEST_DIR/moonshine/tiny" "Moonshine tiny"

echo "[prepare-models] Done."
