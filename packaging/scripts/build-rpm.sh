#!/bin/bash
# Build RPM package
# Run this on a Fedora/RHEL system with rpmbuild set up

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RPM_DIR="$(dirname "$SCRIPT_DIR")/rpm"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Get version from Cargo.toml
VERSION=$(grep '^version' "$PROJECT_ROOT/src-tauri/Cargo.toml" | head -1 | sed 's/.*"\(.*\)"/\1/')

echo "Building RPM package..."
echo "Version: $VERSION"
echo "Spec file: $RPM_DIR/clip-dr.spec"

# Ensure rpmbuild directory structure exists
rpmdev-setuptree 2>/dev/null || mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Copy spec file
cp "$RPM_DIR/clip-dr.spec" ~/rpmbuild/SPECS/

# Create source tarball
echo "Creating source tarball..."
cd "$PROJECT_ROOT/.."
tar czf ~/rpmbuild/SOURCES/clip-dr-$VERSION.tar.gz \
    --transform "s,^clip-dr,clip-dr-$VERSION," \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='target' \
    --exclude='dist' \
    clip-dr

echo "Building RPM..."
rpmbuild -ba ~/rpmbuild/SPECS/clip-dr.spec

echo ""
echo "=== Build complete ==="
echo "RPM: $(ls ~/rpmbuild/RPMS/x86_64/clip-dr-*.rpm 2>/dev/null | head -1 || echo 'not found')"
echo "SRPM: $(ls ~/rpmbuild/SRPMS/clip-dr-*.rpm 2>/dev/null | head -1 || echo 'not found')"
echo ""
echo "To install: sudo dnf install ~/rpmbuild/RPMS/x86_64/clip-dr-$VERSION-*.rpm"
