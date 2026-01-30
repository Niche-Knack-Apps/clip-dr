"""
Whisper Transcription Handler

Transcribes audio using OpenAI Whisper.
"""

import logging
from typing import Any, Callable


logger = logging.getLogger(__name__)

# Lazy-loaded model
_model = None
_model_size = None


def _get_model(model_size: str = "base"):
    """Get or create the Whisper model."""
    global _model, _model_size

    if _model is None or _model_size != model_size:
        import whisper

        logger.info("Loading Whisper model: %s", model_size)
        _model = whisper.load_model(model_size)
        _model_size = model_size

    return _model


def transcribe_audio(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Transcribe audio to text.

    Payload:
        audio_path: Path to the audio file
        model_size: Whisper model size (tiny, base, small, medium, large)
        language: Optional language code (auto-detected if not provided)
        task: "transcribe" or "translate" (default: transcribe)
        word_timestamps: Whether to include word-level timestamps (default: False)

    Returns:
        text: Transcribed text
        language: Detected/specified language
        segments: List of timestamped segments
        words: List of word timestamps (if word_timestamps=True)
    """
    audio_path = payload.get("audio_path")
    if not audio_path:
        raise ValueError("audio_path is required")

    model_size = payload.get("model_size", "base")
    language = payload.get("language")
    task = payload.get("task", "transcribe")
    word_timestamps = payload.get("word_timestamps", False)

    on_progress(10, f"Loading Whisper {model_size} model...")

    model = _get_model(model_size)

    on_progress(30, "Transcribing audio...")

    # Run transcription
    options = {
        "task": task,
        "word_timestamps": word_timestamps,
    }
    if language:
        options["language"] = language

    result = model.transcribe(audio_path, **options)

    on_progress(90, "Processing results...")

    # Format response
    segments = []
    for segment in result.get("segments", []):
        seg = {
            "id": segment["id"],
            "start": segment["start"],
            "end": segment["end"],
            "text": segment["text"].strip(),
        }
        if word_timestamps and "words" in segment:
            seg["words"] = [
                {
                    "word": w["word"],
                    "start": w["start"],
                    "end": w["end"],
                }
                for w in segment["words"]
            ]
        segments.append(seg)

    response = {
        "text": result["text"].strip(),
        "language": result.get("language", language),
        "segments": segments,
    }

    # Flatten word timestamps if requested
    if word_timestamps:
        words = []
        for segment in segments:
            if "words" in segment:
                words.extend(segment["words"])
        response["words"] = words

    on_progress(100, "Complete")

    return response


def transcribe_batch(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Transcribe multiple audio files.

    Payload:
        audio_paths: List of paths to audio files
        model_size: Whisper model size (tiny, base, small, medium, large)
        language: Optional language code (auto-detected if not provided)
        task: "transcribe" or "translate" (default: transcribe)

    Returns:
        results: List of transcription results
        summary: Processing summary
    """
    audio_paths = payload.get("audio_paths", [])
    if not audio_paths:
        raise ValueError("audio_paths is required")

    model_size = payload.get("model_size", "base")
    language = payload.get("language")
    task = payload.get("task", "transcribe")

    on_progress(5, f"Loading Whisper {model_size} model...")

    model = _get_model(model_size)

    results = []
    success_count = 0
    error_count = 0
    total_duration = 0.0
    total = len(audio_paths)

    for i, audio_path in enumerate(audio_paths):
        progress = 10 + int((i / total) * 85)
        on_progress(progress, f"Transcribing {i + 1}/{total}...")

        try:
            # Run transcription
            options = {"task": task}
            if language:
                options["language"] = language

            result = model.transcribe(audio_path, **options)

            # Calculate duration from last segment
            duration = 0.0
            if result.get("segments"):
                duration = result["segments"][-1]["end"]
                total_duration += duration

            results.append({
                "path": audio_path,
                "success": True,
                "text": result["text"].strip(),
                "language": result.get("language", language),
                "duration": duration,
            })
            success_count += 1

        except Exception as e:
            logger.exception("Failed to transcribe %s: %s", audio_path, e)
            error_count += 1
            results.append({
                "path": audio_path,
                "success": False,
                "error": str(e),
            })

    on_progress(100, "Complete")

    return {
        "results": results,
        "summary": {
            "total": total,
            "success": success_count,
            "errors": error_count,
            "total_duration": total_duration,
        },
    }
