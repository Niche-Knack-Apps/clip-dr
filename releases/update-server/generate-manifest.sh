#!/bin/bash
# Generate release manifest from built artifacts
# Usage: ./generate-manifest.sh <version> [base-url]
#
# This script scans the apps/ directory for built artifacts and generates
# an updated releases.json manifest.

set -e

VERSION=${1:-"1.0.0"}
BASE_URL=${2:-"https://releases.niche-knack.com"}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASES_DIR="$(dirname "$SCRIPT_DIR")"
APPS_DIR="$RELEASES_DIR/apps"
OUTPUT_FILE="$SCRIPT_DIR/releases.json"

# Apps to include
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

# Platform mappings
declare -A PLATFORM_SUFFIXES
PLATFORM_SUFFIXES["linux-x86_64"]="-linux.AppImage"
PLATFORM_SUFFIXES["windows-x86_64"]="-windows.msi"
PLATFORM_SUFFIXES["darwin-x86_64"]="-macos.dmg"

echo "Generating release manifest for version $VERSION"
echo "Base URL: $BASE_URL"
echo "Output: $OUTPUT_FILE"

# Start JSON
echo "{" > "$OUTPUT_FILE"

first_app=true
for app in "${APPS[@]}"; do
    app_dir="$APPS_DIR/$app"

    # Add comma separator
    if [ "$first_app" = false ]; then
        echo "," >> "$OUTPUT_FILE"
    fi
    first_app=false

    echo "  Processing $app..."

    # Start app entry
    cat >> "$OUTPUT_FILE" << EOF
  "$app": {
    "version": "$VERSION",
    "notes": "Release $VERSION",
    "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "platforms": {
EOF

    first_platform=true
    for platform in "${!PLATFORM_SUFFIXES[@]}"; do
        suffix="${PLATFORM_SUFFIXES[$platform]}"
        artifact="$app-$VERSION$suffix"
        artifact_path="$app_dir/$artifact"

        # Add comma separator
        if [ "$first_platform" = false ]; then
            echo "," >> "$OUTPUT_FILE"
        fi
        first_platform=false

        # Check if artifact exists
        signature=""
        if [ -f "$artifact_path" ]; then
            echo "    Found: $artifact"
            # Try to read signature file
            if [ -f "$artifact_path.sig" ]; then
                signature=$(cat "$artifact_path.sig" | base64 -w 0)
            fi
        else
            echo "    Missing: $artifact"
        fi

        # Write platform entry
        cat >> "$OUTPUT_FILE" << EOF
      "$platform": {
        "url": "$BASE_URL/apps/$app/$artifact",
        "signature": "$signature"
      }
EOF
    done

    # Close platforms and app
    cat >> "$OUTPUT_FILE" << EOF
    }
  }
EOF
done

# Close JSON
echo "" >> "$OUTPUT_FILE"
echo "}" >> "$OUTPUT_FILE"

echo ""
echo "Manifest generated: $OUTPUT_FILE"

# Validate JSON
if command -v jq &> /dev/null; then
    if jq empty "$OUTPUT_FILE" 2>/dev/null; then
        echo "JSON validation: OK"
    else
        echo "JSON validation: FAILED"
        exit 1
    fi
else
    echo "Note: Install jq for JSON validation"
fi
