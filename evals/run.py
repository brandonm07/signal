"""Eval runner.

Two modes:

  Grade existing briefs (zero API cost):
      python -m evals.run --dir output/2026-04-23/

  Generate + grade against a target list (spends API credit):
      python -m evals.run --companies "Barry-Wehmiller,Hunter Engineering"

Prints a per-brief scorecard. Exit code is 1 if any check fails, so this
fits into a CI pipeline if you ever want one.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import typer
from dotenv import load_dotenv

from evals.checks import CheckResult, grade

app = typer.Typer(add_completion=False, help="Brief eval harness.")


@app.command()
def main(
    dir: Optional[Path] = typer.Option(
        None,
        "--dir",
        "-d",
        exists=True,
        file_okay=False,
        dir_okay=True,
        help="Grade every .md brief in this directory.",
    ),
    companies: Optional[str] = typer.Option(
        None,
        "--companies",
        "-c",
        help="Comma-separated company names. Generates fresh briefs first, "
        "then grades them. SPENDS OPENROUTER CREDIT.",
    ),
    output_dir: Path = typer.Option(
        Path("output/evals"),
        "--output-dir",
        "-o",
        help="Where to write generated briefs (only used with --companies).",
    ),
):
    """Grade briefs against the project's quality checklist."""
    if not dir and not companies:
        typer.echo("Pass --dir <folder> to grade existing briefs, or --companies <list> to generate.", err=True)
        raise typer.Exit(code=1)

    briefs: list[tuple[str, str]] = []  # (label, content)

    if dir:
        for md_file in sorted(dir.glob("*.md")):
            briefs.append((md_file.name, md_file.read_text(encoding="utf-8")))
    else:
        briefs = _generate_briefs(companies, output_dir)

    if not briefs:
        typer.echo("No briefs to grade.", err=True)
        raise typer.Exit(code=1)

    overall_pass = True
    for label, content in briefs:
        results = grade(content)
        passed = sum(1 for r in results if r.passed)
        total = len(results)
        marker = "✓" if passed == total else "✗"
        typer.echo(f"\n{marker} {label} — {passed}/{total} checks passed")
        for r in results:
            sub = "  ✓" if r.passed else "  ✗"
            typer.echo(f"{sub} {r.name}: {r.message}")
        if passed < total:
            overall_pass = False

    typer.echo("")
    if overall_pass:
        typer.echo("All briefs passed all checks.")
        raise typer.Exit(code=0)
    typer.echo("One or more checks failed. See above.")
    raise typer.Exit(code=1)


def _generate_briefs(companies_csv: str, output_dir: Path) -> list[tuple[str, str]]:
    """Run the pipeline against a comma-separated company list and grade
    the resulting briefs. Imports kept lazy so --dir mode doesn't pay the
    cost of loading the whole agent stack."""
    from datetime import datetime

    from agents.drafter import Drafter
    from agents.memory import Memory
    from agents.researcher import Researcher
    from agents.targeter import Targeter

    # Imported here so we get the same render path the CLI uses.
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from run import _process_account  # type: ignore

    load_dotenv()

    researcher = Researcher()
    targeter = Targeter()
    drafter = Drafter()
    memory = Memory(db_path=output_dir / "memory.db")

    date_folder = output_dir / datetime.now().strftime("%Y-%m-%d")
    date_folder.mkdir(parents=True, exist_ok=True)

    out: list[tuple[str, str]] = []
    for company in [c.strip() for c in companies_csv.split(",") if c.strip()]:
        typer.echo(f"\n→ {company}")
        status, path, err = _process_account(
            company=company,
            contact_name=None,
            notes=None,
            researcher=researcher,
            targeter=targeter,
            drafter=drafter,
            memory=memory,
            date_folder=date_folder,
            refresh=True,  # eval runs are always fresh, no cache shortcuts
            cache_days=30,
        )
        if status in ("ok", "cached") and path:
            out.append((path.name, path.read_text(encoding="utf-8")))
        else:
            typer.echo(f"  generation failed: {err}", err=True)
    return out


if __name__ == "__main__":
    app()
