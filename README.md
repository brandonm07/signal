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

A two-agent CLI that turns a CSV of target accounts into a research brief plus
three outreach drafts (email, LinkedIn message, voicemail script) per company.
Both models run through OpenRouter: Qwen 3 30B-A3B researches, Gemma 3 27B-IT
drafts.

### Layout

```
agents/        Researcher and Drafter (plain Python, no framework)
config/        System prompts and model slugs
accounts/      Input CSVs (sample.csv included)
output/        {date}/{company_slug}.md per account + run_log.csv
run.py         CLI entrypoint (typer)
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

### Run

```bash
python run.py --accounts accounts/sample.csv
```

For each row: the Researcher runs four targeted searches (company overview,
last-12-months news, LinkedIn leaders, businesswire executive announcements),
synthesizes a structured brief, then the Drafter produces three outreach
variants in Brandon's voice. Everything lands in
`output/{YYYY-MM-DD}/{company-slug}.md` and a row is appended to
`output/run_log.csv`.

If the model names a person without a supporting source URL on the same line,
the brief is prepended with a **VERIFICATION REQUIRED** block listing the
unsourced contacts. Always confirm those before outreach — the small open
weight models occasionally invent plausible-looking executives.

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
