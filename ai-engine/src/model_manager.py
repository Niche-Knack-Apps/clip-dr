"""
Model Manager

Handles loading, unloading, and lifecycle of ML models.
"""

import os
import time
import logging
from typing import Any
from dataclasses import dataclass, field
from pathlib import Path


logger = logging.getLogger(__name__)


@dataclass
class ModelInfo:
    """Information about a model."""

    id: str
    name: str
    type: str
    size: int  # bytes
    loaded: bool = False
    instance: Any = None
    memory_usage: int = 0
    last_used: float = 0.0
    load_options: dict[str, Any] = field(default_factory=dict)


# Default model definitions
DEFAULT_MODELS: dict[str, dict[str, Any]] = {
    # OCR models
    "easyocr-en": {
        "name": "EasyOCR English",
        "type": "ocr",
        "size": 100_000_000,
        "loader": "easyocr",
        "config": {"lang_list": ["en"]},
    },
    "easyocr-multilingual": {
        "name": "EasyOCR Multilingual",
        "type": "ocr",
        "size": 200_000_000,
        "loader": "easyocr",
        "config": {"lang_list": ["en", "es", "fr", "de", "it", "pt"]},
    },
    # Embedding models
    "sentence-transformers/all-MiniLM-L6-v2": {
        "name": "MiniLM-L6 Embeddings",
        "type": "embeddings",
        "size": 90_000_000,
        "loader": "sentence_transformers",
    },
    "sentence-transformers/all-mpnet-base-v2": {
        "name": "MPNet Base Embeddings",
        "type": "embeddings",
        "size": 420_000_000,
        "loader": "sentence_transformers",
    },
    # NSFW models
    "nsfw-classifier": {
        "name": "NSFW Image Classifier",
        "type": "nsfw",
        "size": 150_000_000,
        "loader": "nsfw",
    },
    # Whisper models
    "whisper-tiny": {
        "name": "Whisper Tiny",
        "type": "whisper",
        "size": 75_000_000,
        "loader": "whisper",
        "config": {"model_size": "tiny"},
    },
    "whisper-base": {
        "name": "Whisper Base",
        "type": "whisper",
        "size": 150_000_000,
        "loader": "whisper",
        "config": {"model_size": "base"},
    },
    "whisper-small": {
        "name": "Whisper Small",
        "type": "whisper",
        "size": 500_000_000,
        "loader": "whisper",
        "config": {"model_size": "small"},
    },
    "whisper-medium": {
        "name": "Whisper Medium",
        "type": "whisper",
        "size": 1_500_000_000,
        "loader": "whisper",
        "config": {"model_size": "medium"},
    },
}


