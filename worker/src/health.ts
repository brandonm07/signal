// Periodic self-test and D1 backup. Runs inside the existing cron tick,
// gated on stored timestamps so they fire once daily / once weekly regardless
// of how many cron ticks happen.
import type { Env, Lead } from "./types";
import { maybeRunRenewalAlerts } from "./contracts";
import { maybeScoreLeads } from "./scorer";

const KEY_LAST_HEALTHCHECK = "last_healthcheck_ts";
const KEY_LAST_BACKUP = "last_backup_ts";
const DAY_SECONDS = 24 * 60 * 60;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/** Run periodic maintenance — call once per cron tick. Idempotent. */
export async function runPeriodicMaintenance(env: Env): Promise<void> {
  // Only run during the morning window — avoids burning cron quota at random
  // times. Both gate themselves with timestamp checks anyway.
  const hourCentral = currentHourInTz(env.SEND_WINDOW_TZ);
  if (hourCentral !== 9) return; // only between 9-10am Central

  await maybeRunHealthcheck(env);
  await maybeRunBackup(env);
  await maybeRunRetention(env);
  await maybeRunRenewalAlerts(env);
  await maybeRunOutreachReport(env);
  await maybeScoreLeads(env);
}

const KEY_LAST_OUTREACH_REPORT = "last_outreach_report_ts";

// Weekly outreach scorecard: sent / delivered / opened / clicked, replies by
// intent, reply rate, bounces, and per-step reply counts over the last 7 days.
// Emailed to Brandon every Monday morning so deliverability vs. copy problems
// are visible instead of guessed at.
async function maybeRunOutreachReport(env: Env): Promise<void> {
  const last = await getState(env, KEY_LAST_OUTREACH_REPORT);
  const now = Math.floor(Date.now() / 1000);
  const isMonday =
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.SEND_WINDOW_TZ,
      weekday: "short",
    }).format(new Date()) === "Mon";
  if (!isMonday) return;
  if (last && now - last < WEEK_SECONDS - DAY_SECONDS) return;

  const week = 7 * DAY_SECONDS;

  const sent = (await env.DB.prepare(
    `SELECT COUNT(*) n FROM send_log WHERE outcome='sent' AND attempted_at > unixepoch() - ?1`,
  ).bind(week).first<{ n: number }>())?.n ?? 0;

  const eventsRs = await env.DB.prepare(
    `SELECT event_type, COUNT(DISTINCT recipient) n FROM email_events
       WHERE created_at > unixepoch() - ?1 GROUP BY event_type`,
  ).bind(week).all<{ event_type: string; n: number }>();
  const ev: Record<string, number> = {};
  for (const r of eventsRs.results ?? []) ev[r.event_type] = r.n;

  const repliesRs = await env.DB.prepare(
    `SELECT intent, COUNT(*) n FROM replies WHERE received_at > unixepoch() - ?1 GROUP BY intent`,
  ).bind(week).all<{ intent: string; n: number }>();
  const replies: Record<string, number> = {};
  let totalReplies = 0;
  for (const r of repliesRs.results ?? []) {
    replies[r.intent] = r.n;
    totalReplies += r.n;
  }

  const bounced = (await env.DB.prepare(
    `SELECT COUNT(*) n FROM leads WHERE status='bounced' AND updated_at > unixepoch() - ?1`,
  ).bind(week).first<{ n: number }>())?.n ?? 0;

  const stepRs = await env.DB.prepare(
    `SELECT l.step, COUNT(*) n FROM replies r JOIN leads l ON l.id = r.lead_id
       WHERE r.received_at > unixepoch() - ?1 GROUP BY l.step ORDER BY l.step`,
  ).bind(week).all<{ step: number; n: number }>();

  await setState(env, KEY_LAST_OUTREACH_REPORT, now);

  const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const meetingReplies = replies["meeting"] ?? 0;
  const body =
    `Signal Pitcher — outreach scorecard, last 7 days\n\n` +
    `Sent:        ${sent}\n` +
    `Delivered:   ${ev["delivered"] ?? 0}\n` +
    `Opened:      ${ev["opened"] ?? 0} (${pct(ev["opened"] ?? 0, sent)} of sent)\n` +
    `Clicked:     ${ev["clicked"] ?? 0}\n` +
    `Bounced:     ${bounced}\n\n` +
    `Replies:     ${totalReplies} (${pct(totalReplies, sent)} reply rate)\n` +
    `  meeting/positive: ${meetingReplies} (${pct(meetingReplies, sent)} of sent)\n` +
    `  unsubscribe:      ${replies["unsubscribe"] ?? 0}\n` +
    `  out-of-office:    ${replies["ooo"] ?? 0}\n` +
    `  other:            ${replies["other"] ?? 0}\n\n` +
    `Replies by step:\n` +
    ((stepRs.results ?? []).length
      ? (stepRs.results ?? []).map((s) => `  step ${s.step}: ${s.n}`).join("\n")
      : `  (none)`) +
    `\n\nNote: open/click counts are only populated if tracking is enabled on the Resend domain.`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
      to: "brandon@signaladvise.com",
      subject: `[Signal Pitcher] Weekly outreach scorecard — ${totalReplies} replies / ${sent} sent`,
      text: body,
    }),
  });
}

