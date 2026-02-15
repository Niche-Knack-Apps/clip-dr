#!/usr/bin/env python3
"""Recover audio from oversized WAV files with truncated u32 headers.

Reads past the WAV header's size claims using actual file size, then writes
valid WAV file(s) capped at 3.9GB each.

Usage:
    python3 recover-wav.py <input.wav> [output_dir]
"""
import struct, sys, os

WAV_HEADER_SIZE = 44
MAX_DATA_BYTES = 3_900_000_000  # 3.9GB per output file


def find_data_offset(f):
    """Walk RIFF chunks to find data chunk start."""
    header = f.read(12)
    magic = header[:4]
    if magic not in (b'RIFF', b'RF64'):
        raise ValueError(f"Not a WAV/RF64 file: {magic}")
    pos = 12
    while True:
        f.seek(pos)
        chunk = f.read(8)
        if len(chunk) < 8:
            raise ValueError("No data chunk found")
        chunk_id = chunk[:4]
        chunk_size = struct.unpack('<I', chunk[4:8])[0]
        if chunk_id == b'data':
            return pos + 8
        pos += 8 + chunk_size + (chunk_size % 2)


def parse_fmt(f):
    """Find and parse the fmt chunk, returning (audio_fmt, channels, sample_rate, bits)."""
    f.seek(12)
    while True:
        chunk = f.read(8)
        if len(chunk) < 8:
            raise ValueError("No fmt chunk found")
        cid = chunk[:4]
        csz = struct.unpack('<I', chunk[4:8])[0]
        if cid == b'fmt ':
            fmt_data = f.read(csz)
            audio_fmt, channels, sample_rate = struct.unpack('<HHI', fmt_data[:8])
            bits = struct.unpack('<H', fmt_data[14:16])[0]
            return audio_fmt, channels, sample_rate, bits
        f.seek(csz + (csz % 2), 1)


def write_wav_header(f, channels, sample_rate, bits, data_size):
    """Write a standard WAV header at current file position."""
    byte_rate = sample_rate * channels * (bits // 8)
    block_align = channels * (bits // 8)
    f.write(b'RIFF')
    f.write(struct.pack('<I', min(data_size + 36, 0xFFFFFFFF)))
    f.write(b'WAVE')
    f.write(b'fmt ')
    f.write(struct.pack('<I', 16))
    f.write(struct.pack('<HHI', 3, channels, sample_rate))  # 3 = IEEE float
    f.write(struct.pack('<IHH', byte_rate, block_align, bits))
    f.write(b'data')
    f.write(struct.pack('<I', min(data_size, 0xFFFFFFFF)))


def recover(src_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)

    with open(src_path, 'rb') as f:
        # Parse format info
        audio_fmt, channels, sample_rate, bits = parse_fmt(f)
        data_offset = find_data_offset(f)

        f.seek(0, 2)
        file_size = f.tell()
        total_data = file_size - data_offset

        bytes_per_sample = channels * (bits // 8)
        duration = total_data / bytes_per_sample / sample_rate

        print(f"Source: {file_size / 1e9:.2f}GB, data offset: {data_offset}")
        print(f"Format: fmt={audio_fmt} {channels}ch {sample_rate}Hz {bits}-bit")
        print(f"PCM data: {total_data / 1e9:.2f}GB, Duration: {duration:.1f}s ({duration / 3600:.1f}h)")

        # Split into output files
        f.seek(data_offset)
        seg = 0
        remaining = total_data
        base_name = os.path.splitext(os.path.basename(src_path))[0]

        while remaining > 0:
            seg += 1
            seg_data = min(remaining, MAX_DATA_BYTES)
            out_path = os.path.join(out_dir, f"{base_name}_recovered_{seg:03d}.wav")

            with open(out_path, 'wb') as out:
                write_wav_header(out, channels, sample_rate, bits, seg_data)

                # Stream copy in 64KB chunks
                copied = 0
                while copied < seg_data:
                    chunk_size = min(65536, seg_data - copied)
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    copied += len(chunk)

                # Patch actual sizes in header
                actual_data = copied
                out.seek(4)
                out.write(struct.pack('<I', min(actual_data + 36, 0xFFFFFFFF)))
                out.seek(40)
                out.write(struct.pack('<I', min(actual_data, 0xFFFFFFFF)))

            remaining -= copied
            seg_dur = copied / bytes_per_sample / sample_rate
            print(f"  Wrote {out_path}: {copied / 1e9:.2f}GB ({seg_dur:.1f}s)")

    print(f"\nDone. Recovered {seg} segment(s) from {duration:.1f}s of audio.")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input.wav> [output_dir]")
        sys.exit(1)
    recover(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else '.')
