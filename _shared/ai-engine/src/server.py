"""
JSON-RPC Server

Handles JSON-RPC 2.0 requests over stdio.
"""

import json
import sys
import uuid
import time
import traceback
import threading
import logging
from typing import Any, Callable
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass, field

from .job_registry import JobRegistry
from .model_manager import ModelManager
from .cache import Cache


logger = logging.getLogger(__name__)


@dataclass
class Job:
    """Represents a running or completed job."""

    id: str
    type: str
    state: str = "pending"
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    completed_at: float | None = None


class EngineServer:
    """JSON-RPC server that communicates over stdio."""

    def __init__(
        self,
        job_registry: JobRegistry,
        model_manager: ModelManager,
        cache: Cache,
        max_workers: int = 4,
    ) -> None:
        self.job_registry = job_registry
        self.model_manager = model_manager
        self.cache = cache

        self.jobs: dict[str, Job] = {}
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.futures: dict[str, Future[Any]] = {}
        self.start_time = time.time()
        self.lock = threading.Lock()

        # Register built-in methods
        self._register_builtins()

    def _register_builtins(self) -> None:
        """Register built-in engine methods."""
        self.handlers: dict[str, Callable[..., Any]] = {
            # Health
            "engine.health": self._handle_health,
            # Jobs
            "jobs.start": self._handle_jobs_start,
            "jobs.status": self._handle_jobs_status,
            "jobs.result": self._handle_jobs_result,
            "jobs.cancel": self._handle_jobs_cancel,
            "jobs.list": self._handle_jobs_list,
            # Cache
            "cache.get": self._handle_cache_get,
            "cache.set": self._handle_cache_set,
            "cache.delete": self._handle_cache_delete,
            "cache.clear": self._handle_cache_clear,
            # Models
            "models.list": self._handle_models_list,
            "models.load": self._handle_models_load,
            "models.unload": self._handle_models_unload,
            "models.status": self._handle_models_status,
        }

    def run(self) -> None:
        """Run the server, reading from stdin and writing to stdout."""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
                response = self._handle_request(request)
                self._send_response(response)
            except json.JSONDecodeError as e:
                self._send_response(
                    self._error_response(None, -32700, f"Parse error: {e}")
                )
            except Exception as e:
                logger.exception("Unexpected error handling request")
                self._send_response(
                    self._error_response(None, -32603, f"Internal error: {e}")
                )

    def _handle_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Handle a single JSON-RPC request."""
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})

        # Validate request
        if not method:
            return self._error_response(req_id, -32600, "Invalid request: missing method")

        # Check built-in handlers first
        if method in self.handlers:
            try:
                result = self.handlers[method](**params)
                return self._success_response(req_id, result)
            except TypeError as e:
                return self._error_response(req_id, -32602, f"Invalid params: {e}")
            except Exception as e:
                logger.exception("Error in handler %s", method)
                return self._error_response(req_id, -32603, f"Internal error: {e}")

        # Unknown method
        return self._error_response(req_id, -32601, f"Method not found: {method}")

    def _send_response(self, response: dict[str, Any]) -> None:
        """Send a JSON-RPC response to stdout."""
        print(json.dumps(response), flush=True)

    def _send_event(self, event: dict[str, Any]) -> None:
        """Send a streaming event to stdout."""
        print(json.dumps(event), flush=True)

    def _success_response(
        self, req_id: str | int | None, result: Any
    ) -> dict[str, Any]:
        """Create a success response."""
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": result,
        }

    def _error_response(
        self, req_id: str | int | None, code: int, message: str, data: Any = None
    ) -> dict[str, Any]:
        """Create an error response."""
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": error,
        }

    # =========================================================================
    # Health handlers
    # =========================================================================

    def _handle_health(self) -> dict[str, Any]:
        """Return engine health status."""
        import psutil

        process = psutil.Process()
        memory = process.memory_info()

        return {
            "status": "ok",
            "version": "1.0.0",
            "uptime": int(time.time() - self.start_time),
            "memory": {
                "used": memory.rss,
                "total": psutil.virtual_memory().total,
            },
        }

    # =========================================================================
    # Job handlers
    # =========================================================================

    def _handle_jobs_start(
        self, type: str, payload: Any, priority: str = "normal"
    ) -> dict[str, str]:
        """Start a new job."""
        job_id = str(uuid.uuid4())

        # Check if job type is registered
        if not self.job_registry.has_handler(type):
            raise ValueError(f"Unknown job type: {type}")

        # Create job
        job = Job(id=job_id, type=type)
        with self.lock:
            self.jobs[job_id] = job

        # Submit to executor
        future = self.executor.submit(self._run_job, job_id, type, payload)
        with self.lock:
            self.futures[job_id] = future

        logger.info("Started job %s of type %s", job_id, type)
        return {"jobId": job_id}

    def _run_job(self, job_id: str, job_type: str, payload: Any) -> None:
        """Run a job in the thread pool."""
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return
            job.state = "running"
            job.started_at = time.time()

        # Progress callback
        def on_progress(percent: float, message: str = "") -> None:
            with self.lock:
                if job_id in self.jobs:
                    self.jobs[job_id].progress = percent
                    self.jobs[job_id].message = message

            self._send_event({
                "type": "progress",
                "jobId": job_id,
                "timestamp": int(time.time() * 1000),
                "data": {"percent": percent, "message": message},
            })

        try:
            # Get handler and execute
            handler = self.job_registry.get_handler(job_type)
            result = handler(payload, on_progress=on_progress)

            # Success
            with self.lock:
                if job_id in self.jobs:
                    self.jobs[job_id].state = "done"
                    self.jobs[job_id].result = result
                    self.jobs[job_id].completed_at = time.time()

            self._send_event({
                "type": "result",
                "jobId": job_id,
                "timestamp": int(time.time() * 1000),
                "data": result,
            })

            logger.info("Job %s completed successfully", job_id)

        except Exception as e:
            # Failure
            error_msg = str(e)
            logger.exception("Job %s failed: %s", job_id, error_msg)

            with self.lock:
                if job_id in self.jobs:
                    self.jobs[job_id].state = "failed"
                    self.jobs[job_id].error = error_msg
                    self.jobs[job_id].completed_at = time.time()

            self._send_event({
                "type": "error",
                "jobId": job_id,
                "timestamp": int(time.time() * 1000),
                "data": error_msg,
            })

    def _handle_jobs_status(self, jobId: str) -> dict[str, Any]:
        """Get job status."""
        with self.lock:
            job = self.jobs.get(jobId)

        if not job:
            raise ValueError(f"Job not found: {jobId}")

        result: dict[str, Any] = {
            "state": job.state,
            "progress": job.progress,
        }
        if job.message:
            result["message"] = job.message
        if job.started_at:
            result["startedAt"] = int(job.started_at * 1000)
        if job.completed_at:
            result["completedAt"] = int(job.completed_at * 1000)

        return result

    def _handle_jobs_result(self, jobId: str) -> dict[str, Any]:
        """Get job result."""
        with self.lock:
            job = self.jobs.get(jobId)

        if not job:
            raise ValueError(f"Job not found: {jobId}")

        if job.state == "done":
            return {"success": True, "data": job.result}
        elif job.state == "failed":
            return {"success": False, "error": job.error}
        else:
            return {"success": False, "error": f"Job not complete: {job.state}"}

    def _handle_jobs_cancel(self, jobId: str) -> dict[str, Any]:
        """Cancel a job."""
        with self.lock:
            job = self.jobs.get(jobId)
            future = self.futures.get(jobId)

        if not job:
            raise ValueError(f"Job not found: {jobId}")

        if job.state in ("done", "failed", "cancelled"):
            return {"success": False, "reason": f"Job already {job.state}"}

        # Try to cancel the future
        if future and future.cancel():
            with self.lock:
                job.state = "cancelled"
                job.completed_at = time.time()
            logger.info("Job %s cancelled", jobId)
            return {"success": True}
        else:
            # Can't cancel running job
            return {"success": False, "reason": "Job is already running"}

    def _handle_jobs_list(self) -> list[dict[str, Any]]:
        """List all jobs."""
        with self.lock:
            return [
                {
                    "jobId": job.id,
                    "type": job.type,
                    "state": job.state,
                    "progress": job.progress,
                }
                for job in self.jobs.values()
            ]

    # =========================================================================
    # Cache handlers
    # =========================================================================

    def _handle_cache_get(self, key: str) -> dict[str, Any]:
        """Get cached value."""
        result = self.cache.get(key)
        if result is None:
            return {"found": False}
        return {"found": True, "value": result["value"], "expiresAt": result.get("expiresAt")}

    def _handle_cache_set(
        self, key: str, value: Any, ttl: int | None = None
    ) -> dict[str, bool]:
        """Set cached value."""
        self.cache.set(key, value, ttl=ttl)
        return {"success": True}

    def _handle_cache_delete(self, key: str) -> dict[str, bool]:
        """Delete cached value."""
        self.cache.delete(key)
        return {"success": True}

    def _handle_cache_clear(self, prefix: str | None = None) -> dict[str, Any]:
        """Clear cache."""
        cleared = self.cache.clear(prefix=prefix)
        return {"success": True, "cleared": cleared}

    # =========================================================================
    # Model handlers
    # =========================================================================

    def _handle_models_list(self) -> list[dict[str, Any]]:
        """List available models."""
        return self.model_manager.list_models()

    def _handle_models_load(
        self, modelId: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Load a model."""
        start = time.time()
        success = self.model_manager.load_model(modelId, options)
        load_time = int((time.time() - start) * 1000)
        return {"success": success, "loadTime": load_time}

    def _handle_models_unload(self, modelId: str) -> dict[str, bool]:
        """Unload a model."""
        success = self.model_manager.unload_model(modelId)
        return {"success": success}

    def _handle_models_status(self, modelId: str) -> dict[str, Any]:
        """Get model status."""
        return self.model_manager.get_model_status(modelId)
