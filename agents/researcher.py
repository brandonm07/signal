"""Researcher agent.

Two passes per account:
  1. Run three targeted DuckDuckGo searches (overview, recent news, leadership).
  2. Feed the combined snippets to an open-weight model on OpenRouter and ask
     it to emit a structured brief in the format defined by RESEARCHER_PROMPT.

Kept deliberately small: one class, a couple of private helpers, no frameworks.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import requests
from ddgs import DDGS

from config.prompts import (
    RESEARCHER_MAX_TOKENS,
    RESEARCHER_MODEL,
    RESEARCHER_PROMPT,
)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str

    def as_bullet(self) -> str:
        return f"- {self.title} ({self.url})\n  {self.snippet}"


class Researcher:
    """Runs searches and asks the model to write a structured brief."""

    def __init__(self, api_key: Optional[str] = None, model: str = RESEARCHER_MODEL):
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key."
            )
        self.model = model

    # ---- public API ---------------------------------------------------------

    def research(
        self,
        company_name: str,
        contact_name: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> str:
        """Return a markdown research brief for `company_name`."""
        queries = self._build_queries(company_name)
        search_blocks = []
        for q in queries:
            results = self._search(q, max_results=5)
            search_blocks.append(_format_search_block(q, results))

        user_message = _build_user_message(
            company_name=company_name,
            contact_name=contact_name,
            notes=notes,
            search_blocks=search_blocks,
        )
        return self._chat(
            system=RESEARCHER_PROMPT,
            user=user_message,
            max_tokens=RESEARCHER_MAX_TOKENS,
        )

    # ---- internals ----------------------------------------------------------

    @staticmethod
    def _build_queries(company: str) -> list[str]:
        # These three queries were chosen to cover the three buckets in the
        # RESEARCHER_PROMPT: basic profile, recent events, likely decision makers.
        return [
            f"{company} company overview",
            f"{company} news last 12 months",
            f"{company} leadership OR CTO OR CIO OR VP IT",
        ]

    @staticmethod
    def _search(query: str, max_results: int = 5) -> list[SearchResult]:
        """Top-N DuckDuckGo results, normalized. Returns [] on failure."""
        try:
            with DDGS() as ddgs:
                raw = list(ddgs.text(query, max_results=max_results))
        except Exception as exc:
            # DDG rate-limits aggressively; don't crash the whole run.
            print(f"  [warn] search failed for {query!r}: {exc}")
            return []
        return [
            SearchResult(
                title=r.get("title", "").strip(),
                url=r.get("href", "").strip(),
                snippet=r.get("body", "").strip(),
            )
            for r in raw
        ]

    def _chat(self, system: str, user: str, max_tokens: int) -> str:
        """Single OpenRouter chat completion. Returns the assistant message."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            # Optional analytics headers; OpenRouter shows these in the dashboard.
            "HTTP-Referer": "https://github.com/brandonm07/signal",
            "X-Title": "Signal Advisory",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
        }
        resp = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()


def _format_search_block(query: str, results: list[SearchResult]) -> str:
    if not results:
        return f"### Search: {query}\n(no results)"
    bullets = "\n".join(r.as_bullet() for r in results)
    return f"### Search: {query}\n{bullets}"


def _build_user_message(
    company_name: str,
    contact_name: Optional[str],
    notes: Optional[str],
    search_blocks: list[str],
) -> str:
    header = [f"Company: {company_name}"]
    if contact_name:
        header.append(f"Known contact: {contact_name}")
    if notes:
        header.append(f"Sales notes: {notes}")
    header_text = "\n".join(header)

    searches = "\n\n".join(search_blocks)
    return (
        f"{header_text}\n\n"
        f"Below are raw DuckDuckGo results from three targeted searches. Use them "
        f"as primary source material. Cite URLs in your Sources section. If a fact "
        f"is not supported by these results, mark it \"unconfirmed\".\n\n"
        f"{searches}\n\n"
        f"Now write the brief exactly in the OUTPUT FORMAT from the system prompt."
    )
