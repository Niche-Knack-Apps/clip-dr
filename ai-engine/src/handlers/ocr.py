"""
OCR Handler

Extracts text from images using EasyOCR.
"""

import logging
from typing import Any, Callable


logger = logging.getLogger(__name__)

# Lazy-loaded reader
_reader = None


def _get_reader(lang_list: list[str] | None = None):
    """Get or create the EasyOCR reader."""
    global _reader

    if _reader is None:
        import easyocr

        languages = lang_list or ["en"]
        logger.info("Initializing EasyOCR with languages: %s", languages)
        _reader = easyocr.Reader(languages, gpu=False)

    return _reader


def extract_text(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Extract text from an image.

    Payload:
        image_path: Path to the image file
        languages: Optional list of language codes (default: ["en"])
        detail: If True, return detailed bounding box info (default: False)

    Returns:
        text: Extracted text
        regions: List of text regions with bounding boxes (if detail=True)
    """
    image_path = payload.get("image_path")
    if not image_path:
        raise ValueError("image_path is required")

    languages = payload.get("languages", ["en"])
    detail = payload.get("detail", False)

    on_progress(10, "Loading OCR model...")

    reader = _get_reader(languages)

    on_progress(30, "Processing image...")

    # Perform OCR
    results = reader.readtext(image_path, detail=1)

    on_progress(80, "Extracting text...")

    # Extract text
    texts = []
    regions = []

    for bbox, text, confidence in results:
        texts.append(text)
        if detail:
            regions.append({
                "text": text,
                "confidence": confidence,
                "bbox": {
                    "topLeft": bbox[0],
                    "topRight": bbox[1],
                    "bottomRight": bbox[2],
                    "bottomLeft": bbox[3],
                },
            })

    on_progress(100, "Complete")

    result = {"text": " ".join(texts)}
    if detail:
        result["regions"] = regions

    return result


def extract_text_batch(
    payload: dict[str, Any],
    on_progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """
    Extract text from multiple images.

    Payload:
        image_paths: List of paths to image files
        languages: Optional list of language codes (default: ["en"])
        detail: If True, return detailed bounding box info (default: False)

    Returns:
        results: List of extraction results
    """
    image_paths = payload.get("image_paths", [])
    if not image_paths:
        raise ValueError("image_paths is required")

    languages = payload.get("languages", ["en"])
    detail = payload.get("detail", False)

    on_progress(5, "Loading OCR model...")

    reader = _get_reader(languages)

    results = []
    total = len(image_paths)

    for i, image_path in enumerate(image_paths):
        progress = 10 + int((i / total) * 85)
        on_progress(progress, f"Processing image {i + 1}/{total}...")

        try:
            ocr_results = reader.readtext(image_path, detail=1)

            texts = []
            regions = []

            for bbox, text, confidence in ocr_results:
                texts.append(text)
                if detail:
                    regions.append({
                        "text": text,
                        "confidence": confidence,
                        "bbox": {
                            "topLeft": bbox[0],
                            "topRight": bbox[1],
                            "bottomRight": bbox[2],
                            "bottomLeft": bbox[3],
                        },
                    })

            result = {
                "path": image_path,
                "success": True,
                "text": " ".join(texts),
            }
            if detail:
                result["regions"] = regions

            results.append(result)

        except Exception as e:
            logger.exception("Failed to process %s: %s", image_path, e)
            results.append({
                "path": image_path,
                "success": False,
                "error": str(e),
            })

    on_progress(100, "Complete")

    return {"results": results}
