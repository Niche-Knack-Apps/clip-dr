# VM Setup for Package Building

This document describes how to set up QEMU/KVM virtual machines for building distribution-specific packages for Project Scrubs: The Clip Dr.

## Overview

| Package Format | VM Distro      | vCPUs | RAM  | Disk | Purpose                    |
|----------------|----------------|-------|------|------|----------------------------|
| AUR/PKGBUILD   | Arch Linux     | 4+    | 8GB  | 40GB | Arch User Repository       |
| RPM            | Fedora 40+     | 4+    | 8GB  | 40GB | Fedora/RHEL/openSUSE       |
| Flatpak        | Fedora 40+     | 4+    | 8GB  | 50GB | Universal Linux (Flathub)  |

> **Note:** Flatpak and RPM can share the same Fedora VM.

---

## Arch Linux VM (AUR Packages)

### Base Installation

Download the Arch Linux ISO from https://archlinux.org/download/

### Post-Install Setup

```bash
# Update system
pacman -Syu

# Base build tools
pacman -S --needed base-devel git

# Rust toolchain
pacman -S rustup
rustup default stable

# Tauri/WebKitGTK dependencies
pacman -S webkit2gtk-4.1 libappindicator-gtk3 librsvg pango cairo gtk3

# Audio dependencies (for whisper-rs and audio processing)
pacman -S clang cmake pkg-config openssl

# Node.js for frontend build
pacman -S nodejs npm

# AUR helper (optional, for testing AUR dependencies)
git clone https://aur.archlinux.org/yay.git
cd yay
makepkg -si
cd ..
rm -rf yay
```

### Building the AUR Package

```bash
# Clone the PKGBUILD (or copy from packaging/arch/)
cd /path/to/packaging/arch

# Build the package
makepkg -s

# Install locally for testing
makepkg -si

# Or install with pacman
sudo pacman -U clip-doctor-scrubs-0.1.1-1-x86_64.pkg.tar.zst
```

### Publishing to AUR

```bash
# Clone your AUR repo
git clone ssh://aur@aur.archlinux.org/clip-doctor-scrubs.git

# Copy PKGBUILD and .SRCINFO
cp PKGBUILD clip-doctor-scrubs/
cd clip-doctor-scrubs

# Generate .SRCINFO
makepkg --printsrcinfo > .SRCINFO

# Commit and push
git add PKGBUILD .SRCINFO
git commit -m "Update to version X.Y.Z"
git push
```

---

## Fedora VM (RPM and Flatpak)

### Base Installation

Download Fedora Workstation or Server from https://fedoraproject.org/

### Post-Install Setup for RPM Building

```bash
# Update system
sudo dnf upgrade --refresh

# Development tools
sudo dnf groupinstall "Development Tools" "C Development Tools and Libraries"

# RPM build tools
sudo dnf install rpm-build rpmdevtools rpmlint

# Rust toolchain
sudo dnf install rust cargo

# Tauri/WebKitGTK dependencies
sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel \
    gtk3-devel pango-devel cairo-devel

# Audio/Whisper dependencies
sudo dnf install clang clang-devel cmake openssl-devel

# Node.js for frontend
sudo dnf install nodejs npm

# Set up RPM build tree
rpmdev-setuptree
```

### Building the RPM Package

```bash
# Copy spec file to rpmbuild
cp packaging/rpm/clip-doctor-scrubs.spec ~/rpmbuild/SPECS/

# Download/copy source tarball to SOURCES
# (or build from local source)

# Build the RPM
rpmbuild -ba ~/rpmbuild/SPECS/clip-doctor-scrubs.spec

# Install for testing
sudo dnf install ~/rpmbuild/RPMS/x86_64/clip-doctor-scrubs-0.1.1-1.fc40.x86_64.rpm
```

---

## Flatpak Setup (on Fedora VM)

### Install Flatpak Build Tools

