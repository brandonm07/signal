"""Additional research data sources beyond web search.

Both no-key, public APIs:
- Wikipedia REST: company summary + URL. Stable structured prose, great
  for the Researcher's "company snapshot" section.
- SEC EDGAR full-text search: recent filings (10-K, 10-Q, 8-K) for
  public companies. Surfaces leadership changes, earnings commentary,
  contracts — exactly the "Why Now" signals we want.

Each helper returns a markdown block ready to splice into the user
message, or empty string if nothing useful was found. Failures never
crash the pipeline; they just return an empty block.
"""

from __future__ import annotations

from typing import Optional

import requests

WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
SEC_EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index"

# Wikimedia and SEC both require a descriptive User-Agent identifying the
# requester. The contact info satisfies their fair-use policies.
USER_AGENT = (
    "Signal-Advisory/0.1 (+https://github.com/brandonm07/signal; "
    "contact@signaladvisory.com)"
)
WIKIPEDIA_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}
SEC_HEADERS = {"User-Agent": USER_AGENT}


def fetch_wikipedia_summary(company: str, timeout: int = 15) -> str:
    """Return a markdown block with the company's Wikipedia summary, or ''."""
    title = company.replace(" ", "_")
    try:
        resp = requests.get(
            WIKIPEDIA_SUMMARY_URL.format(title=title),
            headers=WIKIPEDIA_HEADERS,
            timeout=timeout,
        )
    except Exception as exc:
        print(f"  [warn] Wikipedia fetch failed: {exc}")
        return ""
    if resp.status_code == 404:
        # Page doesn't exist — silent miss, common for private companies.
        return ""
    if resp.status_code >= 400:
        print(f"  [warn] Wikipedia {resp.status_code}: {resp.text[:200]}")
        return ""
    try:
        data = resp.json()
    except Exception:
        return ""
    extract = (data.get("extract") or "").strip()
    if not extract:
        return ""
    page_url = data.get("content_urls", {}).get("desktop", {}).get("page", "")
    description = (data.get("description") or "").strip()
    parts = [f"### Wikipedia: {data.get('title', company)}"]
    if description:
        parts.append(f"_{description}_")
    parts.append(extract)
    if page_url:
        parts.append(f"Source: {page_url}")
    return "\n\n".join(parts)


def fetch_sec_edgar_filings(
    company: str,
    forms: tuple[str, ...] = ("10-K", "10-Q", "8-K"),
    limit: int = 5,
    timeout: int = 15,
) -> str:
    """Return a markdown block with recent SEC filings for `company`, or ''.

    Public-companies-only signal. Private companies will return an empty
    block silently. Surfaces filing type, date, and accession URL — the
    Researcher then has direct citations for any earnings/leadership
    claim it makes.
    """
    try:
        resp = requests.get(
            SEC_EDGAR_SEARCH_URL,
            params={
                "q": f'"{company}"',
                "forms": ",".join(forms),
            },
            headers=SEC_HEADERS,
            timeout=timeout,
        )
    except Exception as exc:
        print(f"  [warn] SEC EDGAR fetch failed: {exc}")
        return ""
    if resp.status_code >= 400:
        print(f"  [warn] SEC EDGAR {resp.status_code}: {resp.text[:200]}")
        return ""
    try:
        hits = resp.json().get("hits", {}).get("hits", [])
    except Exception:
        return ""
    if not hits:
        return ""

    lines = ["### SEC EDGAR — recent filings"]
    for hit in hits[:limit]:
        src = hit.get("_source", {})
        form = src.get("form", "?")
        date = src.get("file_date", "?")
        # The accession number lets us build a direct URL to the filing.
        acc = (hit.get("_id") or "").split(":", 1)[0]
        cik = src.get("ciks", [""])[0]
        if cik and acc:
            acc_compact = acc.replace("-", "")
            url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_compact}/{acc}-index.htm"
        else:
            url = ""
        title = (src.get("display_names") or [company])[0]
        lines.append(f"- {form} ({date}) — {title}" + (f"  {url}" if url else ""))
    return "\n".join(lines)


def fetch_supplementary_sources(company: str) -> list[str]:
    """All non-search sources, returned as a list of markdown blocks.
    Empty blocks are filtered out so the user message stays clean."""
    blocks: list[Optional[str]] = [
        fetch_wikipedia_summary(company),
        fetch_sec_edgar_filings(company),
    ]
    return [b for b in blocks if b]
