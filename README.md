# Signal Advisory

Repo home for **Signal Advisory LLC** — independent technology broker, Kansas
City. Three things live here:

1. **`worker/` — Signal Pitcher** (the production system): a Cloudflare Worker
   at `api.signaladvise.com` that runs cold-email outreach end-to-end, plus
   client billing (Stripe), a client portal, audit-request intake with file
   uploads, and self-monitoring. **This is revenue-bearing code** — it sends
   real email and collects real money.
2. **`web/`** — Astro marketing site at `signaladvise.com` (static output,
   deployed as Cloudflare Workers static assets via the root `wrangler.toml`).
3. **`docs/` + `legal/` + `assets/`** — business plan, BDR playbook, brand
   guide, MSA/LOA templates.

## Repo map

```
signal/
├── CLAUDE.md                  Working agreements for AI-assisted changes
├── wrangler.toml              Marketing-site deploy (static assets from web/dist)
├── .github/workflows/ci.yml   CI: worker typecheck+tests, web build
├── worker/                    ── THE PRODUCT ──
│   ├── wrangler.toml          Worker config: cron, D1, R2, queue, vars
│   ├── migrations/            D1 migrations (apply ONLY via wrangler — see below)
│   └── src/
│       ├── index.ts           Router + send pipeline + audit intake + unsubscribe
│       ├── shared.ts          Security-critical helpers (single definitions)
│       ├── email.ts           Outreach email assembly + Resend client
│       ├── sequence.ts        Follow-up templates + sequence state machine
│       ├── inbound.ts         Gmail reply polling → classify → act
│       ├── gmail.ts           Minimal Gmail API client (refresh-token flow)
│       ├── classify.ts        Claude intent classifier for replies
│       ├── scorer.ts          Nightly ICP lead scoring (Claude) + digest
│       ├── contracts.ts       Renewal-defense alerts (180/90/30 days)
│       ├── health.ts          Cron maintenance: self-test, backup, retention
│       ├── invoices.ts        Billing: clients, invoices, Stripe webhook
│       ├── stripe.ts          Minimal Stripe REST client + webhook verify
│       ├── portal.ts          Client portal (magic-link auth, dashboard)
│       └── admin-ui.ts        Server-rendered admin UI (cookie session)
├── web/                       Astro + Tailwind + pnpm marketing site
├── docs/                      Business plan, BDR playbook, brand (source of truth)
├── legal/                     MSA/LOA templates + docx build script
└── assets/                    Original source files — do not edit in place
```

## How the worker works

```
cron (every minute, weekdays 9–5 Central)
 ├─ tick()        claim ONE queued lead → Cloudflare Queue → processSend() → Resend
 ├─ pollInbound() Gmail replies → Claude classifies intent → update lead status,
 │                draft meeting replies (DRAFT_MODE=1 keeps a human in the loop)
 └─ maintenance   requeue stranded sends; at 9am: self-test, weekly backup,
                  retention sweep, renewal alerts, weekly scorecard, lead scoring

fetch
 ├─ /u                       unsubscribe (GET shows confirm page, POST commits —
 │                           survives corporate link-scanners; RFC 8058 one-click)
 ├─ /audit                   audit-request intake (IP-throttled), emails upload link
 ├─ /upload/:token           single-use, 7-day upload page → R2
 ├─ /portal/*                client dashboard (magic-link login, signed sessions)
 ├─ /i/:token (+ /pay)       public invoice view → Stripe Checkout
 ├─ /webhook/stripe          payment events (HMAC verified, replay-bounded)
 ├─ /webhook/resend          bounces/complaints/engagement (HMAC verified, replay-bounded)
 ├─ /admin/*                 API (x-admin-secret header)
 └─ /admin/ui/*              admin UI (signed 24h session cookie)
```

### Send-safety invariants (do not weaken)

- **At-most-once per (lead, step):** `tick()` claims a lead by flipping
  `queued → sending`; `processSend()` refuses any lead not in `sending`; every
  Resend call carries an `Idempotency-Key` of `lead-{id}-step-{step}` (Resend
  dedupes for 24h). A queue retry or duplicate delivery cannot double-send.
- **Self-healing:** leads stuck in `sending` > 1h are returned to `queued` by
  the maintenance sweeper.
- **Permanent vs transient failures:** Resend 4xx marks the lead `failed`
  (no retry); 5xx/429/network rethrows so the queue retries (3×, then DLQ).
- **Suppression:** unsubscribes (link, one-click, reply intent, spam
  complaint) and hard bounces flip status so the sequence never touches that
  address again.
