Name:           clip-dr
Version:        0.1.1
Release:        1%{?dist}
Summary:        Audio cleaning and clip-making application with CPU-only ASR

License:        MIT
URL:            https://github.com/niche-knack/clip-dr
Source0:        %{name}-%{version}.tar.gz

BuildRequires:  rust >= 1.70
BuildRequires:  cargo
BuildRequires:  nodejs >= 18
BuildRequires:  npm
BuildRequires:  webkit2gtk4.1-devel
BuildRequires:  gtk3-devel
BuildRequires:  cairo-devel
BuildRequires:  pango-devel
BuildRequires:  gdk-pixbuf2-devel
BuildRequires:  libappindicator-gtk3-devel
BuildRequires:  librsvg2-devel
BuildRequires:  clang-devel
BuildRequires:  cmake
BuildRequires:  openssl-devel
BuildRequires:  pkg-config
BuildRequires:  desktop-file-utils

Requires:       webkit2gtk4.1
Requires:       gtk3
Requires:       cairo
Requires:       pango
Requires:       gdk-pixbuf2
Requires:       libappindicator-gtk3
Requires:       librsvg2
Requires:       gstreamer1
Requires:       gstreamer1-plugins-base
Requires:       gstreamer1-plugins-good

Recommends:     gstreamer1-plugins-ugly
Recommends:     gstreamer1-plugins-bad-free
Recommends:     gstreamer1-libav

%description
Clip Dr. is a desktop application for cleaning up audio
recordings and creating clips. It features CPU-only speech recognition powered
by OpenAI's Whisper model, making it accessible on any hardware without
requiring a GPU.

Features:
- Multi-track audio editing with waveform visualization
- Voice activity detection (VAD) for automatic silence removal
- Speech-to-text transcription with word-level timestamps
- Audio cleaning with noise reduction and spectral processing
- Clip extraction and export to multiple formats


%prep
%autosetup -n clip-dr-%{version}


%build
# Build frontend
npm ci
npm run build

# Build Rust backend
cd src-tauri
cargo build --release
cd ..


%install
# Create directories
mkdir -p %{buildroot}%{_libdir}/%{name}
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/32x32/apps
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/128x128/apps
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/512x512/apps

# Install binary
install -m 755 src-tauri/target/release/clip-dr %{buildroot}%{_libdir}/%{name}/

# Install wrapper script with Intel GPU workaround
cat > %{buildroot}%{_bindir}/clip-dr << 'EOF'
#!/bin/bash
# Wrapper script for Clip Dr.
# Includes workaround for Intel Alder Lake+ GPU EGL issues

# Fix for WebKitGTK EGL initialization on Intel 12th gen+ iGPUs
export WEBKIT_DISABLE_DMABUF_RENDERER=1

# Optional: Uncomment if you still have issues
# export WEBKIT_DISABLE_COMPOSITING_MODE=1

exec %{_libdir}/%{name}/clip-dr "$@"
EOF
chmod 755 %{buildroot}%{_bindir}/clip-dr

# Install desktop file
cat > %{buildroot}%{_datadir}/applications/%{name}.desktop << 'EOF'
[Desktop Entry]
Name=Clip Dr.
GenericName=Audio Editor
Comment=Audio cleaning and clip-making application with CPU-only speech recognition
Exec=clip-dr %F
Icon=clip-dr
Terminal=false
Type=Application
Categories=AudioVideo;Audio;AudioVideoEditing;
MimeType=audio/mpeg;audio/x-wav;audio/flac;audio/ogg;audio/aac;
Keywords=audio;clip;clean;transcribe;whisper;speech;recognition;
StartupNotify=true
EOF

# Install icons
install -m 644 src-tauri/icons/32x32.png %{buildroot}%{_datadir}/icons/hicolor/32x32/apps/%{name}.png
install -m 644 src-tauri/icons/128x128.png %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/%{name}.png
install -m 644 src-tauri/icons/icon.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/%{name}.png


%check
desktop-file-validate %{buildroot}%{_datadir}/applications/%{name}.desktop


%files
%license LICENSE
%doc README.md
%{_bindir}/clip-dr
%{_libdir}/%{name}/
%{_datadir}/applications/%{name}.desktop
%{_datadir}/icons/hicolor/*/apps/%{name}.png


%changelog
* Wed Jan 15 2026 Niche-Knack Apps <support@niche-knack.com> - 0.1.1-1
- Performance improvements
- Added exclusive solo mode for tracks
- Dynamic waveform updates during playback
- UI improvements

* Fri Jan 10 2026 Niche-Knack Apps <support@niche-knack.com> - 0.1.0-1
- Initial release
