#!/bin/bash
# Development script for Tauri app
# Usage: ./scripts/dev.sh

set -e

cd "$(dirname "$0")/.."

# Check for node_modules
if [ ! -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install
fi

# Check for Rust dependencies
if ! command -v cargo &> /dev/null; then
    echo "Error: Rust/Cargo not found. Please install rustup."
    exit 1
fi

# Start Tauri development server
echo "Starting Tauri development server..."
npm run tauri:dev
