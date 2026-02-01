#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod audio_clean;

use commands::{audio, waveform, transcribe, export, vad, clean, metadata};

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            vad::detect_speech_segments,
            vad::export_without_silence,
            clean::clean_audio,
            clean::detect_mains_freq,
            clean::get_temp_audio_path,
            metadata::save_transcription_metadata,
            metadata::load_transcription_metadata,
            metadata::delete_transcription_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
