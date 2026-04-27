"""Additional research data sources beyond web search.

Sources fall into two groups:

  No-key, public APIs:
  - Wikipedia REST: company summary + URL. Stable structured prose, great
    for the Researcher's "company snapshot" section.
  - SEC EDGAR full-text search: recent filings (10-K, 10-Q, 8-K) for
    public companies. Surfaces leadership changes, earnings commentary,
    contracts — exactly the "Why Now" signals we want.

  Paid APIs (scaffolded; activate by setting the env var):
  - Crunchbase: founders, funding rounds, employee count, HQ for funded
    private companies. Set CRUNCHBASE_API_KEY.
  - BuiltWith: detected technology stack on the company's website. Set
    BUILTWITH_API_KEY. We derive the domain heuristically from the
    company name; pass `domain=` explicitly when you have a better one.

Each helper returns a markdown block ready to splice into the user
message, or empty string if nothing useful was found. Failures never
crash the pipeline; they just return an empty block.
"""

from __future__ import annotations

import os
import re
from typing import Optional

import requests

WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
SEC_EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index"
CRUNCHBASE_ORG_URL = "https://api.crunchbase.com/api/v4/entities/organizations/{permalink}"
BUILTWITH_URL = "https://api.builtwith.com/v22/api.json"

# Wikimedia and SEC both require a descriptive User-Agent identifying the
# requester. The contact info satisfies their fair-use policies.
USER_AGENT = (
    "Signal-Advisory/0.1 (+https://github.com/brandonm07/signal; "
    "contact@signaladvisory.com)"
)
WIKIPEDIA_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}
SEC_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}


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
        # SEC sometimes serves an HTML block page even with a valid User-Agent
        # (shared egress IPs from Codespaces / corporate networks get flagged).
        # The brief works fine without SEC — log a one-line note, not 200
        # chars of HTML.
        ct = resp.headers.get("Content-Type", "")
        if "json" in ct:
            print(f"  [warn] SEC EDGAR {resp.status_code}: {resp.text[:200]}")
        else:
            print(f"  [info] SEC EDGAR not reachable from this network; skipping")
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


def fetch_crunchbase_overview(company: str, timeout: int = 15) -> str:
    """Crunchbase organization overview — founders, funding, HQ, employees.

    Requires CRUNCHBASE_API_KEY. Tries the simple permalink (lowercased,
    hyphenated company name); Crunchbase 404s if that doesn't match an
    indexed org, in which case we fail silently — the brief works fine
    without it.
    """
    api_key = os.environ.get("CRUNCHBASE_API_KEY")
    if not api_key:
        return ""

    permalink = _slugify_for_crunchbase(company)
    if not permalink:
        return ""

    try:
        resp = requests.get(
            CRUNCHBASE_ORG_URL.format(permalink=permalink),
            headers={"X-cb-user-key": api_key, "Accept": "application/json"},
            params={
                # Field IDs the v4 API requires — keep this list narrow so
                # we don't pay for response payload we don't use.
                "field_ids": ",".join(
                    [
                        "name",
                        "short_description",
                        "founded_on",
                        "num_employees_enum",
                        "location_identifiers",
                        "funding_total",
                        "website",
                        "categories",
                    ]
                ),
            },
            timeout=timeout,
        )
    except Exception as exc:
        print(f"  [warn] Crunchbase fetch failed: {exc}")
        return ""
    if resp.status_code == 404:
        # Permalink miss — common for private companies not in their index.
        return ""
    if resp.status_code >= 400:
        body = resp.text[:300].replace("\n", " ")
        print(f"  [warn] Crunchbase {resp.status_code}: {body}")
        return ""
    try:
        props = resp.json().get("properties", {})
    except Exception:
        return ""
    if not props:
        return ""

    lines = [f"### Crunchbase — {props.get('name', company)}"]
    if props.get("short_description"):
        lines.append(props["short_description"])

    facts: list[str] = []
    if props.get("founded_on"):
        facts.append(f"Founded {props['founded_on'].get('value', '?')}")
    if props.get("num_employees_enum"):
        facts.append(f"Headcount tier: {props['num_employees_enum']}")
    locs = props.get("location_identifiers") or []
    if locs:
        names = [l.get("value") for l in locs if l.get("value")]
        if names:
            facts.append(f"HQ: {', '.join(names[:3])}")
    funding = props.get("funding_total") or {}
    if funding.get("value_usd"):
        facts.append(f"Total funding: ${int(funding['value_usd']):,}")
    if props.get("website", {}).get("value"):
        facts.append(f"Website: {props['website']['value']}")
    if facts:
        lines.append("- " + "\n- ".join(facts))

    return "\n\n".join(lines)


