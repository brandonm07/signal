"""Checklist-based brief grader.

Each check is a callable that takes the brief markdown string and returns
(passed: bool, message: str). Aggregating them gives a per-brief scorecard
so prompt tweaks can be measured instead of guessed.

These are heuristics, not perfect signals — they catch the most common
regressions (missing sections, hallucinated contacts, banned phrases) at
zero API cost.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

REQUIRED_SECTIONS = (
    "## Company Snapshot",
    "## Why Now",
    "## Likely Stack and Suspected Pain",
    "## Who to Talk To",
    "## Opening Angle",
    "## Sources",
)

BANNED_PHRASES = (
    "in today's fast-paced",
    "in today's fast paced",
    "i hope this finds you well",
    "leverage",
    "synergize",
    "circle back",
    "unlock value",
    "best-in-class",
)

URL_RE = re.compile(r"https?://\S+")


@dataclass
class CheckResult:
    name: str
    passed: bool
    message: str


def check_required_sections(brief: str) -> CheckResult:
    missing = [s for s in REQUIRED_SECTIONS if s not in brief]
    if missing:
        return CheckResult(
            "required_sections", False, f"missing: {', '.join(missing)}"
        )
    return CheckResult("required_sections", True, "all 6 sections present")


def check_sources_has_urls(brief: str) -> CheckResult:
    section = _extract_section(brief, "## Sources")
    if section is None:
        return CheckResult("sources_has_urls", False, "no Sources section found")
    urls = URL_RE.findall(section)
    if len(urls) < 3:
        return CheckResult(
            "sources_has_urls", False, f"only {len(urls)} URL(s) in Sources"
        )
    return CheckResult("sources_has_urls", True, f"{len(urls)} URLs cited")


def check_contacts_have_sources(brief: str) -> CheckResult:
    """Every named contact line in 'Who to Talk To' should have a URL or
    'unconfirmed' marker. This mirrors the runtime sanity check."""
    section = _extract_section(brief, "## Who to Talk To")
    if section is None:
        return CheckResult(
            "contacts_have_sources", False, "no Who to Talk To section"
        )
    title_words = ("CIO", "CTO", "CFO", "CEO", "COO", "VP", "Director", "Head of")
    flagged = []
    for line in section.splitlines():
        s = line.strip()
        if not s.startswith(("-", "*")):
            continue
        if "unconfirmed" in s.lower() or URL_RE.search(s):
            continue
        if any(w in s for w in title_words):
            flagged.append(s[:80])
    if flagged:
        return CheckResult(
            "contacts_have_sources",
            False,
            f"{len(flagged)} contact(s) with no source URL",
        )
    return CheckResult("contacts_have_sources", True, "all contacts cited")


def check_no_banned_phrases(brief: str) -> CheckResult:
    text = brief.lower()
    hits = [p for p in BANNED_PHRASES if p in text]
    if hits:
        return CheckResult(
            "no_banned_phrases", False, f"found: {', '.join(hits)}"
        )
    return CheckResult("no_banned_phrases", True, "clean")


def check_word_count(brief: str, min_words: int = 300, max_words: int = 3000) -> CheckResult:
    n = len(brief.split())
    if n < min_words:
        return CheckResult("word_count", False, f"too short: {n} words")
    if n > max_words:
        return CheckResult("word_count", False, f"too long: {n} words")
    return CheckResult("word_count", True, f"{n} words")


def check_drafter_outputs_present(brief: str) -> CheckResult:
    """Brief file includes the three draft variants from the Drafter."""
    needles = [
        ("first touch email", "email"),
        ("linkedin", "linkedin"),
        ("voicemail", "voicemail"),
    ]
    text = brief.lower()
    missing = [label for needle, label in needles if needle not in text]
    if missing:
        return CheckResult(
            "drafter_outputs", False, f"missing: {', '.join(missing)}"
        )
    return CheckResult("drafter_outputs", True, "all 3 drafts present")


ALL_CHECKS: tuple[Callable[[str], CheckResult], ...] = (
    check_required_sections,
    check_sources_has_urls,
    check_contacts_have_sources,
    check_no_banned_phrases,
    check_word_count,
    check_drafter_outputs_present,
)


def grade(brief: str) -> list[CheckResult]:
    return [check(brief) for check in ALL_CHECKS]


# ---- helpers ---------------------------------------------------------------


def _extract_section(brief: str, heading: str) -> str | None:
    """Return the text between `heading` and the next ## heading (or EOF)."""
    if heading not in brief:
        return None
    after = brief.split(heading, 1)[1]
    # Stop at the next H2 heading
    next_h2 = re.search(r"\n## ", after)
    return after[: next_h2.start()] if next_h2 else after
