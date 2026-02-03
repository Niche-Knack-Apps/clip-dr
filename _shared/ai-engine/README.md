# Niche-Knack AI Engine

Reusable Python backend for AI/ML workloads in Niche-Knack desktop apps. Communicates via JSON-RPC 2.0 over stdio.

## Features

- **OCR**: Text extraction from images using EasyOCR
- **Embeddings**: Text embeddings using Sentence Transformers
- **NSFW Detection**: Image content classification
- **Whisper**: Audio transcription using OpenAI Whisper

## Installation

### From Source

```bash
# Clone and install
cd ai-engine
pip install -e ".[all]"

# Or install specific features
pip install -e ".[ocr]"         # OCR only
pip install -e ".[embeddings]"  # Embeddings only
pip install -e ".[nsfw]"        # NSFW detection only
pip install -e ".[whisper]"     # Whisper only
```

### Building Standalone Executable

```bash
# Linux
./build/build-linux.sh

# macOS
./build/build-macos.sh

# Windows
build\build-windows.bat
```

## Usage

### Running the Server

```bash
# As Python module
python -m src

# With options
python -m src --log-level DEBUG --cache-dir /tmp/cache
```

### JSON-RPC Protocol

The engine reads JSON-RPC requests from stdin and writes responses to stdout.

#### Health Check

```json
{"jsonrpc": "2.0", "id": "1", "method": "engine.health"}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "status": "ok",
    "version": "1.0.0",
    "uptime": 123,
    "memory": {"used": 100000000, "total": 16000000000}
  }
}
```

### OCR

#### Extract Text

```json
{
  "jsonrpc": "2.0",
  "id": "2",
  "method": "jobs.start",
  "params": {
    "type": "ocr.extract",
    "payload": {
      "image_path": "/path/to/image.png",
      "languages": ["en"],
      "detail": true
    }
  }
}
```

Result:
```json
{
  "text": "Extracted text from image",
  "regions": [
    {
      "text": "Extracted",
      "confidence": 0.95,
      "bbox": {...}
    }
  ]
}
```

### Embeddings

#### Encode Text

```json
{
  "jsonrpc": "2.0",
  "id": "3",
  "method": "jobs.start",
  "params": {
    "type": "embeddings.encode",
    "payload": {
      "text": "Hello, world!",
      "model": "sentence-transformers/all-MiniLM-L6-v2"
    }
  }
}
```

#### Compute Similarity

```json
{
  "jsonrpc": "2.0",
  "id": "4",
  "method": "jobs.start",
  "params": {
    "type": "embeddings.similarity",
    "payload": {
      "text1": "Hello",
      "text2": "Hi there"
    }
  }
}
```

### NSFW Detection

```json
{
  "jsonrpc": "2.0",
  "id": "5",
  "method": "jobs.start",
  "params": {
    "type": "nsfw.classify",
    "payload": {
      "image_path": "/path/to/image.jpg",
      "threshold": 0.5
    }
  }
}
```

Result:
```json
{
  "is_nsfw": false,
  "confidence": 0.12,
  "scores": {"nsfw": 0.12, "normal": 0.88}
}
```

### Whisper Transcription

```json
{
  "jsonrpc": "2.0",
  "id": "6",
  "method": "jobs.start",
  "params": {
    "type": "whisper.transcribe",
    "payload": {
      "audio_path": "/path/to/audio.mp3",
      "model_size": "base",
      "language": "en",
      "word_timestamps": true
    }
  }
}
```

Result:
```json
{
  "text": "Hello, this is a test.",
  "language": "en",
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 2.5,
      "text": "Hello, this is a test."
    }
  ],
  "words": [
    {"word": "Hello,", "start": 0.0, "end": 0.5},
    {"word": "this", "start": 0.5, "end": 0.8}
  ]
}
```

## Job Management

### Check Status

```json
{"jsonrpc": "2.0", "id": "7", "method": "jobs.status", "params": {"jobId": "abc-123"}}
```

### Get Result

```json
{"jsonrpc": "2.0", "id": "8", "method": "jobs.result", "params": {"jobId": "abc-123"}}
```

### Cancel Job

```json
{"jsonrpc": "2.0", "id": "9", "method": "jobs.cancel", "params": {"jobId": "abc-123"}}
```

### List Jobs

```json
{"jsonrpc": "2.0", "id": "10", "method": "jobs.list"}
```

## Progress Events

During job execution, the engine emits progress events to stdout:

```json
{"type": "progress", "jobId": "abc-123", "timestamp": 1699900000000, "data": {"percent": 50, "message": "Processing..."}}
{"type": "result", "jobId": "abc-123", "timestamp": 1699900001000, "data": {...}}
```

## Model Management

### List Models

```json
{"jsonrpc": "2.0", "id": "11", "method": "models.list"}
```

### Load Model

```json
{"jsonrpc": "2.0", "id": "12", "method": "models.load", "params": {"modelId": "whisper-base"}}
```

### Unload Model

```json
{"jsonrpc": "2.0", "id": "13", "method": "models.unload", "params": {"modelId": "whisper-base"}}
```

## Cache

### Get Cached Value

```json
{"jsonrpc": "2.0", "id": "14", "method": "cache.get", "params": {"key": "my-key"}}
```

### Set Cached Value

```json
{"jsonrpc": "2.0", "id": "15", "method": "cache.set", "params": {"key": "my-key", "value": {...}, "ttl": 3600}}
```

### Clear Cache

```json
{"jsonrpc": "2.0", "id": "16", "method": "cache.clear", "params": {"prefix": "ocr-"}}
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black src tests
ruff check src tests

# Type check
mypy src
```

## Custom Handlers

To add custom job handlers:

```python
from src.job_registry import register_handler

@register_handler("custom.task")
def my_handler(payload, on_progress):
    on_progress(50, "Working...")
    result = do_something(payload)
    on_progress(100, "Done")
    return result
```

## License

MIT