- **Volume guards:** `DAILY_CAP`, send window (9–5 CT weekdays), jitter.

## Secrets and config

Plain config lives in `worker/wrangler.toml` `[vars]`. Secrets are set with
`wrangler secret put <NAME> --config wrangler.toml` from `worker/`:

| Secret | Used for |
|---|---|
| `RESEND_API_KEY` | All outbound email |
| `ADMIN_SECRET` | Admin API header + admin UI login |
| `PORTAL_SIGNING_SECRET` | Portal/magic-link HMAC (falls back to `ADMIN_SECRET`) |
| `RESEND_WEBHOOK_SECRET` | Resend webhook signature verification |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Billing |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Reply polling + drafts |
| `ANTHROPIC_API_KEY` | Reply classification + lead scoring |

Never put a secret in `[vars]` or in code.

## Development & deploy runbook (worker)

```bash
cd worker
npm ci                      # once
npx tsc --noEmit            # 1. types clean
npm test                    # 2. tests green
npx wrangler d1 migrations list signaladvise --remote --config wrangler.toml
                            # 3. remote migrations clean — no pending, no drift
npm run deploy              # 4. deploy
```

**Migrations: only ever through `worker/migrations/` + `npm run
db:migrate:remote`.** Never apply schema changes out-of-band in the D1
console — migration 0009 was once applied manually, the journal drifted, and
the next migration run failed on `duplicate column`. The weekly backup
derives its table list from the live schema, so new tables are backed up
automatically.

Always keep `--config wrangler.toml` in wrangler commands here — a stray
`wrangler.jsonc` higher in the filesystem can otherwise hijack config
resolution (this happened; the npm scripts already pin it).

## Deliverability runbook (cold outreach)

The whole outreach motion lives or dies on inbox placement. The code enforces
the mechanical half (volume caps, windows, one-click unsubscribe, plain-text
bodies, idempotent sends, bounce/complaint suppression). The operational half
is on you:

1. **DNS first.** SPF, DKIM, and DMARC must all pass and align for the
   sending domain in Resend's dashboard. Set a custom Return-Path. Start
   DMARC at `p=none` with reports, move to `p=quarantine` once clean.
2. **Separate the cold domain.** `OUTREACH_SENDER_EMAIL` currently sends from
   the primary domain. Buy a lookalike (e.g. `signaladvise.net`), warm it,
   and point `OUTREACH_SENDER_NAME/EMAIL` at it so cold-email complaints
   can never poison transactional mail (invoices, portal links, receipts).
   The code already supports this split — it's a config change.
3. **Warm up before raising `DAILY_CAP`.** The ramp in `wrangler.toml`
   (10 → 25 → 50 → 100 → 200/day, one week per step) exists for a reason.
   Never jump volume on a cold domain or after a quiet period.
4. **Watch the scorecard.** The Monday email reports sent/delivered/opened/
   replied/bounced. Bounce rate over ~2% or any spam complaint: stop, fix
   the list, then resume. Register the domain in Google Postmaster Tools —
   Gmail requires complaint rate < 0.3%.
5. **List quality beats copy.** Verify addresses before import (bounces are
   the #1 reputation killer). Every lead row should have a real
   `first_name` and `company` — templates fall back gracefully (`there` /
   `your team`), but fallbacks read like mass mail. Personalized step-1
   openers are what get replies.
6. **Keep content reply-bait, not click-bait.** Plain text, < 150 words, one
   question as the CTA, no images, no attachments, at most one link. The
   test suite enforces the mechanical parts (length, no ALL-CAPS/`$$`/`!!`,
   only supported merge tags). Leave open/click tracking OFF on the cold
   domain — tracking pixels and rewritten links are spam signals.
7. **Seed-test after any template change.** Send to a fresh Gmail, Outlook,
   and Yahoo seed inbox and check placement before resuming volume
   (mail-tester.com gives a quick spam-score read).

## Marketing site (web/)

Astro + TypeScript + Tailwind + pnpm. Static output, no backend.

```bash
cd web
pnpm install
pnpm dev         # http://localhost:4321
pnpm build       # static output to web/dist/
pnpm format      # Prettier
```

Brand tokens live in `web/src/styles/global.css` as CSS variables, mirroring
`docs/brand.md` — update both together. The audit form on `/audit` posts to
`https://api.signaladvise.com/audit` (the worker).

## CI

`.github/workflows/ci.yml` runs on every push/PR: worker typecheck + test
suite, and a full web build. A red build means do not deploy.