const KEY_LAST_RETENTION = "last_retention_ts";

async function maybeRunRetention(env: Env): Promise<void> {
  const last = await getState(env, KEY_LAST_RETENTION);
  const now = Math.floor(Date.now() / 1000);
  // Run weekly on Sundays alongside backup.
  const isSunday =
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.SEND_WINDOW_TZ,
      weekday: "short",
    }).format(new Date()) === "Sun";
  if (!isSunday) return;
  if (last && now - last < WEEK_SECONDS - DAY_SECONDS) return;

  const oneYear = 365 * DAY_SECONDS;
  const ninetyDays = 90 * DAY_SECONDS;

  // Audit requests + replies + login attempts older than retention windows.
  const auditDel = await env.DB.prepare(
    `DELETE FROM audit_requests WHERE created_at < unixepoch() - ?1`,
  ).bind(oneYear).run();
  const repliesDel = await env.DB.prepare(
    `DELETE FROM replies WHERE received_at < unixepoch() - ?1`,
  ).bind(oneYear).run();
  const loginDel = await env.DB.prepare(
    `DELETE FROM login_attempts WHERE attempted_at < unixepoch() - ?1`,
  ).bind(ninetyDays).run();

  await setState(env, KEY_LAST_RETENTION, now);

  // Only email if anything was actually deleted
  const total = (auditDel.meta.changes ?? 0) + (repliesDel.meta.changes ?? 0) + (loginDel.meta.changes ?? 0);
  if (total > 0) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
        to: "brandon@signaladvise.com",
        subject: `[Signal Pitcher] Weekly retention sweep — ${total} rows purged`,
        text:
          `Weekly D1 retention purge complete.\n\n` +
          `audit_requests (>1y old): ${auditDel.meta.changes ?? 0}\n` +
          `replies (>1y old): ${repliesDel.meta.changes ?? 0}\n` +
          `login_attempts (>90d old): ${loginDel.meta.changes ?? 0}\n`,
      }),
    });
  }
}

async function maybeRunHealthcheck(env: Env): Promise<void> {
  const last = await getState(env, KEY_LAST_HEALTHCHECK);
  const now = Math.floor(Date.now() / 1000);
  if (last && now - last < DAY_SECONDS - 60) return; // already ran today

  const results = await runHealthcheck(env);
  await setState(env, KEY_LAST_HEALTHCHECK, now);

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return;

  // One or more checks failed — alert.
  const body =
    `Signal Pitcher daily self-test detected ${failed.length} failure(s):\n\n` +
    failed.map((r) => `  ✘ ${r.name}: ${r.detail}`).join("\n") +
    `\n\nAll checks:\n` +
    results.map((r) => `  ${r.ok ? "✓" : "✘"} ${r.name} (${r.elapsedMs}ms)`).join("\n");

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
      to: "brandon@signaladvise.com",
      subject: `[Signal Pitcher] Self-test FAILURE — ${failed.length} issue(s)`,
      text: body,
    }),
  });
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

