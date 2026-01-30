"""
Cache

Disk-based caching with TTL support.
"""

import os
import json
import time
import hashlib
import logging
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


class Cache:
    """Simple disk-based cache with TTL support."""

    def __init__(self, cache_dir: str | None = None, default_ttl: int | None = None) -> None:
        """
        Initialize the cache.

        Args:
            cache_dir: Directory for cache files
            default_ttl: Default TTL in seconds (None = no expiry)
        """
        if cache_dir:
            self.cache_dir = Path(cache_dir)
        else:
            # Use temp directory
            import tempfile

            self.cache_dir = Path(tempfile.gettempdir()) / "niche-knack-cache"

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.default_ttl = default_ttl

        logger.info("Cache directory: %s", self.cache_dir)

    def _key_to_path(self, key: str) -> Path:
        """Convert a cache key to a file path."""
        # Hash the key to avoid filesystem issues
        key_hash = hashlib.sha256(key.encode()).hexdigest()[:32]
        return self.cache_dir / f"{key_hash}.json"

    def get(self, key: str) -> dict[str, Any] | None:
        """
        Get a value from cache.

        Returns:
            Dict with 'value' and 'expiresAt' if found, None if not found or expired
        """
        path = self._key_to_path(key)

        if not path.exists():
            return None

        try:
            with open(path, "r") as f:
                entry = json.load(f)

            # Check expiry
            expires_at = entry.get("expiresAt")
            if expires_at and time.time() * 1000 > expires_at:
                # Expired, remove and return None
                path.unlink(missing_ok=True)
                return None

            return entry

        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to read cache entry %s: %s", key, e)
            return None

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        """
        Set a value in cache.

        Args:
            key: Cache key
            value: Value to cache (must be JSON serializable)
            ttl: TTL in seconds (None uses default_ttl, 0 means no expiry)
        """
        path = self._key_to_path(key)

        effective_ttl = ttl if ttl is not None else self.default_ttl
        expires_at = None
        if effective_ttl:
            expires_at = int((time.time() + effective_ttl) * 1000)

        entry = {
            "key": key,
            "value": value,
            "createdAt": int(time.time() * 1000),
            "expiresAt": expires_at,
        }

        try:
            with open(path, "w") as f:
                json.dump(entry, f)
        except (TypeError, OSError) as e:
            logger.warning("Failed to write cache entry %s: %s", key, e)

    def delete(self, key: str) -> bool:
        """
        Delete a value from cache.

        Returns:
            True if deleted, False if not found
        """
        path = self._key_to_path(key)

        if path.exists():
            path.unlink()
            return True
        return False

    def clear(self, prefix: str | None = None) -> int:
        """
        Clear cache entries.

        Args:
            prefix: If provided, only clear keys starting with prefix

        Returns:
            Number of entries cleared
        """
        cleared = 0

        for path in self.cache_dir.glob("*.json"):
            try:
                if prefix:
                    # Need to read the file to check the key
                    with open(path, "r") as f:
                        entry = json.load(f)
                    if not entry.get("key", "").startswith(prefix):
                        continue

                path.unlink()
                cleared += 1

            except (json.JSONDecodeError, OSError):
                # Remove corrupted entries
                path.unlink(missing_ok=True)
                cleared += 1

        logger.info("Cleared %d cache entries", cleared)
        return cleared

    def prune(self) -> int:
        """
        Remove expired entries.

        Returns:
            Number of entries removed
        """
        pruned = 0
        now = time.time() * 1000

        for path in self.cache_dir.glob("*.json"):
            try:
                with open(path, "r") as f:
                    entry = json.load(f)

                expires_at = entry.get("expiresAt")
                if expires_at and now > expires_at:
                    path.unlink()
                    pruned += 1

            except (json.JSONDecodeError, OSError):
                # Remove corrupted entries
                path.unlink(missing_ok=True)
                pruned += 1

        if pruned:
            logger.info("Pruned %d expired cache entries", pruned)
        return pruned

    def get_stats(self) -> dict[str, Any]:
        """Get cache statistics."""
        total_size = 0
        count = 0
        expired_count = 0
        now = time.time() * 1000

        for path in self.cache_dir.glob("*.json"):
            try:
                total_size += path.stat().st_size
                count += 1

                with open(path, "r") as f:
                    entry = json.load(f)
                expires_at = entry.get("expiresAt")
                if expires_at and now > expires_at:
                    expired_count += 1

            except (json.JSONDecodeError, OSError):
                pass

        return {
            "directory": str(self.cache_dir),
            "entries": count,
            "expiredEntries": expired_count,
            "totalSize": total_size,
        }

    def close(self) -> None:
        """Clean up resources (no-op for disk cache)."""
        # Optionally prune on close
        self.prune()
