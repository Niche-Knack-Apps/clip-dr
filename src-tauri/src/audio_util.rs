use hound::WavWriter;
use std::fs::File;
use std::io::{BufWriter, Write, Seek, SeekFrom};
use std::path::PathBuf;

/// Maximum PCM data bytes per WAV segment (~3.63 GB, safely below u32::MAX = 4,294,967,295)
pub(crate) const WAV_SEGMENT_MAX_DATA_BYTES: usize = 3_900_000_000;

/// RF64/WAV hybrid writer.
///
/// Starts as a standard RIFF/WAV with a JUNK chunk reserving space for ds64.
/// When data exceeds ~4GB, the JUNK chunk is upgraded in-place to ds64 and the
/// RIFF magic becomes RF64. Periodic header patches keep the file recoverable
/// if the process is interrupted.
///
/// Header layout (80 bytes):
///   0  "RIFF" (or "RF64" after upgrade)
///   4  u32 riff_size (or 0xFFFFFFFF after upgrade)
///   8  "WAVE"
///  12  "JUNK" (or "ds64" after upgrade)
///  16  u32 28  (JUNK payload size = space for ds64 fields)
///  20  [28 bytes of 0x00]
///  48  "fmt "
///  52  u32 16
///  56  u16 3 (IEEE_FLOAT), u16 channels
///  60  u32 sample_rate, u32 byte_rate
///  68  u16 block_align, u16 32 (bits_per_sample)
///  72  "data"
///  76  u32 data_size placeholder
///  80  ... PCM data ...
pub(crate) struct Rf64Writer {
    file: BufWriter<File>,
    path: PathBuf,
    channels: u16,
    #[allow(dead_code)]
    sample_rate: u32,
    data_bytes_written: u64,
    sample_count: u64,
    is_rf64: bool,
    last_header_patch: std::time::Instant,
}

impl Rf64Writer {
    pub(crate) fn new(path: PathBuf, sample_rate: u32, channels: u16) -> std::io::Result<Self> {
        let file = File::create(&path)?;
        let mut writer = BufWriter::with_capacity(65536, file);

        let byte_rate = sample_rate * channels as u32 * 4; // f32 = 4 bytes
        let block_align = channels * 4;

        // Write 80-byte header with JUNK reservation
        writer.write_all(b"RIFF")?;
        writer.write_all(&0u32.to_le_bytes())?; // placeholder riff_size
        writer.write_all(b"WAVE")?;

        // JUNK chunk (will become ds64 at upgrade)
        writer.write_all(b"JUNK")?;
        writer.write_all(&28u32.to_le_bytes())?; // payload size = 28
        writer.write_all(&[0u8; 28])?; // zero-fill ds64 reservation

        // fmt chunk
        writer.write_all(b"fmt ")?;
        writer.write_all(&16u32.to_le_bytes())?;
        writer.write_all(&3u16.to_le_bytes())?; // IEEE_FLOAT
        writer.write_all(&channels.to_le_bytes())?;
        writer.write_all(&sample_rate.to_le_bytes())?;
        writer.write_all(&byte_rate.to_le_bytes())?;
        writer.write_all(&block_align.to_le_bytes())?;
        writer.write_all(&32u16.to_le_bytes())?; // bits_per_sample

        // data chunk header
        writer.write_all(b"data")?;
        writer.write_all(&0u32.to_le_bytes())?; // placeholder data_size

        Ok(Self {
            file: writer,
            path,
            channels,
            sample_rate,
            data_bytes_written: 0,
            sample_count: 0,
            is_rf64: false,
            last_header_patch: std::time::Instant::now(),
        })
    }

    pub(crate) fn write_sample(&mut self, sample: f32) -> std::io::Result<()> {
        self.file.write_all(&sample.to_le_bytes())?;
        self.data_bytes_written += 4;
        self.sample_count += 1;

        // Check if upgrade to RF64 needed (at ~4GB - 256 bytes of headroom)
        if !self.is_rf64 && self.data_bytes_written >= 0xFFFF_F000 {
            self.upgrade_to_rf64()?;
        }

        // Periodic header patch (every ~2 seconds)
        if self.last_header_patch.elapsed().as_secs() >= 2 {
            self.patch_header()?;
        }

        Ok(())
    }

