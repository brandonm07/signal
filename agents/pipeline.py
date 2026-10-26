"""Pipeline orchestration shared between the CLI (run.py) and the
Streamlit dashboard (app.py).

One function — `run_brief` — takes a company name and runs the full
Researcher → Targeter → Drafter chain, with cache-aware short-circuiting
and a status callback so callers can render progress however they like
(typer.echo for the CLI, st.status for Streamlit).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from agents.drafter import Drafter
from agents.memory import Memory
from agents.researcher import Researcher
from agents.targeter import Contact, Targeter

StatusCallback = Callable[[str], None]


@dataclass
class PipelineResult:
    company: str
    status: str  # "ok" | "cached" | "error"
    brief_path: Optional[Path]
    content: str  # full rendered markdown (brief + contacts + drafts)
    error: str = ""


def run_brief(
    company: str,
    contact_name: Optional[str],
    notes: Optional[str],
    researcher: Researcher,
    targeter: Targeter,
    drafter: Drafter,
    memory: Memory,
    output_dir: Path,
    refresh: bool = False,
    cache_days: int = 30,
    on_status: StatusCallback = lambda _msg: None,
) -> PipelineResult:
    """Run the full pipeline for one company. Never raises — failures are
    captured in the returned PipelineResult.status / .error fields."""

    if not refresh:
        cached = memory.find_recent(company, max_age_days=cache_days)
        if cached:
            on_status("cached")
            return PipelineResult(
                company=company,
                status="cached",
                brief_path=cached.brief_path,
                content=cached.brief_path.read_text(encoding="utf-8"),
            )

    try:
        on_status("researching")
        brief = researcher.research(
            company, contact_name=contact_name, notes=notes
        )

        on_status("targeting")
        contacts = targeter.find_contacts(company, brief)

        # Drafter prefers the operator-supplied contact (CSV / form input);
        # falls back to the highest-ranked contact from the Targeter.
        primary_name = contact_name or (contacts[0].name if contacts else None)

        on_status("drafting")
        drafts = drafter.draft(
            brief, company_name=company, contact_name=primary_name
        )

        date_folder = output_dir / datetime.now().strftime("%Y-%m-%d")
        date_folder.mkdir(parents=True, exist_ok=True)
        out_path = date_folder / f"{_slugify(company)}.md"

        content = render_account_markdown(
            company=company,
            contact_name=contact_name,
            notes=notes,
            brief=brief,
            contacts=contacts,
            drafts=drafts,
        )
        out_path.write_text(content, encoding="utf-8")

        memory.record(
            company=company,
            status="ok",
            brief_path=out_path,
            notes=notes,
            contact_name=primary_name,
        )
        on_status("done")
        return PipelineResult(
            company=company, status="ok", brief_path=out_path, content=content
        )
    except Exception as exc:
        memory.record(
            company=company, status="error", notes=notes, contact_name=contact_name
        )
        return PipelineResult(
            company=company,
            status="error",
            brief_path=None,
            content="",
            error=f"{type(exc).__name__}: {exc}",
        )


def render_account_markdown(
    company: str,
    contact_name: Optional[str],
    notes: Optional[str],
    brief: str,
    contacts: list[Contact],
    drafts: str,
) -> str:
    """Render the full account markdown — brief + decision makers + drafts.

    Sections are separated by `---` HRs and H1 headings so the dashboard
    can split into tabs without coupling to the model output's structure.
    """
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    header_lines = [f"# {company}", "", f"_Generated {generated_at}_", ""]
    if contact_name:
        header_lines.append(f"**Contact:** {contact_name}")
    if notes:
        header_lines.append(f"**Sales notes:** {notes}")
    if contact_name or notes:
        header_lines.append("")
    header = "\n".join(header_lines)

    if contacts:
        contacts_md = "\n\n".join(c.as_markdown_bullet() for c in contacts)
    else:
        contacts_md = "_No decision makers identified._"

    return (
        f"{header}\n"
        f"---\n\n"
        f"# Research Brief\n\n"
        f"{brief}\n\n"
        f"---\n\n"
        f"# Decision Makers\n\n"
        f"{contacts_md}\n\n"
        f"---\n\n"
        f"# Outreach Drafts\n\n"
        f"{drafts}\n"
    )


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    return _SLUG_RE.sub("-", value.lower()).strip("-") or "company"
