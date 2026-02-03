"""
Job Registry

Manages registration and lookup of job handlers.
"""

import logging
from typing import Any, Callable, Protocol


logger = logging.getLogger(__name__)


class ProgressCallback(Protocol):
    """Protocol for progress callbacks."""

    def __call__(self, percent: float, message: str = "") -> None:
        """Report progress."""
        ...


JobHandler = Callable[[Any, ProgressCallback], Any]


class JobRegistry:
    """Registry for job handlers."""

    def __init__(self) -> None:
        self._handlers: dict[str, JobHandler] = {}

    def register(self, job_type: str, handler: JobHandler) -> None:
        """
        Register a handler for a job type.

        Args:
            job_type: The job type identifier (e.g., "ocr.extract")
            handler: Function that takes (payload, on_progress) and returns result
        """
        if job_type in self._handlers:
            logger.warning("Overwriting handler for job type: %s", job_type)

        self._handlers[job_type] = handler
        logger.info("Registered handler for job type: %s", job_type)

    def unregister(self, job_type: str) -> bool:
        """
        Unregister a handler.

        Returns:
            True if handler was removed, False if not found
        """
        if job_type in self._handlers:
            del self._handlers[job_type]
            logger.info("Unregistered handler for job type: %s", job_type)
            return True
        return False

    def has_handler(self, job_type: str) -> bool:
        """Check if a handler exists for a job type."""
        return job_type in self._handlers

    def get_handler(self, job_type: str) -> JobHandler:
        """
        Get a handler for a job type.

        Raises:
            KeyError: If no handler is registered
        """
        if job_type not in self._handlers:
            raise KeyError(f"No handler registered for job type: {job_type}")
        return self._handlers[job_type]

    def list_job_types(self) -> list[str]:
        """List all registered job types."""
        return list(self._handlers.keys())

    def clear(self) -> None:
        """Remove all registered handlers."""
        self._handlers.clear()
        logger.info("Cleared all job handlers")


# Global registry instance
_global_registry: JobRegistry | None = None


def get_registry() -> JobRegistry:
    """Get the global job registry."""
    global _global_registry
    if _global_registry is None:
        _global_registry = JobRegistry()
    return _global_registry


def register_handler(job_type: str) -> Callable[[JobHandler], JobHandler]:
    """
    Decorator to register a job handler.

    Usage:
        @register_handler("ocr.extract")
        def extract_text(payload, on_progress):
            ...
    """

    def decorator(handler: JobHandler) -> JobHandler:
        get_registry().register(job_type, handler)
        return handler

    return decorator
