#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod audio_clean;
mod audio_util;
mod services;

use commands::{audio, waveform, transcribe, export, vad, clean, metadata, recording, import, playback, project};
use std::panic;

fn main() {
    // Stderr logging only — the frontend DebugLogger (Settings > Logging) is the primary log store.
    // Device detection modules stay at debug for diagnostics.
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or(
            "info,clip_dr::commands::pulse_devices=debug"
        )
    )
    .init();

    log::info!("=== Clip Dr. v0.14.0 starting ===");
    log::info!("OS: {} {}", std::env::consts::OS, std::env::consts::ARCH);

    // Set a custom panic hook to handle ALSA thread panics gracefully
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        // Check if this is a known ALSA timing panic
        let panic_msg = format!("{:?}", panic_info);
        if panic_msg.contains("get_htstamp") || panic_msg.contains("get_trigger_htstamp") {
            log::warn!("ALSA timing issue detected (known cpal bug), ignoring...");
            return;
        }
        // For other panics, use the default handler
        default_hook(panic_info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(import::ImportState::new())
        .manage(playback::PlaybackEngine::new())
        .manage(recording::RecordingManager::new())
        .setup(|app| {
            let app_handle = app.handle().clone();
            services::path_service::init(&app_handle)?;
            // Clean up old/orphaned decode cache files
            if let Err(e) = services::path_service::cleanup_decode_cache() {
                log::warn!("Cache GC failed: {}", e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio::get_audio_metadata,
            audio::load_audio_buffer,
            audio::load_audio_complete,
            waveform::extract_waveform,
            transcribe::transcribe_audio,
            transcribe::check_whisper_model,
            transcribe::get_models_directory,
            transcribe::list_available_models,
            transcribe::debug_list_directory,
            transcribe::download_model,
            export::export_audio_region,
            export::export_audio_mp3,
            export::export_audio_flac,
            export::export_audio_ogg,
            export::export_edl,
            vad::detect_speech_segments,
            vad::export_without_silence,
            clean::clean_audio,
            clean::detect_mains_freq,
            clean::get_temp_audio_path,
            metadata::save_transcription_metadata,
            metadata::load_transcription_metadata,
            metadata::delete_transcription_metadata,
            recording::list_audio_devices,
            recording::list_all_audio_devices,
            recording::get_device_capabilities,
            recording::start_device_preview,
            recording::get_device_preview_level,
            recording::stop_device_preview,
            recording::start_recording,
            recording::stop_recording,
            recording::start_multi_recording,
            recording::stop_all_recordings,
            recording::get_session_levels,
            recording::start_session,
            recording::stop_session,
            recording::start_device_previews,
            recording::get_preview_levels,
            recording::stop_all_previews,
            recording::get_recording_level,
            recording::is_recording,
            recording::cancel_recording,
            recording::start_monitoring,
            recording::stop_monitoring,
            recording::is_monitoring,
            recording::check_input_muted,
            recording::unmute_input,
            recording::reset_recording_state,
            recording::test_audio_device,
            recording::start_system_audio_recording,
            recording::stop_system_audio_recording,
            recording::start_system_audio_monitoring,
            recording::stop_system_audio_monitoring,
            recording::probe_system_audio,
            recording::check_system_deps,
            recording::scan_orphaned_recordings,
            recording::recover_recording,
            recording::delete_orphaned_recording,
            transcribe::get_bundled_model_info,
            import::import_audio_start,
            import::import_audio_cancel,
            import::get_peak_tile,
            playback::playback_set_tracks,
            playback::playback_play,
            playback::playback_pause,
            playback::playback_stop,
            playback::playback_seek,
            playback::playback_set_speed,
            playback::playback_set_volume,
            playback::playback_set_output_device,
            playback::playback_get_output_device,
            playback::playback_set_track_volume,
            playback::playback_set_track_envelope,
            playback::playback_set_track_muted,
            playback::playback_set_loop,
            playback::playback_get_position,
            playback::playback_get_meter_levels,
            playback::prepare_audio_cache,
            playback::playback_swap_to_cache,
            export::check_ffmpeg_available,
            project::save_project,
            project::load_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
