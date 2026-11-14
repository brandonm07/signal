"""Smoke test: prompts load and both agents instantiate.

Does not hit the network. Sets a dummy OPENROUTER_API_KEY so the agents'
constructors pass their env check.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _fake_api_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")


def test_prompts_load_with_expected_shape():
    from config.prompts import (
        DRAFTER_MAX_TOKENS,
        DRAFTER_MODEL,
        DRAFTER_PROMPT,
        RESEARCHER_MAX_TOKENS,
        RESEARCHER_MODEL,
        RESEARCHER_PROMPT,
        TARGETER_MAX_TOKENS,
        TARGETER_MODEL,
        TARGETER_PROMPT,
    )

    # Prompts are non-empty strings.
    assert isinstance(RESEARCHER_PROMPT, str) and len(RESEARCHER_PROMPT) > 500
    assert isinstance(DRAFTER_PROMPT, str) and len(DRAFTER_PROMPT) > 500
    assert isinstance(TARGETER_PROMPT, str) and len(TARGETER_PROMPT) > 500

    # Model slugs look like OpenRouter ids (provider/model).
    assert "/" in RESEARCHER_MODEL
    assert "/" in DRAFTER_MODEL
    assert "/" in TARGETER_MODEL

    # Token caps are the hardcoded values we agreed on.
    assert RESEARCHER_MAX_TOKENS == 2000
    assert DRAFTER_MAX_TOKENS == 800
    assert TARGETER_MAX_TOKENS == 1500


def test_agents_instantiate():
    from agents.drafter import Drafter
    from agents.researcher import Researcher
    from agents.targeter import Targeter

    r = Researcher()
    t = Targeter()
    d = Drafter()

    assert r.api_key == "test-key-not-real"
    assert t.api_key == "test-key-not-real"
    assert d.api_key == "test-key-not-real"
    assert r.model and t.model and d.model


def test_agents_raise_without_api_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    from agents.drafter import Drafter
    from agents.researcher import Researcher
    from agents.targeter import Targeter

    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        Researcher()
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        Targeter()
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        Drafter()


def test_targeter_helpers():
    """LinkedIn title parsing + LLM JSON extraction — pure logic, no network."""
    from agents.targeter import _parse_json_from_llm, _parse_linkedin_title

    name, title = _parse_linkedin_title("Jane Smith - VP of IT - Acme | LinkedIn")
    assert name == "Jane Smith"
    assert title == "VP of IT"

    # Tolerates prose wrapping the JSON.
    parsed = _parse_json_from_llm('Here you go:\n{"contacts": []}\nDone.')
    assert parsed == {"contacts": []}