class ModelManager:
    """Manages ML model lifecycle."""

    def __init__(self, model_dir: str | None = None) -> None:
        """
        Initialize the model manager.

        Args:
            model_dir: Directory to store downloaded models
        """
        if model_dir:
            self.model_dir = Path(model_dir)
        else:
            # Use platform-appropriate cache directory
            cache_home = os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache"))
            self.model_dir = Path(cache_home) / "niche-knack" / "models"

        self.model_dir.mkdir(parents=True, exist_ok=True)
        logger.info("Model directory: %s", self.model_dir)

        # Initialize model registry
        self.models: dict[str, ModelInfo] = {}
        self._register_default_models()

    def _register_default_models(self) -> None:
        """Register default models."""
        for model_id, config in DEFAULT_MODELS.items():
            self.models[model_id] = ModelInfo(
                id=model_id,
                name=config["name"],
                type=config["type"],
                size=config["size"],
            )

    def register_model(
        self, model_id: str, name: str, model_type: str, size: int
    ) -> None:
        """Register a custom model."""
        self.models[model_id] = ModelInfo(
            id=model_id,
            name=name,
            type=model_type,
            size=size,
        )
        logger.info("Registered model: %s", model_id)

    def list_models(self) -> list[dict[str, Any]]:
        """List all available models."""
        return [
            {
                "id": model.id,
                "name": model.name,
                "type": model.type,
                "loaded": model.loaded,
                "size": model.size,
            }
            for model in self.models.values()
        ]

    def load_model(
        self, model_id: str, options: dict[str, Any] | None = None
    ) -> bool:
        """
        Load a model into memory.

        Returns:
            True if successful, False otherwise
        """
        if model_id not in self.models:
            logger.error("Unknown model: %s", model_id)
            return False

        model = self.models[model_id]
        if model.loaded:
            logger.info("Model already loaded: %s", model_id)
            return True

        try:
            config = DEFAULT_MODELS.get(model_id, {})
            loader = config.get("loader", "unknown")
            model_config = config.get("config", {})

            if options:
                model_config.update(options)

            model.instance = self._load_model_instance(loader, model_id, model_config)
            model.loaded = True
            model.last_used = time.time()
            model.load_options = model_config

            logger.info("Loaded model: %s", model_id)
            return True

        except Exception as e:
            logger.exception("Failed to load model %s: %s", model_id, e)
            return False

    def _load_model_instance(
        self, loader: str, model_id: str, config: dict[str, Any]
    ) -> Any:
        """Load a model instance using the appropriate loader."""
        if loader == "easyocr":
            import easyocr

            return easyocr.Reader(
                config.get("lang_list", ["en"]),
                model_storage_directory=str(self.model_dir / "easyocr"),
                download_enabled=True,
            )

        elif loader == "sentence_transformers":
            from sentence_transformers import SentenceTransformer

            return SentenceTransformer(
                model_id,
                cache_folder=str(self.model_dir / "sentence_transformers"),
            )

        elif loader == "nsfw":
            from transformers import pipeline

            return pipeline(
                "image-classification",
                model="Falconsai/nsfw_image_detection",
                device=-1,  # CPU
            )

        elif loader == "whisper":
            import whisper

            model_size = config.get("model_size", "base")
            return whisper.load_model(
                model_size,
                download_root=str(self.model_dir / "whisper"),
            )

        else:
            raise ValueError(f"Unknown model loader: {loader}")

    def unload_model(self, model_id: str) -> bool:
        """
        Unload a model from memory.

        Returns:
            True if successful, False otherwise
        """
        if model_id not in self.models:
            logger.error("Unknown model: %s", model_id)
            return False

        model = self.models[model_id]
        if not model.loaded:
            logger.info("Model not loaded: %s", model_id)
            return True

        try:
            # Clear the instance
            model.instance = None
            model.loaded = False
            model.memory_usage = 0

            # Force garbage collection
            import gc

            gc.collect()

            logger.info("Unloaded model: %s", model_id)
            return True

        except Exception as e:
            logger.exception("Failed to unload model %s: %s", model_id, e)
            return False

    def unload_all(self) -> None:
        """Unload all models."""
        for model_id in list(self.models.keys()):
            if self.models[model_id].loaded:
                self.unload_model(model_id)

    def get_model(self, model_id: str) -> Any:
        """
        Get a loaded model instance.

        Raises:
            ValueError: If model is not loaded
        """
        if model_id not in self.models:
            raise ValueError(f"Unknown model: {model_id}")

        model = self.models[model_id]
        if not model.loaded:
            raise ValueError(f"Model not loaded: {model_id}")

        model.last_used = time.time()
        return model.instance

    def get_model_status(self, model_id: str) -> dict[str, Any]:
        """Get detailed status of a model."""
        if model_id not in self.models:
            raise ValueError(f"Unknown model: {model_id}")

        model = self.models[model_id]
        return {
            "loaded": model.loaded,
            "memoryUsage": model.memory_usage,
            "lastUsed": int(model.last_used * 1000) if model.last_used else None,
        }

    def ensure_loaded(
        self, model_id: str, options: dict[str, Any] | None = None
    ) -> Any:
        """
        Ensure a model is loaded and return its instance.

        This is a convenience method that loads the model if needed.
        """
        if model_id not in self.models:
            raise ValueError(f"Unknown model: {model_id}")

        model = self.models[model_id]
        if not model.loaded:
            if not self.load_model(model_id, options):
                raise RuntimeError(f"Failed to load model: {model_id}")

        model.last_used = time.time()
        return model.instance