async function runHealthcheck(env: Env): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // 1. D1 reachable
  out.push(await check("d1 read", async () => {
    const r = await env.DB.prepare(`SELECT COUNT(*) as n FROM leads`).first<{ n: number }>();
    if (!r) throw new Error("no result");
    return `lead count ${r.n}`;
  }));

  // 2. R2 reachable (HEAD a known key or just list — use put/delete on a probe)
  out.push(await check("r2 write+delete", async () => {
    const probeKey = "_probe/" + Date.now();
    await env.AUDIT_UPLOADS.put(probeKey, "ok");
    const got = await env.AUDIT_UPLOADS.get(probeKey);
    await env.AUDIT_UPLOADS.delete(probeKey);
    if (!got) throw new Error("readback failed");
    return "ok";
  }));

  // 3. Resend health = "no recent send failures" instead of probing API.
  // Our key is sending-only scope; /domains 401s. Real sends provide the signal:
  // if Resend were down we'd see status='failed' in send_log within minutes.
  out.push(await check("resend (via send history)", async () => {
    const row = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) as errors,
         SUM(CASE WHEN outcome='sent' THEN 1 ELSE 0 END) as sent
       FROM send_log WHERE attempted_at > unixepoch() - 86400`,
    ).first<{ errors: number; sent: number }>();
    const errors = row?.errors ?? 0;
    const sent = row?.sent ?? 0;
    if (sent > 0 && errors > sent * 0.2) {
      throw new Error(`high failure rate: ${errors} errors / ${sent} sent in last 24h`);
    }
    return `${sent} sent / ${errors} errors in last 24h`;
  }));

  // 4. Gmail OAuth refresh token still valid (token endpoint accepts our refresh)
  out.push(await check("gmail oauth", async () => {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GMAIL_CLIENT_ID,
        client_secret: env.GMAIL_CLIENT_SECRET,
        refresh_token: env.GMAIL_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    if (!r.ok) throw new Error(`http ${r.status}: ${await r.text()}`);
    return "refresh ok";
  }));

  // 5. Anthropic reachable
  out.push(await check("anthropic api", async () => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return "ok";
  }));

  return out;
}

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail, elapsedMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - start,
    };
  }
}

async function maybeRunBackup(env: Env): Promise<void> {
  const last = await getState(env, KEY_LAST_BACKUP);
  const now = Math.floor(Date.now() / 1000);
  // Only run on Sundays (weekday = "Sun" in en-US tz format)
  const isSunday =
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.SEND_WINDOW_TZ,
      weekday: "short",
    }).format(new Date()) === "Sun";
  if (!isSunday) return;
  if (last && now - last < WEEK_SECONDS - DAY_SECONDS) return; // already ran this week

  await runBackup(env);
  await setState(env, KEY_LAST_BACKUP, now);
}

async function runBackup(env: Env): Promise<void> {
  const tables = ["leads", "replies", "audit_requests", "send_log", "daily_counters", "worker_state"];
  const dump: Record<string, unknown[]> = {};
  for (const t of tables) {
    const rows = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    dump[t] = rows.results;
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `backups/d1-${day}.json`;
  await env.AUDIT_UPLOADS.put(key, JSON.stringify({ created_at: new Date().toISOString(), tables: dump }, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  // Notify Brandon
  let total = 0;
  for (const t of tables) total += dump[t].length;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
      to: "brandon@signaladvise.com",
      subject: `[Signal Pitcher] Weekly D1 backup complete — ${total} rows`,
      text:
        `Weekly D1 backup written to R2.\n\n` +
        `Key: ${key}\n` +
        `Total rows: ${total}\n` +
        `Per table:\n` +
        tables.map((t) => `  ${t}: ${dump[t].length}`).join("\n") +
        `\n\nRetained 30 days (lifecycle rule auto-deletes after that).`,
    }),
  });
}

async function getState(env: Env, key: string): Promise<number | null> {
  const r = await env.DB.prepare(`SELECT value FROM worker_state WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return r ? parseInt(r.value, 10) : null;
}

async function setState(env: Env, key: string, value: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO worker_state (key, value, updated_at) VALUES (?1, ?2, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  )
    .bind(key, String(value))
    .run();
}

function currentHourInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(h, 10);
}
