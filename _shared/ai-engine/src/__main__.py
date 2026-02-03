#!/usr/bin/env python3
"""
Entry point for the AI Engine.

Runs a JSON-RPC server over stdio for communication with desktop apps.
"""

import sys
import argparse
import logging
from .server import EngineServer
from .job_registry import JobRegistry
from .model_manager import ModelManager
from .cache import Cache
from .handlers import ocr, embeddings, nsfw, whisper


def setup_logging(level: str = "INFO") -> None:
    """Configure logging to stderr (stdout is reserved for JSON-RPC)."""
    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
        stream=sys.stderr,
    )


def register_default_handlers(registry: JobRegistry, model_manager: ModelManager) -> None:
    """Register default job handlers."""
    # OCR handlers
    registry.register("ocr.extract", ocr.extract_text)
    registry.register("ocr.extract_batch", ocr.extract_text_batch)

    # Embedding handlers
    registry.register("embeddings.encode", embeddings.encode_text)
    registry.register("embeddings.encode_batch", embeddings.encode_batch)
    registry.register("embeddings.similarity", embeddings.compute_similarity)

    # NSFW detection handlers
    registry.register("nsfw.classify", nsfw.classify_image)
    registry.register("nsfw.classify_batch", nsfw.classify_batch)

    # Whisper transcription handlers
    registry.register("whisper.transcribe", whisper.transcribe_audio)
    registry.register("whisper.transcribe_batch", whisper.transcribe_batch)


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Niche-Knack AI Engine - JSON-RPC server for AI/ML workloads"
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging level (default: INFO)",
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help="Directory for caching (default: system temp)",
    )
    parser.add_argument(
        "--model-dir",
        default=None,
        help="Directory for storing models (default: system cache)",
    )

    args = parser.parse_args()

    # Set up logging
    setup_logging(args.log_level)
    logger = logging.getLogger("ai-engine")
    logger.info("Starting AI Engine v1.0.0")

    # Initialize components
    cache = Cache(cache_dir=args.cache_dir)
    model_manager = ModelManager(model_dir=args.model_dir)
    job_registry = JobRegistry()

    # Register handlers
    register_default_handlers(job_registry, model_manager)

    # Create and run server
    server = EngineServer(
        job_registry=job_registry,
        model_manager=model_manager,
        cache=cache,
    )

    logger.info("Engine ready, waiting for requests...")

    try:
        server.run()
    except KeyboardInterrupt:
        logger.info("Received interrupt, shutting down...")
    except Exception as e:
        logger.exception("Fatal error: %s", e)
        sys.exit(1)
    finally:
        # Cleanup
        model_manager.unload_all()
        cache.close()
        logger.info("Engine stopped")


if __name__ == "__main__":
    main()
