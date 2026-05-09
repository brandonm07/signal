// Inbound subsystem: poll Gmail for replies, classify intent, draft response,
// log to D1, and act on unsubscribe/bounce intents automatically.
import type { Env, Intent, Lead } from "./types";
import { classifyReply } from "./classify";
import { createDraftReply, getMessage, listInboxMessages } from "./gmail";

const STATE_KEY_LAST_TS = "gmail_last_internal_ts";

export async function pollInbound(env: Env): Promise<void> {
  const cursor = await getCursor(env);
  // newer_than:7d as a hard ceiling so we never scan the whole inbox.
  const query = `to:(brandon@signaladvise.com OR info@signaladvise.com) newer_than:7d -from:me`;
  const messages = await listInboxMessages(env, query, 50);
  if (messages.length === 0) return;

  // Process oldest first so cursor advances cleanly on partial failures.
  // Gmail returns newest first; reverse it.
  const ordered = [...messages].reverse();
  let newCursor = cursor;

  for (const m of ordered) {
    // Skip if already logged (idempotency).
    const exists = await env.DB.prepare(
      `SELECT id FROM replies WHERE gmail_message_id = ?1`,
    )
      .bind(m.id)
      .first();
    if (exists) continue;

    let parsed;
    try {
      parsed = await getMessage(env, m.id);
    } catch (err) {
      console.error("getMessage failed", m.id, err);
      continue;
    }

    if (parsed.internalDate <= cursor) continue;
    if (parsed.autoSubmitted && parsed.autoSubmitted !== "no") {
      // Likely an automated message. Still log as ooo for visibility.
      await logReply(env, parsed, "ooo", 0.95, null);
      newCursor = Math.max(newCursor, parsed.internalDate);
      continue;
    }

    const lead = await findLeadByEmail(env, extractEmail(parsed.from));

    let intent: Intent;
    let confidence: number;
    try {
      const cls = await classifyReply(
        env,
        parsed.subject,
        parsed.bodyText,
        parsed.from,
      );
      intent = cls.intent;
      confidence = cls.confidence;
    } catch (err) {
      console.error("classify failed", err);
      intent = "other";
      confidence = 0;
    }

    let draftId: string | null = null;
    if (intent === "meeting") {
      try {
        const draft = await draftMeetingReply(env, parsed, lead);
        draftId = draft.id;
      } catch (err) {
        console.error("draft create failed", err);
      }
    }

    if (intent === "unsubscribe" && lead) {
      await env.DB.prepare(
        `UPDATE leads SET status = 'unsubscribed', updated_at = unixepoch() WHERE id = ?1`,
      )
        .bind(lead.id)
        .run();
    }
    if (intent === "bounce" && lead) {
      await env.DB.prepare(
        `UPDATE leads SET status = 'bounced', updated_at = unixepoch() WHERE id = ?1`,
      )
        .bind(lead.id)
        .run();
    }

    await logReply(env, parsed, intent, confidence, draftId);
    newCursor = Math.max(newCursor, parsed.internalDate);
  }

  if (newCursor > cursor) {
    await setCursor(env, newCursor);
  }
}

async function findLeadByEmail(env: Env, email: string): Promise<Lead | null> {
  if (!email) return null;
  return await env.DB.prepare(`SELECT * FROM leads WHERE email = ?1 LIMIT 1`)
    .bind(email.toLowerCase())
    .first<Lead>();
}

function extractEmail(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  return fromHeader.trim().toLowerCase();
}

async function draftMeetingReply(
  env: Env,
  parsed: Awaited<ReturnType<typeof getMessage>>,
  lead: Lead | null,
): Promise<{ id: string }> {
  const firstName = lead?.first_name ?? guessFirstName(parsed.from);
  const replyBody =
    `Hi${firstName ? " " + firstName : ""},\n\n` +
    `Thanks for getting back to me. Happy to set something up — what does your week look like?\n\n` +
    `If easier, you can grab any time directly: ${env.CALENDLY_URL}\n\n` +
    `Brandon`;

  const subject = parsed.subject.toLowerCase().startsWith("re:")
    ? parsed.subject
    : `Re: ${parsed.subject}`;

  const refs = parsed.references
    ? `${parsed.references} ${parsed.messageId ?? ""}`.trim()
    : (parsed.messageId ?? "");

  return await createDraftReply(env, {
    threadId: parsed.threadId,
    to: parsed.from,
    from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
    subject,
    inReplyTo: parsed.messageId,
    references: refs || undefined,
    bodyText: replyBody,
  });
}

function guessFirstName(fromHeader: string): string {
  const nameMatch = fromHeader.match(/^"?([^"<]+?)"?\s*</);
  if (!nameMatch) return "";
  const name = nameMatch[1].trim();
  return name.split(/\s+/)[0] ?? "";
}

async function logReply(
  env: Env,
  parsed: Awaited<ReturnType<typeof getMessage>>,
  intent: Intent,
  confidence: number,
  draftId: string | null,
): Promise<void> {
  const lead = await findLeadByEmail(env, extractEmail(parsed.from));
  await env.DB.prepare(
    `INSERT INTO replies
       (lead_id, gmail_message_id, gmail_thread_id, from_email, subject,
        snippet, body_text, intent, intent_confidence, draft_id,
        draft_mode_active, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(gmail_message_id) DO NOTHING`,
  )
    .bind(
      lead?.id ?? null,
      parsed.id,
      parsed.threadId,
      extractEmail(parsed.from),
      parsed.subject,
      parsed.snippet,
      parsed.bodyText.slice(0, 8000),
      intent,
      confidence,
      draftId,
      env.DRAFT_MODE === "1" ? 1 : 0,
      Math.floor(parsed.internalDate / 1000),
    )
    .run();
}

async function getCursor(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT value FROM worker_state WHERE key = ?1`,
  )
    .bind(STATE_KEY_LAST_TS)
    .first<{ value: string }>();
  return row ? parseInt(row.value, 10) : 0;
}

async function setCursor(env: Env, ts: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO worker_state (key, value, updated_at)
     VALUES (?1, ?2, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  )
    .bind(STATE_KEY_LAST_TS, String(ts))
    .run();
}