```bash
# Flatpak is pre-installed on Fedora, but ensure builder is present
sudo dnf install flatpak flatpak-builder

# Add Flathub repository
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo

# Install GNOME SDK and Platform (required for WebKitGTK apps)
# Use the version matching your manifest (currently 46)
flatpak install flathub org.gnome.Platform//46 org.gnome.Sdk//46

# Install Rust SDK extension
flatpak install flathub org.freedesktop.Sdk.Extension.rust-stable//23.08
```

### Building the Flatpak

```bash
cd packaging/flatpak

# Build the flatpak (first build downloads dependencies, takes a while)
flatpak-builder --force-clean build-dir com.niche-knack.clip-doctor-scrubs.yml

# Install locally for testing
flatpak-builder --user --install --force-clean build-dir com.niche-knack.clip-doctor-scrubs.yml

# Run the installed flatpak
flatpak run com.niche-knack.clip-doctor-scrubs

# Export to a repository for distribution
flatpak-builder --repo=repo --force-clean build-dir com.niche-knack.clip-doctor-scrubs.yml

# Create a single-file bundle (.flatpak)
flatpak build-bundle repo clip-doctor-scrubs.flatpak com.niche-knack.clip-doctor-scrubs
```

### Publishing to Flathub

1. Fork https://github.com/flathub/flathub
2. Create a new repository named `com.niche-knack.clip-doctor-scrubs`
3. Add the manifest and submit a PR
4. See: https://github.com/flathub/flathub/wiki/App-Submission

---

## QEMU/KVM Quick Reference

### Creating a VM

```bash
# Create a disk image
qemu-img create -f qcow2 arch-build.qcow2 40G

# Install from ISO
virt-install \
  --name arch-build \
  --ram 8192 \
  --vcpus 4 \
  --disk path=arch-build.qcow2,format=qcow2 \
  --cdrom archlinux-x86_64.iso \
  --os-variant archlinux \
  --network network=default \
  --graphics spice
```

### VM Management

```bash
# List VMs
virsh list --all

# Start VM
virsh start arch-build

# Connect to console
virt-viewer arch-build

# SSH into VM (if SSH server installed)
ssh user@vm-ip-address

# Snapshot before major changes
virsh snapshot-create-as arch-build "pre-build-test"

# Revert to snapshot
virsh snapshot-revert arch-build "pre-build-test"
```

### Shared Folders (for transferring builds)

```bash
# Using 9p virtio filesystem
# Add to VM XML or use virt-manager GUI

# Mount in guest:
sudo mount -t 9p -o trans=virtio shared_folder /mnt/shared
```

---

## Intel GPU Workaround

All packaging formats include a wrapper script that sets:

```bash
export WEBKIT_DISABLE_DMABUF_RENDERER=1
```

This fixes the EGL initialization failure on Intel Alder Lake (12th gen) and newer iGPUs. The workaround is applied automatically via:

- **AUR**: Wrapper script installed to `/usr/bin/`
- **RPM**: Wrapper script in `/usr/bin/`, desktop file uses wrapper
- **Flatpak**: Environment variable set in manifest finish-args

---

## Troubleshooting

### Rust/Cargo Issues

```bash
# Clear cargo cache if builds fail
rm -rf ~/.cargo/registry
rm -rf ~/.cargo/git

# Reinstall toolchain
rustup self uninstall
# Then reinstall rustup
```

### WebKitGTK Build Failures

```bash
# Arch: Ensure webkit2gtk-4.1 specifically
pacman -S webkit2gtk-4.1

# Fedora: The -devel package is required
dnf install webkit2gtk4.1-devel
```

### Flatpak SDK Missing

```bash
# List installed SDKs
flatpak list --runtime

# Install specific version if needed
flatpak install flathub org.gnome.Sdk//46
```

### Out of Disk Space

Flatpak builds cache aggressively. Clean with:

```bash
# Remove unused runtimes
flatpak uninstall --unused

# Clear builder cache
rm -rf .flatpak-builder/
```
