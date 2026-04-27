"""Signal Advisory prospecting pipeline — CLI entrypoint.

    python run.py --accounts accounts/sample.csv
    python run.py --company "Acme Corp"

For each row in the input CSV (or each --company invocation), runs the
Researcher → Targeter → Drafter chain via agents/pipeline.run_brief.
"""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import typer
from dotenv import load_dotenv

from agents.drafter import Drafter
from agents.memory import Memory
from agents.pipeline import run_brief
from agents.researcher import Researcher
from agents.targeter import Targeter

app = typer.Typer(add_completion=False, help="Signal Advisory prospecting pipeline.")

RUN_LOG_HEADERS = ["timestamp", "company", "status", "output_path", "error"]


@app.command()
def main(
    accounts: Optional[Path] = typer.Option(
        None,
        "--accounts",
        "-a",
        exists=True,
        file_okay=True,
        dir_okay=False,
        readable=True,
        help="CSV with columns: company_name, contact_name (optional), notes (optional).",
    ),
    company: Optional[str] = typer.Option(
        None,
        "--company",
        "-c",
        help="Single-company ad-hoc mode. Use instead of --accounts when you "
        "only need one brief on demand.",
    ),
    contact: Optional[str] = typer.Option(
        None,
        "--contact",
        help="Optional named contact for single-company mode.",
    ),
    notes: Optional[str] = typer.Option(
        None,
        "--notes",
        help="Optional sales notes for single-company mode.",
    ),
    output_dir: Path = typer.Option(
        Path("output"),
        "--output-dir",
        "-o",
        help="Root folder for generated briefs. Defaults to ./output.",
    ),
    refresh: bool = typer.Option(
        False,
        "--refresh",
        help="Ignore cached briefs in memory and re-run from scratch.",
    ),
    cache_days: int = typer.Option(
        30,
        "--cache-days",
        help="How recent a cached brief must be to be reused. Default 30 days.",
    ),
):
    """Run the Researcher + Targeter + Drafter pipeline.

    Two modes:

      Batch:   python run.py --accounts accounts/sample.csv
      Ad-hoc:  python run.py --company "Acme Corp" --notes "Met at SXSW"
    """
    if accounts and company:
        typer.echo("Pass --accounts OR --company, not both.", err=True)
        raise typer.Exit(code=1)
    if not accounts and not company:
        typer.echo(
            "Pass --accounts <csv> for batch mode, or --company <name> for one-off.",
            err=True,
        )
        raise typer.Exit(code=1)

    load_dotenv()

    researcher = Researcher()
    targeter = Targeter()
    drafter = Drafter()
    memory = Memory(db_path=output_dir / "memory.db")

    if accounts:
        rows = _read_accounts(accounts)
        if not rows:
            typer.echo(f"No account rows found in {accounts}.", err=True)
            raise typer.Exit(code=1)
    else:
        rows = [
            {
                "company_name": company.strip(),
                "contact_name": (contact or "").strip(),
                "notes": (notes or "").strip(),
            }
        ]

    date_folder = output_dir / datetime.now().strftime("%Y-%m-%d")
    date_folder.mkdir(parents=True, exist_ok=True)
    run_log_path = output_dir / "run_log.csv"

    typer.echo(f"Processing {len(rows)} account(s) into {date_folder}/")
    for row in rows:
        company = row["company_name"]
        typer.echo(f"\n→ {company}")
        result = run_brief(
            company=company,
            contact_name=row.get("contact_name") or None,
            notes=row.get("notes") or None,
            researcher=researcher,
            targeter=targeter,
            drafter=drafter,
            memory=memory,
            output_dir=output_dir,
            refresh=refresh,
            cache_days=cache_days,
            on_status=_print_status,
        )
        _append_run_log(
            run_log_path,
            company=company,
            status=result.status,
            output_path=str(result.brief_path) if result.brief_path else "",
            error=result.error,
        )
        if result.status == "error":
            typer.echo(f"  [FAILED] {result.error}", err=True)
        else:
            typer.echo(f"  [{result.status}] {result.brief_path}")

    typer.echo(f"\nRun log: {run_log_path}")


def _print_status(msg: str) -> None:
    """Map the pipeline's terse status codes to the existing CLI vocabulary."""
    labels = {
        "cached": "  [cache] using cached brief",
        "researching": "  researching…",
        "targeting": "  targeting…",
        "drafting": "  drafting…",
        "done": "",
    }
    text = labels.get(msg, msg)
    if text:
        typer.echo(text)


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


if __name__ == "__main__":
    app()
