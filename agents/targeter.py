"""Targeter agent.

Given a research brief, enriches contact data from a paid source if a
key is set (ZoomInfo, then Apollo), otherwise falls back to LinkedIn
URL discovery via Tavily/DDG search. Emails are NEVER pattern-guessed:
if a data source doesn't return one, the email stays blank.

The enriched candidates are then fed to a small LLM ranking pass that
picks the top 2-3 matching Signal's persona priorities and writes a
one-sentence hook per person using context from the research brief.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from typing import Optional

import requests

from agents.researcher import SearchResult, _search_ddg, _search_tavily
from config.prompts import TARGETER_MAX_TOKENS, TARGETER_MODEL, TARGETER_PROMPT

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
APOLLO_URL = "https://api.apollo.io/v1/mixed_people/search"
ZOOMINFO_URL = "https://api.zoominfo.com/search/contact"


@dataclass
class Contact:
    name: str
    title: str
    email: Optional[str] = None
    linkedin_url: Optional[str] = None
    hook: str = ""

    def as_markdown_bullet(self) -> str:
        parts = [f"- **{self.name}** — {self.title}"]
        if self.hook:
            parts.append(f"  - {self.hook}")
        parts.append(f"  - Email: {self.email or '(not available)'}")
        parts.append(f"  - LinkedIn: {self.linkedin_url or '(unconfirmed)'}")
        return "\n".join(parts)


class Targeter:
    """Finds 2-3 ranked decision makers at a target company."""

    def __init__(self, api_key: Optional[str] = None, model: str = TARGETER_MODEL):
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key."
            )
        self.model = model
        self.zoominfo_key = os.environ.get("ZOOMINFO_API_KEY") or None
        self.apollo_key = os.environ.get("APOLLO_API_KEY") or None
        self.tavily_key = os.environ.get("TAVILY_API_KEY") or None

    # ---- public API ---------------------------------------------------------

    def find_contacts(self, company_name: str, brief: str) -> list[Contact]:
        """Return 2-3 ranked decision-maker contacts for `company_name`.

        Returns an empty list if no candidates are found or ranking fails.
        """
        candidates = self._enrich(company_name)
        if not candidates:
            print(f"  [warn] no targeter candidates found for {company_name}")
            return []
        return self._rank(candidates, brief)

    # ---- enrichment dispatch ------------------------------------------------

    def _enrich(self, company: str) -> list[Contact]:
        if self.zoominfo_key:
            print("  enriching contacts via ZoomInfo")
            return self._enrich_via_zoominfo(company)
        if self.apollo_key:
            print("  enriching contacts via Apollo")
            return self._enrich_via_apollo(company)
        print("  enriching contacts via search (LinkedIn URLs only, no emails)")
        return self._enrich_via_search(company)

    def _enrich_via_zoominfo(self, company: str) -> list[Contact]:
        # ZoomInfo is OAuth-gated and enterprise-priced. This integration is
        # scaffolded to the REST contract but not end-to-end verified.
        try:
            resp = requests.post(
                ZOOMINFO_URL,
                headers={"Authorization": f"Bearer {self.zoominfo_key}"},
                json={
                    "companyName": company,
                    "jobTitle": "VP OR Director OR CTO OR CIO",
                    "rpp": 10,
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            print(f"  [warn] ZoomInfo lookup failed: {exc}")
            return []
        return [
            Contact(
                name=f"{p.get('firstName', '')} {p.get('lastName', '')}".strip(),
                title=p.get("jobTitle", ""),
                email=p.get("email") or None,
                linkedin_url=p.get("linkedInUrl") or None,
            )
            for p in data.get("data", [])
            if p.get("firstName") or p.get("lastName")
        ]

    def _enrich_via_apollo(self, company: str) -> list[Contact]:
        try:
            resp = requests.post(
                APOLLO_URL,
                headers={
                    "X-Api-Key": self.apollo_key,
                    "Content-Type": "application/json",
                },
                json={
                    "q_organization_name": company,
                    "person_titles": [
                        "VP of IT",
                        "VP of Infrastructure",
                        "VP of Technology",
                        "Director of Network",
                        "Director of IT",
                        "CTO",
                        "CIO",
                    ],
                    "per_page": 10,
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            print(f"  [warn] Apollo lookup failed: {exc}")
            return []
        return [
            Contact(
                name=(p.get("name") or "").strip(),
                title=p.get("title", ""),
                email=p.get("email") or None,
                linkedin_url=p.get("linkedin_url") or None,
            )
            for p in data.get("people", [])
            if p.get("name")
        ]

    def _enrich_via_search(self, company: str) -> list[Contact]:
        """Search fallback: LinkedIn URLs only, no emails. Uses Tavily if
        a key is set (cleaner results), otherwise DDG."""
        queries = [
            f'site:linkedin.com/in "{company}" VP IT OR VP Infrastructure OR VP Technology',
            f'site:linkedin.com/in "{company}" Director IT OR Director Network',
            f'site:linkedin.com/in "{company}" CIO OR CTO',
        ]
        raw_results: list[SearchResult] = []
        for q in queries:
            if self.tavily_key:
                raw_results.extend(_search_tavily(q, 5, self.tavily_key))
            else:
                raw_results.extend(_search_ddg(q, 5))

        contacts: list[Contact] = []
        seen_urls: set[str] = set()
        for r in raw_results:
            if not r.url or "linkedin.com/in/" not in r.url:
                continue
            if r.url in seen_urls:
                continue
            seen_urls.add(r.url)
            name, title = _parse_linkedin_title(r.title)
            if not name:
                continue
            contacts.append(
                Contact(name=name, title=title, email=None, linkedin_url=r.url)
            )
        return contacts

    # ---- LLM ranking --------------------------------------------------------

    def _rank(self, candidates: list[Contact], brief: str) -> list[Contact]:
        """Ask the model to pick the top 2-3 and write a hook each."""
        candidate_json = json.dumps([asdict(c) for c in candidates], indent=2)
        user_message = (
            f"RESEARCH BRIEF:\n\n{brief}\n\n"
            f"CANDIDATE CONTACTS ({len(candidates)} found from enrichment):\n\n"
            f"{candidate_json}\n\n"
            f"Return JSON only. Pick 2-3 contacts ranked by persona priority, "
            f"with a one-sentence hook drawn from the brief for each."
        )
        raw = self._chat(TARGETER_PROMPT, user_message, TARGETER_MAX_TOKENS)
        try:
            parsed = _parse_json_from_llm(raw)
        except Exception as exc:
            print(f"  [warn] targeter ranking failed to parse JSON: {exc}")
            # Degrade gracefully: return the top-N raw candidates unranked.
            return candidates[:3]
        return [
            Contact(
                name=c.get("name", ""),
                title=c.get("title", ""),
                email=(c.get("email") or None),
                linkedin_url=(c.get("linkedin_url") or None),
                hook=c.get("hook", ""),
            )
            for c in parsed.get("contacts", [])
            if c.get("name")
        ]

    # ---- OpenRouter call ----------------------------------------------------

    def _chat(self, system: str, user: str, max_tokens: int) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
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
        return resp.json()["choices"][0]["message"]["content"].strip()


def _parse_linkedin_title(title: str) -> tuple[str, str]:
    """Best-effort parse of LinkedIn SERP titles. Handles the common shapes:

        'Name - Title - Company | LinkedIn'
        'Name | LinkedIn'
        'Name - Title at Company'

    Returns (name, title); either may be '' if nothing parses cleanly.
    """
    cleaned = title.strip()
    if "|" in cleaned:
        cleaned = cleaned.split("|", 1)[0].strip()
    parts = [p.strip() for p in cleaned.split(" - ")]
    if len(parts) >= 2:
        return parts[0], parts[1]
    if " at " in cleaned:
        name_part, rest = cleaned.split(" at ", 1)
        return name_part.strip(), rest.strip()
    return (parts[0] if parts else ""), ""


def _parse_json_from_llm(raw: str) -> dict:
    """Extract the first JSON object from an LLM response. Tolerates code
    fences and leading/trailing prose."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"no JSON object in response: {raw[:200]!r}")
    return json.loads(raw[start : end + 1])
