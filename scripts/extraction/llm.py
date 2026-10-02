"""Minimal OpenRouter client for the offline extraction scripts.

Reads OPENROUTER_API_KEY from the environment or the project-root .env file.
Every model call (including failed attempts) is appended to logs/llm-usage.jsonl.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]  # project root (scripts/extraction/ -> ../..)
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
USAGE_LOG = ROOT / "logs" / "llm-usage.jsonl"


def load_env(path: Path = ROOT / ".env") -> None:
    """Load the project-root .env into os.environ (existing env vars win)."""
    load_dotenv(path, override=False)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log_usage(entry: dict) -> None:
    USAGE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with USAGE_LOG.open("a") as f:
        f.write(json.dumps({"ts": now_iso(), **entry}, ensure_ascii=False) + "\n")


def chat_json(
    model: str,
    messages: list[dict],
    *,
    max_tokens: int = 32000,
    retries: int = 2,
    temperature: float = 0,
    meta: dict | None = None,
    timeout: int = 600,
) -> dict:
    """Call OpenRouter in JSON mode. Returns {"json", "usage", "model"}.

    `meta` (e.g. {"script", "stage", "image"}) is copied into the usage log line.
    """
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY missing (set it in .env)")
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {key}", "X-Title": "khmer-menus extraction"}

    last_err: Exception | None = None
    for attempt in range(retries + 1):
        t0 = time.time()
        data: dict | None = None
        status: int | None = None
        try:
            res = requests.post(ENDPOINT, json=payload, headers=headers, timeout=timeout)
            status = res.status_code
            try:
                data = res.json()
            except ValueError:
                data = None
            if not data or not data.get("choices"):
                msg = (data or {}).get("error", {}).get("message") if data else None
                raise RuntimeError(f"OpenRouter {status}: {msg or json.dumps(data)[:300]}")
            text = data["choices"][0].get("message", {}).get("content") or ""
            parsed = parse_json_loose(text)
            log_usage(_usage_entry(meta, model, data, status, t0, attempt, ok=True))
            return {"json": parsed, "usage": data.get("usage") or {}, "model": data.get("model") or model}
        except Exception as err:  # network, HTTP, or JSON errors: log and retry
            last_err = err
            log_usage(_usage_entry(meta, model, data, status, t0, attempt, ok=False, error=str(err)))
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    raise last_err  # type: ignore[misc]


def _usage_entry(meta, model, data, status, t0, attempt, *, ok, error=None) -> dict:
    data = data or {}
    u = data.get("usage") or {}
    entry = {
        **(meta or {}),
        "model_requested": model,
        "model": data.get("model"),
        "provider": data.get("provider"),
        "generation_id": data.get("id"),
        "ok": ok,
        "http_status": status,
        "attempt": attempt + 1,
        "seconds": round(time.time() - t0, 1),
        "prompt_tokens": u.get("prompt_tokens"),
        "completion_tokens": u.get("completion_tokens"),
        "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
        "cost_usd": u.get("cost"),
        "finish_reason": (data.get("choices") or [{}])[0].get("finish_reason"),
    }
    if error:
        entry["error"] = error[:300]
    return entry


def parse_json_loose(text: str):
    """Models sometimes wrap JSON in ``` fences or add a sentence; take the outermost object."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else ""
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[:-3]
    cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start >= 0 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise ValueError(f"Model did not return JSON: {text[:200]}")


def image_part(base64_jpeg: str) -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_jpeg}"}}
