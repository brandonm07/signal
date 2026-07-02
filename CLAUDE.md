# CLAUDE.md — Signal Advisory

This repo contains a live, revenue-bearing system: `worker/` sends real cold
email and collects real money. Use your judgment on how to get things done —
these are objectives and invariants, not step-by-step procedures.

## How to work

- **Objectives over tasks.** Before coding, state what "done" looks like and
  how you'll verify it. Then find the path yourself. If a request is
  ambiguous, surface the interpretations instead of picking silently.
- **Verify, don't assume.** Every change ends with the verification commands
  below actually run, and their output reported honestly.
- **Surgical changes.** Touch only what the objective requires. Match the
  existing style (hand-rolled fetch clients, no SDKs, server-rendered HTML
  strings, integer cents). Don't add dependencies, abstractions, or
  configurability nobody asked for.
- **The simplest correct version wins.** If 50 lines do it, don't write 200.

## Verification

```bash
# worker (required for any worker/ change)
cd worker && npx tsc --noEmit && npm test

# remote DB state must be clean before any deploy
npx wrangler d1 migrations list signaladvise --remote --config wrangler.toml

# web (required for any web/ change)
cd web && pnpm install --frozen-lockfile && pnpm build
```

CI (`.github/workflows/ci.yml`) runs the same checks — a change that would
fail CI is not done.

## Invariants — verify these survive any change you make

- **At-most-once email per (lead, step).** The chain is: `tick()` claims via
  `queued → sending`, `processSend()` refuses non-`sending` leads, and every
  outreach send carries Resend `Idempotency-Key: lead-{id}-step-{step}`.
  Done = a queue retry or duplicate delivery cannot produce a second email.
- **Suppression is sacred.** Unsubscribed/bounced/replied leads never get
  another sequence email, under any code path. The `suppressions` table is
  the durable do-not-email list: it outlives lead rows, every opt-out path
  (List-Unsubscribe, complaint, hard bounce, reply-based unsubscribe) writes
  to it, and `processSend()` checks it at the moment of send.
- **Security helpers have exactly one definition** — `worker/src/shared.ts`
  (`escapeHtml`, `safeEqual`, token signing, svix verify). Never re-implement
  one locally; never bypass escaping when interpolating into HTML.
- **Money is integer cents** end to end. No floats, ever.
- **Webhooks verify signatures before any state change**, with timestamp
  tolerance against replay (both Stripe and Resend).
- **Open endpoints are IP-throttled** via `login_attempts` (`/audit`,
  `/portal/login`, `/portal/signup`, admin login).
- **Secrets only via `wrangler secret put`** — never in `[vars]`, code, or
  test fixtures.
- **Schema changes only via `worker/migrations/`** + wrangler. Out-of-band
  console edits caused real drift once (migration 0009). The backup derives
  its table list from the live schema, so new tables are covered
  automatically.
- **Deliverability gates stay intact:** send window, `DAILY_CAP`, jitter,
  List-Unsubscribe headers, plain-text-first content. Template changes must
  keep the sequence content tests green (length, no spam-bait formatting,
  only `{{first_name}}`/`{{company}}` merge tags) — and warrant a seed-inbox
  test before volume resumes (see README deliverability runbook).