    fn upgrade_to_rf64(&mut self) -> std::io::Result<()> {
        let inner = self.file.get_mut();
        let current_pos = inner.seek(SeekFrom::Current(0))?;

        let riff_size = self.data_bytes_written + 72; // 80 - 8 (RIFF header)
        let data_size = self.data_bytes_written;
        let interleaved_sample_count = self.sample_count / self.channels as u64;

        // "RF64" magic
        inner.seek(SeekFrom::Start(0))?;
        inner.write_all(b"RF64")?;
        // RIFF size = 0xFFFFFFFF for RF64
        inner.write_all(&u32::MAX.to_le_bytes())?;

        // Convert JUNK → ds64
        inner.seek(SeekFrom::Start(12))?;
        inner.write_all(b"ds64")?;
        inner.write_all(&28u32.to_le_bytes())?; // ds64 payload size
        inner.write_all(&riff_size.to_le_bytes())?;       // u64 riff_size
        inner.write_all(&data_size.to_le_bytes())?;        // u64 data_size
        inner.write_all(&interleaved_sample_count.to_le_bytes())?; // u64 sample_count
        inner.write_all(&0u32.to_le_bytes())?;             // u32 table_length = 0

        // data chunk size = 0xFFFFFFFF for RF64
        inner.seek(SeekFrom::Start(76))?;
        inner.write_all(&u32::MAX.to_le_bytes())?;

        // Seek back to where we were
        inner.seek(SeekFrom::Start(current_pos))?;

        self.is_rf64 = true;
        log::info!("RF64 upgrade: file is now RF64 at {:.2}GB", self.data_bytes_written as f64 / 1e9);
        Ok(())
    }

    fn patch_header(&mut self) -> std::io::Result<()> {
        let inner = self.file.get_mut();
        let current_pos = inner.seek(SeekFrom::Current(0))?;

        if self.is_rf64 {
            let riff_size = self.data_bytes_written + 72;
            let data_size = self.data_bytes_written;
            let interleaved_sample_count = self.sample_count / self.channels as u64;

            // Patch ds64 fields
            inner.seek(SeekFrom::Start(20))?;
            inner.write_all(&riff_size.to_le_bytes())?;
            inner.write_all(&data_size.to_le_bytes())?;
            inner.write_all(&interleaved_sample_count.to_le_bytes())?;
        } else {
            let riff_size = (self.data_bytes_written + 72).min(u32::MAX as u64) as u32;
            let data_size = self.data_bytes_written.min(u32::MAX as u64) as u32;

            inner.seek(SeekFrom::Start(4))?;
            inner.write_all(&riff_size.to_le_bytes())?;
            inner.seek(SeekFrom::Start(76))?;
            inner.write_all(&data_size.to_le_bytes())?;
        }

        inner.seek(SeekFrom::Start(current_pos))?;
        self.last_header_patch = std::time::Instant::now();
        Ok(())
    }

    pub(crate) fn finalize(mut self) -> std::io::Result<PathBuf> {
        self.patch_header()?;
        self.file.flush()?;
        let inner = self.file.into_inner().map_err(|e| e.into_error())?;
        inner.sync_all()?;
        Ok(self.path)
    }
}

/// Abstraction over hound::WavWriter and Rf64Writer for use in recording threads
pub(crate) enum AudioWriter {
    Hound(WavWriter<BufWriter<File>>),
    Rf64(Rf64Writer),
}

impl AudioWriter {
    pub(crate) fn write_sample(&mut self, s: f32) -> Result<(), String> {
        match self {
            AudioWriter::Hound(w) => w.write_sample(s)
                .map_err(|e| format!("WAV write error: {}", e)),
            AudioWriter::Rf64(w) => w.write_sample(s)
                .map_err(|e| format!("RF64 write error: {}", e)),
        }
    }

    pub(crate) fn finalize(self) -> Result<(), String> {
        match self {
            AudioWriter::Hound(w) => w.finalize()
                .map_err(|e| format!("WAV finalize error: {}", e)),
            AudioWriter::Rf64(w) => {
                w.finalize().map_err(|e| format!("RF64 finalize error: {}", e))?;
                Ok(())
            }
        }
    }
}
