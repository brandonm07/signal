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