def fetch_builtwith_tech(
    company: str,
    domain: Optional[str] = None,
    timeout: int = 15,
) -> str:
    """Detected tech stack via BuiltWith.

    Requires BUILTWITH_API_KEY. Needs a domain to look up — if none is
    passed, we derive a heuristic one from the company name (best-effort,
    silent miss if it doesn't resolve to a real BuiltWith record).
    """
    api_key = os.environ.get("BUILTWITH_API_KEY")
    if not api_key:
        return ""

    lookup = (domain or _derive_domain(company)).strip()
    if not lookup:
        return ""

    try:
        resp = requests.get(
            BUILTWITH_URL,
            params={"KEY": api_key, "LOOKUP": lookup},
            timeout=timeout,
        )
    except Exception as exc:
        print(f"  [warn] BuiltWith fetch failed: {exc}")
        return ""
    if resp.status_code >= 400:
        body = resp.text[:300].replace("\n", " ")
        print(f"  [warn] BuiltWith {resp.status_code}: {body}")
        return ""
    try:
        data = resp.json()
    except Exception:
        return ""

    # Walk the BuiltWith response shape: Results -> Result -> Paths -> Technologies.
    grouped: dict[str, list[str]] = {}
    for result in data.get("Results", []) or []:
        for path in result.get("Result", {}).get("Paths", []) or []:
            for tech in path.get("Technologies", []) or []:
                name = (tech.get("Name") or "").strip()
                category = (tech.get("Tag") or "Other").strip()
                if name:
                    grouped.setdefault(category, []).append(name)
    if not grouped:
        return ""

    lines = [f"### BuiltWith — detected stack on {lookup}"]
    for category in sorted(grouped):
        unique = sorted(set(grouped[category]))[:8]
        lines.append(f"- {category}: {', '.join(unique)}")
    return "\n".join(lines)


def fetch_supplementary_sources(company: str) -> list[str]:
    """All non-search sources, returned as a list of markdown blocks.
    Empty blocks are filtered out so the user message stays clean."""
    blocks: list[Optional[str]] = [
        fetch_wikipedia_summary(company),
        fetch_sec_edgar_filings(company),
        fetch_crunchbase_overview(company),
        fetch_builtwith_tech(company),
    ]
    return [b for b in blocks if b]


# ---- helpers ---------------------------------------------------------------


_PERMALINK_RE = re.compile(r"[^a-z0-9]+")


def _slugify_for_crunchbase(company: str) -> str:
    """Crunchbase permalinks are lowercased and hyphen-separated.
    'Barry-Wehmiller' -> 'barry-wehmiller', 'Post Holdings' -> 'post-holdings'."""
    return _PERMALINK_RE.sub("-", company.lower()).strip("-")


def _derive_domain(company: str) -> str:
    """Best-effort guess at the company's primary domain. Strips spaces and
    non-alphanumerics, appends .com. Works for most clean brand names
    (cintas.com, postholdings.com); fails silently for the rest."""
    bare = re.sub(r"[^a-z0-9]", "", company.lower())
    return f"{bare}.com" if bare else ""
