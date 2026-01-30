"""
Job Handlers

Pre-built handlers for common AI/ML tasks.
"""

from . import ocr
from . import embeddings
from . import nsfw
from . import whisper

__all__ = ["ocr", "embeddings", "nsfw", "whisper"]
