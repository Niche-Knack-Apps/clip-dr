"""
Embeddings Handler

Generates text embeddings using Sentence Transformers.
"""

import logging
from typing import Any, Callable
import numpy as np


logger = logging.getLogger(__name__)

# Lazy-loaded model
_model = None
_model_name = None


def _get_model(model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
    """Get or create the embeddings model."""
    global _model, _model_name

    if _model is None or _model_name != model_name:
        from sentence_transformers import SentenceTransformer

        logger.info("Loading embedding model: %s", model_name)
        _model = SentenceTransformer(model_name)
        _model_name = model_name

    return _model


def encode_text(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Encode text into embeddings.

    Payload:
        text: Text to encode
        model: Optional model name (default: all-MiniLM-L6-v2)
        normalize: Whether to normalize embeddings (default: True)

    Returns:
        embedding: List of floats representing the embedding
        dimensions: Number of dimensions
    """
    text = payload.get("text")
    if not text:
        raise ValueError("text is required")

    model_name = payload.get("model", "sentence-transformers/all-MiniLM-L6-v2")
    normalize = payload.get("normalize", True)

    on_progress(20, "Loading model...")

    model = _get_model(model_name)

    on_progress(50, "Encoding text...")

    # Generate embedding
    embedding = model.encode(
        text,
        normalize_embeddings=normalize,
        convert_to_numpy=True,
    )

    on_progress(100, "Complete")

    return {
        "embedding": embedding.tolist(),
        "dimensions": len(embedding),
    }


def encode_batch(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Encode multiple texts into embeddings.

    Payload:
        texts: List of texts to encode
        model: Optional model name (default: all-MiniLM-L6-v2)
        normalize: Whether to normalize embeddings (default: True)
        batch_size: Batch size for encoding (default: 32)

    Returns:
        embeddings: List of embeddings
        dimensions: Number of dimensions
    """
    texts = payload.get("texts", [])
    if not texts:
        raise ValueError("texts is required")

    model_name = payload.get("model", "sentence-transformers/all-MiniLM-L6-v2")
    normalize = payload.get("normalize", True)
    batch_size = payload.get("batch_size", 32)

    on_progress(10, "Loading model...")

    model = _get_model(model_name)

    on_progress(20, f"Encoding {len(texts)} texts...")

    # Generate embeddings
    embeddings = model.encode(
        texts,
        normalize_embeddings=normalize,
        convert_to_numpy=True,
        batch_size=batch_size,
        show_progress_bar=False,
    )

    on_progress(100, "Complete")

    return {
        "embeddings": embeddings.tolist(),
        "dimensions": embeddings.shape[1] if len(embeddings.shape) > 1 else len(embeddings),
        "count": len(texts),
    }


def compute_similarity(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Compute similarity between texts.

    Payload:
        text1: First text (or embedding)
        text2: Second text (or embedding)
        texts: Alternative - list of texts to compare all pairs
        model: Optional model name (default: all-MiniLM-L6-v2)

    Returns:
        similarity: Cosine similarity score (-1 to 1)
        OR
        similarities: Matrix of pairwise similarities (if texts provided)
    """
    model_name = payload.get("model", "sentence-transformers/all-MiniLM-L6-v2")

    # Pairwise comparison mode
    if "texts" in payload:
        texts = payload["texts"]
        if len(texts) < 2:
            raise ValueError("Need at least 2 texts for comparison")

        on_progress(10, "Loading model...")
        model = _get_model(model_name)

        on_progress(30, "Encoding texts...")
        embeddings = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)

        on_progress(80, "Computing similarities...")
        # Compute pairwise cosine similarities
        similarities = np.dot(embeddings, embeddings.T).tolist()

        on_progress(100, "Complete")

        return {
            "similarities": similarities,
            "texts": texts,
        }

    # Single pair mode
    text1 = payload.get("text1")
    text2 = payload.get("text2")

    if not text1 or not text2:
        raise ValueError("text1 and text2 are required")

    on_progress(10, "Loading model...")
    model = _get_model(model_name)

    on_progress(40, "Encoding texts...")
    embeddings = model.encode([text1, text2], normalize_embeddings=True, convert_to_numpy=True)

    on_progress(80, "Computing similarity...")
    # Cosine similarity (embeddings are normalized)
    similarity = float(np.dot(embeddings[0], embeddings[1]))

    on_progress(100, "Complete")

    return {"similarity": similarity}
