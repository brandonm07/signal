"""Drafter agent.

Takes a research brief and returns three outreach variants in Brandon's voice:
email, LinkedIn message, voicemail script. One OpenRouter call per account.
"""

from __future__ import annotations

import os
from typing import Optional

from agents.openrouter import chat_completion
from config.prompts import DRAFTER_MAX_TOKENS, DRAFTER_MODEL, DRAFTER_PROMPT


class Drafter:
    """Writes the three outreach drafts from a research brief."""

    def __init__(self, api_key: Optional[str] = None, model: str = DRAFTER_MODEL):
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key."
            )
        self.model = model

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
        return chat_completion(
            self.api_key, self.model, DRAFTER_PROMPT, user_message, DRAFTER_MAX_TOKENS
        )


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
