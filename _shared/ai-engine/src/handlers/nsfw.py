"""
NSFW Detection Handler

Detects NSFW content in images using a transformer model.
"""

import logging
from typing import Any, Callable
from pathlib import Path


logger = logging.getLogger(__name__)

# Lazy-loaded classifier
_classifier = None


def _get_classifier():
    """Get or create the NSFW classifier."""
    global _classifier

    if _classifier is None:
        from transformers import pipeline

        logger.info("Loading NSFW classifier...")
        _classifier = pipeline(
            "image-classification",
            model="Falconsai/nsfw_image_detection",
            device=-1,  # CPU
        )

    return _classifier


def classify_image(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Classify an image for NSFW content.

    Payload:
        image_path: Path to the image file
        threshold: Classification threshold (default: 0.5)

    Returns:
        is_nsfw: Boolean indicating if image is NSFW
        confidence: Confidence score (0-1)
        scores: All classification scores
    """
    image_path = payload.get("image_path")
    if not image_path:
        raise ValueError("image_path is required")

    threshold = payload.get("threshold", 0.5)

    on_progress(10, "Loading classifier...")

    classifier = _get_classifier()

    on_progress(40, "Classifying image...")

    # Run classification
    results = classifier(image_path)

    on_progress(90, "Processing results...")

    # Parse results
    scores = {}
    nsfw_score = 0.0

    for result in results:
        label = result["label"].lower()
        score = result["score"]
        scores[label] = score

        if label == "nsfw":
            nsfw_score = score

    is_nsfw = nsfw_score >= threshold

    on_progress(100, "Complete")

    return {
        "is_nsfw": is_nsfw,
        "confidence": nsfw_score,
        "scores": scores,
        "threshold": threshold,
    }


def classify_batch(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Classify multiple images for NSFW content.

    Payload:
        image_paths: List of paths to image files
        threshold: Classification threshold (default: 0.5)

    Returns:
        results: List of classification results
        summary: Count of NSFW vs safe images
    """
    image_paths = payload.get("image_paths", [])
    if not image_paths:
        raise ValueError("image_paths is required")

    threshold = payload.get("threshold", 0.5)

    on_progress(5, "Loading classifier...")

    classifier = _get_classifier()

    results = []
    nsfw_count = 0
    safe_count = 0
    error_count = 0
    total = len(image_paths)

    for i, image_path in enumerate(image_paths):
        progress = 10 + int((i / total) * 85)
        on_progress(progress, f"Processing image {i + 1}/{total}...")

        try:
            # Run classification
            classification = classifier(image_path)

            # Parse results
            scores = {}
            nsfw_score = 0.0

            for result in classification:
                label = result["label"].lower()
                score = result["score"]
                scores[label] = score

                if label == "nsfw":
                    nsfw_score = score

            is_nsfw = nsfw_score >= threshold

            if is_nsfw:
                nsfw_count += 1
            else:
                safe_count += 1

            results.append({
                "path": image_path,
                "success": True,
                "is_nsfw": is_nsfw,
                "confidence": nsfw_score,
                "scores": scores,
            })

        except Exception as e:
            logger.exception("Failed to classify %s: %s", image_path, e)
            error_count += 1
            results.append({
                "path": image_path,
                "success": False,
                "error": str(e),
            })

    on_progress(100, "Complete")

    return {
        "results": results,
        "summary": {
            "total": total,
            "nsfw": nsfw_count,
            "safe": safe_count,
            "errors": error_count,
        },
        "threshold": threshold,
    }
