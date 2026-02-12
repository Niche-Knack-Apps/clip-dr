#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod audio_clean;
mod services;

use commands::{audio, waveform, transcribe, export, vad, clean, metadata, recording};
use std::panic;

fn main() {
    env_logger::init();

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
        .setup(|app| {
            let app_handle = app.handle().clone();
            services::path_service::init(&app_handle)?;
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
            vad::detect_speech_segments,
            vad::export_without_silence,
            clean::clean_audio,
            clean::detect_mains_freq,
            clean::get_temp_audio_path,
            metadata::save_transcription_metadata,
            metadata::load_transcription_metadata,
            metadata::delete_transcription_metadata,
            recording::list_audio_devices,
            recording::start_recording,
            recording::stop_recording,
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
            recording::get_recording_chunk,
            recording::start_system_audio_recording,
            recording::stop_system_audio_recording,
            recording::start_system_audio_monitoring,
            recording::stop_system_audio_monitoring,
            recording::probe_system_audio,
            transcribe::get_bundled_model_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
