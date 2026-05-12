import type { Env, Lead, QueueJob } from "./types";
import { buildEmail, sendViaResend } from "./email";
import { pollInbound } from "./inbound";
import { SEQUENCE_STEPS } from "./sequence";

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Run outbound + inbound concurrently. Either failing should not block the other.
    ctx.waitUntil(
      Promise.allSettled([
        tick(env).catch((e) => console.error("tick failed", e)),
        pollInbound(env).catch((e) => console.error("pollInbound failed", e)),
      ]),
    );
  },

  async queue(batch: MessageBatch<QueueJob>, env: Env) {
    for (const msg of batch.messages) {
      try {
        await processSend(msg.body.leadId, env);
        msg.ack();
      } catch (err) {
        msg.retry();
        throw err;
      }
    }
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // CORS preflight for browser POSTs from signaladvise.com
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }
    if (url.pathname === "/u" || url.pathname === "/u/") {
      return handleUnsubscribe(url, env);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/webhook/resend" && req.method === "POST") {
      return handleResendWebhook(req, env);
    }
    if (url.pathname === "/audit" && req.method === "POST") {
      return handleAuditIntake(req, env);
    }
    if (url.pathname.startsWith("/admin/")) {
      const secret = req.headers.get("x-admin-secret");
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      if (url.pathname === "/admin/tick") {
        ctx.waitUntil(tick(env, { ignoreWindow: true }));
        return new Response("tick triggered", { status: 202 });
      }
      if (url.pathname === "/admin/poll") {
        ctx.waitUntil(pollInbound(env));
        return new Response("poll triggered", { status: 202 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

async function tick(env: Env, opts: { ignoreWindow?: boolean } = {}): Promise<void> {
  if (!opts.ignoreWindow && !isInSendWindow(env)) return;

  const today = todayInTz(env.SEND_WINDOW_TZ);
  const cap = parseInt(env.DAILY_CAP, 10);
  const sentToday = await getSentToday(env, today);
  if (sentToday >= cap) return;

  const lead = await env.DB.prepare(
    `SELECT * FROM leads
       WHERE status = 'queued'
         AND (scheduled_for IS NULL OR scheduled_for <= unixepoch())
       ORDER BY scheduled_for IS NULL, scheduled_for ASC, id ASC
       LIMIT 1`,
  ).first<Lead>();
  if (!lead) return;

  const claimed = await env.DB.prepare(
    `UPDATE leads SET status = 'sending', updated_at = unixepoch()
       WHERE id = ?1 AND status = 'queued'`,
  )
    .bind(lead.id)
    .run();
  if (!claimed.meta.changes) return;

  const jitter = Math.floor(
    Math.random() * parseInt(env.JITTER_MAX_SECONDS, 10),
  );
  await env.PITCHER_QUEUE.send({ leadId: lead.id }, { delaySeconds: jitter });
}

async function processSend(leadId: number, env: Env): Promise<void> {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?1`)
    .bind(leadId)
    .first<Lead>();
  if (!lead) return;
  if (lead.status === "unsubscribed") return;

  try {
    const msg = buildEmail(lead, env);
    const resp = await sendViaResend(msg, env.RESEND_API_KEY);

    const today = todayInTz(env.SEND_WINDOW_TZ);
    const currentStep = lead.step ?? 1;
    const nextStep = currentStep + 1;
    const nextTpl = SEQUENCE_STEPS[nextStep];
    // Advance the sequence: if a next step exists, requeue with delay.
    // If we just sent the final step (4), mark the lead 'completed'.
    const nextStatus = nextTpl ? "queued" : "completed";
    const nextScheduledFor = nextTpl
      ? Math.floor(Date.now() / 1000) + nextTpl.delayDays * 86400
      : null;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE leads
            SET status = ?2, sent_at = unixepoch(),
                resend_message_id = ?3, step = ?4,
                scheduled_for = ?5, updated_at = unixepoch()
          WHERE id = ?1`,
      ).bind(lead.id, nextStatus, resp.id, nextTpl ? nextStep : currentStep, nextScheduledFor),
      env.DB.prepare(
        `INSERT INTO send_log (lead_id, outcome, resend_message_id)
           VALUES (?1, 'sent', ?2)`,
      ).bind(lead.id, resp.id),
      env.DB.prepare(
        `INSERT INTO daily_counters (day, sent) VALUES (?1, 1)
           ON CONFLICT(day) DO UPDATE SET sent = sent + 1`,
      ).bind(today),
    ]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE leads
            SET status = 'failed', error = ?2, updated_at = unixepoch()
          WHERE id = ?1`,
      ).bind(lead.id, errMsg),
      env.DB.prepare(
        `INSERT INTO send_log (lead_id, outcome, error) VALUES (?1, 'error', ?2)`,
      ).bind(lead.id, errMsg),
    ]);
    throw err;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "https://signaladvise.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleAuditIntake(req: Request, env: Env): Promise<Response> {
  let body: {
    first_name?: string;
    company?: string;
    email?: string;
    carrier?: string;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "bad json" }, 400);
  }
  const { first_name = "", company = "", email = "", carrier = "", notes = "" } = body;
  if (!email || !email.includes("@") || !first_name || !company) {
    return jsonResponse({ error: "missing required fields" }, 400);
  }
  // Honeypot: simple email validation already done above.

  // Log to D1
  await env.DB.prepare(
    `INSERT INTO audit_requests (first_name, company, email, carrier, notes) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(first_name, company, email.toLowerCase(), carrier, notes)
    .run();

  // Notify Brandon
  await sendNotification(env, {
    to: "brandon@signaladvise.com",
    subject: `New audit request — ${company} (${first_name})`,
    text:
      `New invoice audit request from the website:\n\n` +
      `Name: ${first_name}\n` +
      `Company: ${company}\n` +
      `Email: ${email}\n` +
      `Primary carrier: ${carrier || "—"}\n` +
      `Notes: ${notes || "—"}\n\n` +
      `Reply within 24 business hours with a secure upload link.`,
  });

  // Confirmation to prospect
  await sendNotification(env, {
    to: email,
    subject: `Your invoice audit request — Signal Advisory`,
    text:
      `Hi ${first_name},\n\n` +
      `Got your request. I'll reply personally within 24 business hours with a secure upload link for your invoice.\n\n` +
      `Once I have it, you'll get the marked-up version back the next business day.\n\n` +
      `Brandon\n` +
      `Principal Advisor\n` +
      `Signal Advisory\n` +
      `brandon@signaladvise.com · 816.721.6501`,
  });

  return jsonResponse({ ok: true }, 200);
}

async function sendNotification(
  env: Env,
  msg: { to: string; subject: string; text: string },
): Promise<void> {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
      to: msg.to,
      reply_to: env.REPLY_TO,
      subject: msg.subject,
      text: msg.text,
    }),
  });
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

