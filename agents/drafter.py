"""Drafter agent.

Takes a research brief and returns three outreach variants in Brandon's voice:
email, LinkedIn message, voicemail script. One OpenRouter call per account.

Each agent file keeps its own small _chat helper so the file is readable on
its own without cross-referencing.
"""

from __future__ import annotations

import os
from typing import Optional

import requests

from config.prompts import DRAFTER_MAX_TOKENS, DRAFTER_MODEL, DRAFTER_PROMPT

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class Drafter:
    """Writes the three outreach drafts from a research brief."""

    def __init__(self, api_key: Optional[str] = None, model: str = DRAFTER_MODEL):
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key."
            )
        self.model = model

    # ---- public API ---------------------------------------------------------

    def draft(
        self,
        brief: str,
        company_name: str,
        contact_name: Optional[str] = None,
    ) -> str:
        """Return a markdown block containing all three outreach variants."""
        user_message = _build_user_message(
            brief=brief,
            company_name=company_name,
            contact_name=contact_name,
        )
        return self._chat(
            system=DRAFTER_PROMPT,
            user=user_message,
            max_tokens=DRAFTER_MAX_TOKENS,
        )

    # ---- internals ----------------------------------------------------------

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
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()


def _build_user_message(
    brief: str,
    company_name: str,
    contact_name: Optional[str],
) -> str:
    contact_line = (
        f"Primary contact: {contact_name}"
        if contact_name
        else "No specific contact named. Address to the most relevant decision maker from the brief."
    )
    return (
        f"Target company: {company_name}\n"
        f"{contact_line}\n\n"
        f"Research brief:\n\n"
        f"{brief}\n\n"
        f"Produce the three outreach variants now, labeled clearly."
    )
