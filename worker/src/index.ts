import type { Env, Lead, QueueJob } from "./types";
import { buildEmail, sendViaResend } from "./email";
import { pollInbound } from "./inbound";

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
    if (url.pathname === "/u" || url.pathname === "/u/") {
      return handleUnsubscribe(url, env);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/webhook/resend" && req.method === "POST") {
      return handleResendWebhook(req, env);
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
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE leads
            SET status = 'sent', sent_at = unixepoch(),
                resend_message_id = ?2, updated_at = unixepoch()
          WHERE id = ?1`,
      ).bind(lead.id, resp.id),
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
