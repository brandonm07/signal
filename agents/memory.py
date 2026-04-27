"""Memory layer: SQLite-backed cache + audit log for generated briefs.

Why: re-running on the same company within a short window should not
re-burn OpenRouter credit. Also gives us a row-per-brief audit trail of
when, what, and what it cost — handy for the eval harness and for
spotting regressions over time.

Schema is intentionally tiny — one table, no migrations needed.
"""

from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional

DEFAULT_DB_PATH = Path("output/memory.db")
DEFAULT_MAX_AGE_DAYS = 30


@dataclass
class CachedBrief:
    company: str
    generated_at: datetime
    brief_path: Path
    notes: Optional[str] = None
    contact_name: Optional[str] = None


class Memory:
    """Tiny SQLite wrapper. One brief per row. Lookup by normalized name."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS briefs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    company TEXT NOT NULL,
                    normalized TEXT NOT NULL,
                    generated_at TEXT NOT NULL,
                    brief_path TEXT,
                    status TEXT NOT NULL,
                    notes TEXT,
                    contact_name TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_briefs_normalized
                    ON briefs(normalized, generated_at DESC);
                """
            )

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ---- writes -------------------------------------------------------------

    def record(
        self,
        company: str,
        status: str,
        brief_path: Optional[Path] = None,
        notes: Optional[str] = None,
        contact_name: Optional[str] = None,
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO briefs (company, normalized, generated_at, brief_path,
                                    status, notes, contact_name)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    company,
                    _normalize(company),
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    str(brief_path) if brief_path else None,
                    status,
                    notes,
                    contact_name,
                ),
            )

    # ---- reads --------------------------------------------------------------

    def find_recent(
        self,
        company: str,
        max_age_days: int = DEFAULT_MAX_AGE_DAYS,
    ) -> Optional[CachedBrief]:
        """Return the most recent successful brief for `company` within the
        max_age window, or None if not found / too old / file missing."""
        cutoff = (
            datetime.now(timezone.utc) - timedelta(days=max_age_days)
        ).isoformat(timespec="seconds")
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT company, generated_at, brief_path, notes, contact_name
                FROM briefs
                WHERE normalized = ? AND status = 'ok' AND generated_at >= ?
                ORDER BY generated_at DESC
                LIMIT 1
                """,
                (_normalize(company), cutoff),
            ).fetchone()
        if not row or not row["brief_path"]:
            return None
        path = Path(row["brief_path"])
        if not path.exists():
            return None
        return CachedBrief(
            company=row["company"],
            generated_at=datetime.fromisoformat(row["generated_at"]),
            brief_path=path,
            notes=row["notes"],
            contact_name=row["contact_name"],
        )


_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")


def _normalize(company: str) -> str:
    """Lower + strip non-alphanumerics so 'Barry-Wehmiller' == 'barry wehmiller'."""
    return _NORMALIZE_RE.sub("", company.lower())
