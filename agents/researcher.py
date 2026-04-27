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

from agents.openrouter import chat_completion
from config.prompts import (
    RESEARCHER_MAX_TOKENS,
    RESEARCHER_MODEL,
    RESEARCHER_PROMPT,
)

TAVILY_URL = "https://api.tavily.com/search"


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
        # Tavily is preferred when a key is present — cleaner results on
        # enterprise searches than DDG. Falls back to DDG silently otherwise.
        self.tavily_key = os.environ.get("TAVILY_API_KEY") or None

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
        brief = self._chat(
            system=RESEARCHER_PROMPT,
            user=user_message,
            max_tokens=RESEARCHER_MAX_TOKENS,
        )
        # Post-processing guardrail: flag contact lines that name a person
        # but don't cite a source URL on the same line. Does not alter the
        # brief body; just prepends a warning header if anything looks off.
        warnings = _find_unsourced_contacts(brief)
        if warnings:
            header = "\n".join(
                ["> **VERIFICATION REQUIRED**: the following contact lines were",
                 "> not backed by a source URL on the same line. Confirm before",
                 "> outreach — the model may have invented them."]
                + [f"> - {w}" for w in warnings]
                + [""]
            )
            brief = f"{header}\n{brief}"
        return brief

    # ---- internals ----------------------------------------------------------

    @staticmethod
    def _build_queries(company: str) -> list[str]:
        # Four targeted queries. site:-scoped ones keep the model from having
        # to invent contacts — LinkedIn for named leaders, businesswire for
        # executive announcements, sec.gov for public-company filings.
        return [
            f"{company} company overview",
            f"{company} news last 12 months",
            f'site:linkedin.com/in "{company}" CIO OR CTO OR "VP of IT" OR "head of infrastructure"',
            f"site:businesswire.com {company} executive appointment OR CIO OR CTO",
        ]

    def _search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        """Top-N search results, normalized. Returns [] on failure."""
        if self.tavily_key:
            return _search_tavily(query, max_results, self.tavily_key)
        return _search_ddg(query, max_results)

    def _chat(self, system: str, user: str, max_tokens: int) -> str:
        return chat_completion(self.api_key, self.model, system, user, max_tokens)


def _search_ddg(query: str, max_results: int) -> list[SearchResult]:
    """DuckDuckGo via the ddgs package (formerly duckduckgo-search)."""
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=max_results))
    except Exception as exc:
        # Rate limits, network hiccups: never crash the whole run.
        print(f"  [warn] DDG search failed for {query!r}: {exc}")
        return []
    return [
        SearchResult(
            title=r.get("title", "").strip(),
            url=r.get("href", "").strip(),
            snippet=r.get("body", "").strip(),
        )
        for r in raw
    ]


def _search_tavily(query: str, max_results: int, api_key: str) -> list[SearchResult]:
    """Tavily Search API — cleaner results on enterprise queries than DDG.

    Free tier gives 1000 searches/month. Docs: https://docs.tavily.com
    """
    try:
        resp = requests.post(
            TAVILY_URL,
            json={
                "api_key": api_key,
                "query": query,
                "max_results": max_results,
                "search_depth": "basic",
            },
            timeout=30,
        )
        resp.raise_for_status()
        raw = resp.json().get("results", [])
    except Exception as exc:
        print(f"  [warn] Tavily search failed for {query!r}: {exc}")
        return []
    return [
        SearchResult(
            title=r.get("title", "").strip(),
            url=r.get("url", "").strip(),
            snippet=r.get("content", "").strip(),
        )
        for r in raw
    ]


_TITLE_WORDS = (
    "CEO", "CIO", "CTO", "CFO", "COO", "CISO", "CRO",
    "VP", "SVP", "EVP", "Vice President",
    "Director", "Head of", "Chief",
    "President", "Founder", "Manager",
)


def _find_unsourced_contacts(brief: str) -> list[str]:
    """Return bullets in 'Who to Talk To' that look like a named contact
    but lack a URL and don't say 'unconfirmed'. Empty list = all good."""
    lines = brief.splitlines()
    in_section = False
    flagged: list[str] = []
    for raw in lines:
        stripped = raw.strip()
        if stripped.lower().startswith("## "):
            in_section = stripped.lower().startswith("## who to talk to")
            continue
        if not in_section:
            continue
        if not stripped.startswith(("-", "*")):
            continue
        if "unconfirmed" in stripped.lower():
            continue
        if "http://" in stripped or "https://" in stripped:
            continue
        # Only flag lines that actually look like they reference a person
        # (title word present). A pure role placeholder won't trip this.
        if any(word.lower() in stripped.lower() for word in _TITLE_WORDS):
            flagged.append(stripped.lstrip("-* ").strip())
    return flagged


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
