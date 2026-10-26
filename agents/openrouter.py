"""Shared OpenRouter client used by Researcher, Targeter, and Drafter.

One module so retry/backoff and analytics headers live in exactly one
place. Previously each agent duplicated the same _chat helper, which
meant a fix had to be made three times.

Retry policy: exponential backoff on transient failures (5xx, 429,
network errors). Hard fail on 4xx auth/permission errors so the
operator notices immediately instead of silently retrying.
"""

from __future__ import annotations

import time
from typing import Optional

import requests

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Headers identifying the caller — shows up in your OpenRouter dashboard
# under "Apps" so you can attribute spend to this project specifically.
ANALYTICS_HEADERS = {
    "HTTP-Referer": "https://github.com/brandonm07/signal",
    "X-Title": "Signal Advisory",
}

RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MAX_RETRIES = 3
INITIAL_BACKOFF_S = 1.0


def chat_completion(
    api_key: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    timeout: int = 120,
) -> str:
    """Send one chat completion to OpenRouter, returning the assistant text.

    Retries up to MAX_RETRIES on transient failures with exponential backoff.
    Raises RuntimeError on non-retryable failures or after retries exhausted.
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        **ANALYTICS_HEADERS,
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
    }

    backoff = INITIAL_BACKOFF_S
    last_error: Optional[str] = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.post(
                OPENROUTER_URL, headers=headers, json=payload, timeout=timeout
            )
        except (requests.ConnectionError, requests.Timeout) as exc:
            last_error = f"network error: {exc}"
            if attempt < MAX_RETRIES:
                print(f"  [retry] OpenRouter {last_error}, waiting {backoff:.1f}s")
                time.sleep(backoff)
                backoff *= 2
                continue
            raise RuntimeError(f"OpenRouter unreachable after {MAX_RETRIES} retries: {exc}") from exc

        if resp.status_code in RETRYABLE_STATUS and attempt < MAX_RETRIES:
            last_error = f"{resp.status_code} {resp.text[:200]}"
            print(f"  [retry] OpenRouter {last_error}, waiting {backoff:.1f}s")
            time.sleep(backoff)
            backoff *= 2
            continue

        if resp.status_code >= 400:
            # Non-retryable: auth, bad request, model unavailable, etc.
            # Surface the body so the operator can diagnose.
            raise RuntimeError(
                f"OpenRouter {resp.status_code}: {resp.text[:400]}"
            )

        try:
            return resp.json()["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, ValueError) as exc:
            raise RuntimeError(
                f"OpenRouter returned malformed response: {resp.text[:400]}"
            ) from exc

    raise RuntimeError(f"OpenRouter exhausted {MAX_RETRIES} retries: {last_error}")