async function handleResendWebhook(req: Request, env: Env): Promise<Response> {
  // Resend sends svix-style signed webhooks. Verify if a secret is configured;
  // otherwise accept (best-effort) and rely on the obscure URL.
  const body = await req.text();
  if (env.RESEND_WEBHOOK_SECRET) {
    const ok = await verifySvix(req, body, env.RESEND_WEBHOOK_SECRET);
    if (!ok) return new Response("invalid signature", { status: 401 });
  }
  let evt: { type?: string; data?: { email_id?: string; to?: string[]; bounce?: { type?: string } } };
  try {
    evt = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const type = evt.type ?? "";
  const recipient = evt.data?.to?.[0]?.toLowerCase();
  if (!recipient) return new Response("ok", { status: 200 });

  if (type === "email.bounced") {
    const isHard = (evt.data?.bounce?.type ?? "").toLowerCase() !== "transient";
    if (isHard) {
      await env.DB.prepare(
        `UPDATE leads SET status='bounced', error='hard bounce (resend webhook)', updated_at=unixepoch()
           WHERE email = ?1 AND status NOT IN ('unsubscribed','bounced')`,
      ).bind(recipient).run();
    }
  } else if (type === "email.complained") {
    await env.DB.prepare(
      `UPDATE leads SET status='unsubscribed', error='spam complaint (resend webhook)', updated_at=unixepoch()
         WHERE email = ?1 AND status != 'unsubscribed'`,
    ).bind(recipient).run();
  }
  return new Response("ok", { status: 200 });
}

async function verifySvix(req: Request, body: string, secret: string): Promise<boolean> {
  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const sig = req.headers.get("svix-signature");
  if (!id || !ts || !sig) return false;
  const key = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const toSign = new TextEncoder().encode(`${id}.${ts}.${body}`);
  const macBuf = await crypto.subtle.sign("HMAC", cryptoKey, toSign);
  const expected = btoa(String.fromCharCode(...new Uint8Array(macBuf)));
  return sig.split(" ").some((s) => s.split(",")[1] === expected);
}

async function handleUnsubscribe(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("t");
  if (!token) return htmlResponse("Invalid link.", 400);

  const result = await env.DB.prepare(
    `UPDATE leads
        SET status = 'unsubscribed', updated_at = unixepoch()
      WHERE unsubscribe_token = ?1
        AND status NOT IN ('unsubscribed','replied')`,
  )
    .bind(token)
    .run();

  if (!result.meta.changes) {
    const exists = await env.DB.prepare(
      `SELECT 1 FROM leads WHERE unsubscribe_token = ?1`,
    )
      .bind(token)
      .first();
    if (!exists) return htmlResponse("Invalid or expired link.", 404);
  }

  return htmlResponse(
    `<h1>You're unsubscribed.</h1><p>You will not receive further emails from Signal Advisory.</p>`,
  );
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Signal Advisory</title>` +
      `<style>body{font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:80px auto;padding:0 24px;color:#222}</style>` +
      body,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function isInSendWindow(env: Env): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: env.SEND_WINDOW_TZ,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = parseInt(hourStr, 10);
  const start = parseInt(env.SEND_WINDOW_START_HOUR, 10);
  const end = parseInt(env.SEND_WINDOW_END_HOUR, 10);
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  return isWeekday && hour >= start && hour < end;
}

function todayInTz(tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

async function getSentToday(env: Env, day: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT sent FROM daily_counters WHERE day = ?1`,
  )
    .bind(day)
    .first<{ sent: number }>();
  return row?.sent ?? 0;
}
