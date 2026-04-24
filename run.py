"""Signal Advisory prospecting pipeline — CLI entrypoint.

    python run.py --accounts accounts/sample.csv

For each row in the input CSV, runs the Researcher, then the Drafter, and
writes the combined brief + drafts to output/{date}/{slug}.md. Every run
appends a row to output/run_log.csv.

Each account is processed independently; one failure does not stop the rest.
"""

from __future__ import annotations

import csv
import re
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import typer
from dotenv import load_dotenv

from agents.drafter import Drafter
from agents.researcher import Researcher
from agents.targeter import Contact, Targeter

app = typer.Typer(add_completion=False, help="Signal Advisory prospecting pipeline.")

RUN_LOG_HEADERS = ["timestamp", "company", "status", "output_path", "error"]


@app.command()
def main(
    accounts: Path = typer.Option(
        ...,
        "--accounts",
        "-a",
        exists=True,
        file_okay=True,
        dir_okay=False,
        readable=True,
        help="CSV with columns: company_name, contact_name (optional), notes (optional).",
    ),
    output_dir: Path = typer.Option(
        Path("output"),
        "--output-dir",
        "-o",
        help="Root folder for generated briefs. Defaults to ./output.",
    ),
):
    """Run the Researcher + Drafter pipeline over an accounts CSV."""
    load_dotenv()

    researcher = Researcher()
    targeter = Targeter()
    drafter = Drafter()

    rows = _read_accounts(accounts)
    if not rows:
        typer.echo(f"No account rows found in {accounts}.", err=True)
        raise typer.Exit(code=1)

    date_folder = output_dir / datetime.now().strftime("%Y-%m-%d")
    date_folder.mkdir(parents=True, exist_ok=True)
    run_log_path = output_dir / "run_log.csv"

    typer.echo(f"Processing {len(rows)} account(s) into {date_folder}/")
    for row in rows:
        company = row["company_name"]
        typer.echo(f"\n→ {company}")
        status, out_path, err = _process_account(
            company=company,
            contact_name=row.get("contact_name") or None,
            notes=row.get("notes") or None,
            researcher=researcher,
            targeter=targeter,
            drafter=drafter,
            date_folder=date_folder,
        )
        _append_run_log(
            run_log_path,
            company=company,
            status=status,
            output_path=str(out_path) if out_path else "",
            error=err,
        )
        marker = "ok" if status == "ok" else "FAILED"
        typer.echo(f"  [{marker}] {out_path if out_path else err}")

    typer.echo(f"\nRun log: {run_log_path}")


# ---- per-account work -------------------------------------------------------


def _process_account(
    company: str,
    contact_name: Optional[str],
    notes: Optional[str],
    researcher: Researcher,
    targeter: Targeter,
    drafter: Drafter,
    date_folder: Path,
) -> tuple[str, Optional[Path], str]:
    """Run one account end-to-end. Returns (status, output_path, error_message)."""
    try:
        typer.echo("  researching…")
        brief = researcher.research(company, contact_name=contact_name, notes=notes)

        typer.echo("  targeting…")
        contacts = targeter.find_contacts(company, brief)

        # The Drafter gets the highest-ranked contact's name so it can write
        # personalized openers. If the CSV already specified a contact, that
        # takes precedence — the operator knows the account better than the
        # model does.
        primary_name = contact_name or (contacts[0].name if contacts else None)

        typer.echo("  drafting…")
        drafts = drafter.draft(brief, company_name=company, contact_name=primary_name)

        out_path = date_folder / f"{_slugify(company)}.md"
        out_path.write_text(
            _render_account_markdown(
                company=company,
                contact_name=contact_name,
                notes=notes,
                brief=brief,
                contacts=contacts,
                drafts=drafts,
            ),
            encoding="utf-8",
        )
        return "ok", out_path, ""
    except Exception as exc:
        # Keep the run going even if one account blows up. Record the error.
        traceback.print_exc(file=sys.stderr)
        return "error", None, f"{type(exc).__name__}: {exc}"


def _render_account_markdown(
    company: str,
    contact_name: Optional[str],
    notes: Optional[str],
    brief: str,
    contacts: list[Contact],
    drafts: str,
) -> str:
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


# ---- helpers ----------------------------------------------------------------


def _read_accounts(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = []
        for raw in reader:
            company = (raw.get("company_name") or "").strip()
            if not company:
                continue
            rows.append(
                {
                    "company_name": company,
                    "contact_name": (raw.get("contact_name") or "").strip(),
                    "notes": (raw.get("notes") or "").strip(),
                }
            )
        return rows


def _append_run_log(
    path: Path,
    company: str,
    status: str,
    output_path: str,
    error: str,
) -> None:
    new_file = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_file:
            writer.writerow(RUN_LOG_HEADERS)
        writer.writerow(
            [
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
                company,
                status,
                output_path,
                error,
            ]
        )


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    return _SLUG_RE.sub("-", value.lower()).strip("-") or "company"


if __name__ == "__main__":
    app()
