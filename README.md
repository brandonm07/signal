# Signal Advisory

Repo home for **Signal Advisory LLC** — independent technology broker, Kansas
City. Houses the authoritative business plan and the marketing site.

## Repo map

```
signal/
├── CLAUDE.md                  Behavioral guidelines for Claude Code
├── docs/                      Markdown — source of truth
│   ├── business-plan.md       Founder's Business Plan v1.0 (authoritative)
│   ├── bdr-playbook.md        BDR calling playbook (scripts, personas, voice)
│   ├── brand.md               Name, voice, type, palette placeholders
│   └── legacy/
│       └── cairn-playbook.md  Earlier "Cairn Networks" playbook — superseded
├── assets/                    Original source files (PDF, docx, HTML)
└── web/                       Astro marketing site
```

`docs/` is the working source. `assets/` holds the originals the docs were
converted from — do not edit them in place.

## Marketing site (web/)

Astro + TypeScript + Tailwind + pnpm. Static output, no backend.

```bash
cd web
pnpm install
pnpm dev         # http://localhost:4321
pnpm build       # static output to web/dist/
pnpm preview     # serve the built site
pnpm format      # Prettier
```

Brand tokens live in [`web/src/styles/global.css`](web/src/styles/global.css)
as CSS variables (`--ink`, `--paper`, `--signal`, `--moss`, `--stone`). They
mirror [`docs/brand.md`](docs/brand.md) — update both when the founders lock
the palette.

## Open decisions

See the checklist at the bottom of [`docs/brand.md`](docs/brand.md). Final
palette, logo direction, and deploy target (Cloudflare Pages vs Vercel) are
not yet decided.

## Prospecting pipeline (Python CLI)

A three-agent CLI that turns a CSV of target accounts into a research brief, a
ranked list of decision makers, and three outreach drafts (email, LinkedIn
message, voicemail script) per company. All three agents run through
OpenRouter: Qwen 3 30B-A3B for research + targeting, Gemma 3 27B-IT for
drafting.

### Layout

```
agents/        Researcher, Targeter, Drafter, Memory, Pipeline orchestration
config/        System prompts and model slugs
accounts/      Input CSVs (sample.csv included)
output/        {date}/{company_slug}.md per account + memory.db + run_log.csv
app.py         Streamlit dashboard (interactive UI)
run.py         CLI entrypoint (typer)
evals/         Brief grader (checklist-based pass/fail)
tests/         Smoke test (no network)
```

### Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env     # then fill in OPENROUTER_API_KEY
```

Optionally add a `TAVILY_API_KEY` to `.env` for cleaner enterprise search
results (free tier, 1000 searches/month, https://tavily.com). Without it the
Researcher falls back to DuckDuckGo.

For the Targeter's contact enrichment, optionally add `APOLLO_API_KEY`
(free tier, 50 calls/month, https://apollo.io) or `ZOOMINFO_API_KEY`
(enterprise, paid). ZoomInfo takes priority if both are set. Without
either, the Targeter falls back to search — it can find LinkedIn URLs
but NOT emails. The tool will never pattern-guess an email.

For the Researcher's firmographics, two more optional keys:

- `CRUNCHBASE_API_KEY` — pulls founders, funding rounds, HQ, employee
  tier on funded private companies. Paid API (https://data.crunchbase.com).
- `BUILTWITH_API_KEY` — pulls the detected technology stack from the
  company's website. Paid API (https://builtwith.com). Useful for the
  "Likely Stack and Suspected Pain" section.

All four enrichment sources (ZoomInfo, Apollo, Crunchbase, BuiltWith)
silently no-op when their key isn't set, so leaving `.env` blank is the
expected default and the pipeline still produces full briefs from
Wikipedia, SEC EDGAR, and Tavily search.

### Run — Streamlit dashboard (recommended)

```bash
streamlit run app.py
```

Codespaces forwards the port automatically; locally it opens a browser tab.
Type a company name, watch the live progress (researching → targeting →
drafting), see the brief in three tabs (Research / Decision Makers / Drafts),
and click any past brief from the sidebar to revisit it. Same pipeline as the
CLI under the hood.

### Run — CLI

Two modes — batch (a CSV of targets) or ad-hoc (one company on demand):

```bash
# Batch (serial — default)
python run.py --accounts accounts/sample.csv

# Batch (parallel — ~5x faster on large lists)
python run.py --accounts accounts/sample.csv --workers 5

# Ad-hoc
python run.py --company "Acme Corp" --notes "Met at SXSW"

# Force re-run even if a recent brief exists in the cache
python run.py --company "Acme Corp" --refresh
```

`--workers` fans the pipeline across N threads. Capped at 10 to avoid
OpenRouter rate limits. Roughly: 100 accounts × ~90s each = ~2.5 hours
serial, ~30 minutes at `--workers 5`. Per-step progress is suppressed in
parallel mode (it would interleave); each account prints one line when it
finishes with the elapsed time.

For each row: the Researcher pulls four targeted searches plus Wikipedia and
SEC EDGAR filings, then writes a structured brief; the Targeter enriches 2–3
decision-maker contacts matching Signal's persona priorities (VP IT →
Director → C-suite); the Drafter produces three outreach variants in
Brandon's voice. Everything lands in `output/{YYYY-MM-DD}/{company-slug}.md`
and a row is appended to `output/run_log.csv`.

The pipeline keeps a SQLite memory at `output/memory.db`. Re-running on a
company within 30 days pulls the cached brief instead of re-spending API
credit. Pass `--refresh` to ignore the cache; `--cache-days N` to change the
window.

If the model names a person without a supporting source URL on the same line,
the brief is prepended with a **VERIFICATION REQUIRED** block listing the
unsourced contacts. Always confirm those before outreach — the small open
weight models occasionally invent plausible-looking executives.

### Eval the briefs

`evals/` grades existing briefs against a checklist (sections present, sources
cited, contacts sourced, no banned phrases, word count, drafts present).

```bash
# Grade existing briefs (zero API cost)
python -m evals.run --dir output/2026-04-23/

# Generate fresh briefs and grade them (spends API credit)
python -m evals.run --companies "Barry-Wehmiller,Hunter Engineering"
```

Exit code 0 if every check passes, 1 otherwise — drop into CI if you want.

### Adding accounts

Append rows to `accounts/sample.csv` or point `--accounts` at your own file.
Columns: `company_name` (required), `contact_name` (optional), `notes`
(optional).

### Cost expectations

Rough ballpark at current OpenRouter rates: **~$0.01 to $0.03 per account**.
Both calls cap `max_tokens` defensively (Researcher 2000, Drafter 800) so a
runaway response can't silently burn credit.

### Tests

```bash
pytest tests/
```

The smoke test only verifies imports and prompt loading. It does not hit the
network.
