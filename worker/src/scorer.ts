// Overnight lead scoring. Scores unscored queued leads against the Signal
// Advisory ICP using Claude, writes scores back to D1, and emails Brandon a
// top-N digest. Runs once per day inside the maintenance window.
import type { Env, Lead } from "./types";
import { sendViaResend } from "./email";

const KEY_LAST_SCORE_RUN = "last_score_run_ts";
const DAY_SECONDS = 24 * 60 * 60;
const BATCH_SIZE = 20; // leads scored per nightly run (cost control)

const SYSTEM_PROMPT = `You score B2B prospects for Signal Advisory, an independent telecom and technology cost advisor in Kansas City.

Best-fit clients: 20-500 employees, 1-25 locations, multi-site or multi-carrier, owner/operator or lean IT (no internal telecom expert), ideally with a trigger event (move, new location, merger, renewal, rapid hiring, recent outage).

Scoring bands:
- 80-100 (hot): multi-site, clear trigger, no internal telecom team
- 60-79 (warm): good size/complexity, no obvious trigger yet
- 40-59 (nurture): single site or limited spend, low-effort touch
- 0-39 (skip): too small, enterprise, or no telecom footprint

You are given only what is known from a cold-outreach list (company, contact name, title). Score conservatively on thin data.

Output JSON only: {"score":0-100,"tier":"hot|warm|nurture|skip","reason":"<one sentence>","opening_angle":"<one sentence hook>"}`;

interface Scored {
  score: number;
  tier: string;
  reason: string;
  opening_angle: string;
}

export async function maybeScoreLeads(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const last = await getState(env, KEY_LAST_SCORE_RUN);
  if (last && now - last < DAY_SECONDS - 3600) return;

  const rs = await env.DB.prepare(
    `SELECT * FROM leads
       WHERE lead_score IS NULL AND status = 'queued'
       ORDER BY id ASC LIMIT ?1`,
  )
    .bind(BATCH_SIZE)
    .all<Lead>();
  const leads = rs.results ?? [];

  if (leads.length === 0) {
    await setState(env, KEY_LAST_SCORE_RUN, now);
    return;
  }

  for (const lead of leads) {
    try {
      const s = await scoreOne(env, lead);
      await env.DB.prepare(
        `UPDATE leads
            SET lead_score = ?2, lead_tier = ?3, score_reason = ?4,
                opening_angle = ?5, scored_at = unixepoch()
          WHERE id = ?1`,
      )
        .bind(lead.id, s.score, s.tier, s.reason, s.opening_angle)
        .run();
    } catch (err) {
      // Mark as scored=0 so we don't retry forever on a bad row.
      const msg = err instanceof Error ? err.message : String(err);
      await env.DB.prepare(
        `UPDATE leads SET lead_score = -1, score_reason = ?2, scored_at = unixepoch()
          WHERE id = ?1`,
      )
        .bind(lead.id, `score error: ${msg}`.slice(0, 200))
        .run();
    }
  }

  await emailDigest(env);
  await setState(env, KEY_LAST_SCORE_RUN, now);
}

async function scoreOne(env: Env, lead: Lead): Promise<Scored> {
  const known =
    `Company: ${lead.company || "(unknown)"}\n` +
    `Contact: ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "(unknown)"}\n` +
    `Title: ${lead.title || "(unknown)"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: known }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const json = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = json.content.find((c) => c.type === "text")?.text ?? "";
  return parseScore(text);
}

function parseScore(s: string): Scored {
  const cleaned = s.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  let p: Partial<Scored> = {};
  try {
    p = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) p = JSON.parse(m[0]);
  }
  const score = typeof p.score === "number" ? Math.max(0, Math.min(100, p.score)) : 0;
  const tier = ["hot", "warm", "nurture", "skip"].includes(p.tier ?? "") ? p.tier! : "skip";
  return {
    score,
    tier,
    reason: (p.reason ?? "").slice(0, 300),
    opening_angle: (p.opening_angle ?? "").slice(0, 300),
  };
}

async function emailDigest(env: Env): Promise<void> {
  const rs = await env.DB.prepare(
    `SELECT company, first_name, last_name, title, email, lead_score, lead_tier,
            score_reason, opening_angle
       FROM leads
      WHERE lead_score IS NOT NULL AND lead_score > 0 AND status = 'queued'
        AND scored_at > unixepoch() - 90000
      ORDER BY lead_score DESC LIMIT 5`,
  ).all<Lead & { lead_score: number; lead_tier: string; score_reason: string; opening_angle: string }>();
  const top = rs.results ?? [];
  if (top.length === 0) return;

  const lines: string[] = ["Today's highest-scoring prospects:", ""];
  for (const l of top) {
    const who = [l.first_name, l.last_name].filter(Boolean).join(" ");
    lines.push(`[${l.lead_score}] ${l.lead_tier?.toUpperCase()} — ${l.company || "?"}`);
    lines.push(`  ${who}${l.title ? ", " + l.title : ""} · ${l.email}`);
    if (l.score_reason) lines.push(`  Why: ${l.score_reason}`);
    if (l.opening_angle) lines.push(`  Angle: ${l.opening_angle}`);
    lines.push("");
  }
  lines.push("Full pipeline: https://api.signaladvise.com/admin/ui/");
  const text = lines.join("\n");

  await sendViaResend(
    {
      from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
      to: "brandon@signaladvise.com",
      reply_to: "brandon@signaladvise.com",
      subject: `Top prospects scored overnight (${top.length})`,
      text,
      html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(text)}</pre>`,
      headers: {},
    },
    env.RESEND_API_KEY,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getState(env: Env, key: string): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT value FROM worker_state WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return row ? parseInt(row.value, 10) : null;
}

async function setState(env: Env, key: string, value: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO worker_state (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, String(value))
    .run();
}
