import type { Env, Lead, QueueJob } from "./types";
import { buildEmail, sendViaResend } from "./email";
import { pollInbound } from "./inbound";
import { runPeriodicMaintenance } from "./health";
import { SEQUENCE_STEPS } from "./sequence";

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Run outbound + inbound + periodic maintenance concurrently.
    ctx.waitUntil(
      Promise.allSettled([
        tick(env).catch((e) => console.error("tick failed", e)),
        pollInbound(env).catch((e) => console.error("pollInbound failed", e)),
        runPeriodicMaintenance(env).catch((e) => console.error("maintenance failed", e)),
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
    if (url.pathname.startsWith("/upload/")) {
      const token = url.pathname.slice("/upload/".length);
      if (req.method === "GET") return serveUploadPage(token, env);
      if (req.method === "POST") return handleUploadSubmission(token, req, env);
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
      const dlMatch = url.pathname.match(/^\/admin\/audit\/(\d+)\/download$/);
      if (dlMatch) {
        return handleAdminDownload(parseInt(dlMatch[1], 10), env);
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

  // Generate a single-use upload token for this request.
  const uploadToken = randomHex(16);
  const uploadUrl = `https://api.signaladvise.com/upload/${uploadToken}`;

  await env.DB.prepare(
    `INSERT INTO audit_requests (first_name, company, email, carrier, notes, upload_token)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(first_name, company, email.toLowerCase(), carrier, notes, uploadToken)
    .run();

  // Notify Brandon with the link he can forward.
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
      `Their upload link (already sent to them automatically):\n${uploadUrl}\n\n` +
      `You'll get a notification email when they upload.`,
  });

  // Confirmation to prospect, with the actual upload link.
  await sendNotification(env, {
    to: email,
    subject: `Your invoice audit — upload link inside`,
    text:
      `Hi ${first_name},\n\n` +
      `Thanks for the audit request. Here's your secure upload link:\n\n` +
      `${uploadUrl}\n\n` +
      `Drop in your most recent carrier invoice (PDF, image, or CSV — up to 20MB). The link is single-use and expires in 7 days.\n\n` +
      `Once I have the invoice, you'll get the marked-up version back the next business day.\n\n` +
      `Brandon\n` +
      `Principal Advisor\n` +
      `Signal Advisory\n` +
      `brandon@signaladvise.com · 816.721.6501`,
  });

  return jsonResponse({ ok: true }, 200);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface AuditRow {
  id: number;
  first_name: string;
  company: string;
  email: string;
  upload_token: string | null;
  uploaded_at: number | null;
  r2_key: string | null;
  created_at: number;
}

async function lookupAudit(env: Env, token: string): Promise<AuditRow | null> {
  return await env.DB.prepare(
    `SELECT id, first_name, company, email, upload_token, uploaded_at, r2_key, created_at
       FROM audit_requests WHERE upload_token = ?1`,
  )
    .bind(token)
    .first<AuditRow>();
}

function escapeHtmlMini(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function uploadPageHtml(opts: { token: string; firstName: string; expired?: boolean; alreadyUploaded?: boolean }): string {
  const base = `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><title>Upload your invoice — Signal Advisory</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;background:#faf7f1;color:#1a1f24;max-width:560px;margin:60px auto;padding:0 24px;line-height:1.55}
      h1{font-family:Georgia,serif;font-weight:500;font-size:32px;margin:0 0 8px}
      .sub{color:#7a7067;margin-bottom:32px;font-size:15px}
      .drop{border:2px dashed #c9462c;border-radius:6px;padding:48px 24px;text-align:center;background:#fff;cursor:pointer;transition:background .15s}
      .drop:hover,.drop.dragover{background:#fef3ef}
      .drop p{margin:0 0 4px;color:#1a1f24}
      .drop .hint{color:#7a7067;font-size:13px;margin-top:8px}
      input[type=file]{display:none}
      .btn{display:inline-block;background:#c9462c;color:#faf7f1;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:600;font-size:14px;cursor:pointer;border:none;font-family:inherit;margin-top:24px}
      .btn:hover{background:#1a1f24}
      .btn:disabled{opacity:.5;cursor:not-allowed}
      .status{margin-top:16px;font-size:14px}
      .ok{color:#2f4a3c;font-weight:600}
      .err{color:#c9462c;font-weight:600}
      .info{color:#7a7067;font-size:13px;margin-top:16px}
      .done{background:#fff;border:1px solid #ddd5c2;border-radius:6px;padding:32px;text-align:center}
    </style></head><body>`;
  const foot = `</body></html>`;
  if (opts.expired) {
    return base + `<h1>Link expired</h1><p class="sub">This upload link is no longer valid. Reply to your audit confirmation email and I'll send a fresh one. — Brandon</p>` + foot;
  }
  if (opts.alreadyUploaded) {
    return base + `<div class="done"><h1 style="color:#2f4a3c">✓ Already received</h1><p>Your invoice came through. I'll reply with the marked-up version within one business day.</p><p class="info">— Brandon, Signal Advisory</p></div>` + foot;
  }
  return base + `
    <h1>Upload your invoice${opts.firstName ? ', ' + escapeHtmlMini(opts.firstName) : ''}</h1>
    <p class="sub">Drag in your most recent carrier invoice. PDF, image, CSV, or Excel — up to 20MB. Single-use, encrypted in transit. You'll get the marked-up version back within one business day.</p>
    <form id="f" enctype="multipart/form-data">
      <label class="drop" id="drop">
        <p><strong>Drop a file here, or click to browse</strong></p>
        <p class="hint">PDF, JPG, PNG, CSV, XLSX · max 20MB</p>
        <input type="file" id="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.csv,.xlsx,.xls" required>
        <div id="fname" class="hint" style="margin-top:12px;color:#1a1f24"></div>
      </label>
      <button type="submit" id="submit" class="btn" disabled>Upload</button>
      <div id="status" class="status"></div>
      <p class="info">Powered by Signal Advisory. Files are stored encrypted and accessible only to the Signal Advisory team.</p>
    </form>
    <script>
      const drop=document.getElementById('drop'),file=document.getElementById('file'),fname=document.getElementById('fname'),btn=document.getElementById('submit'),status=document.getElementById('status'),form=document.getElementById('f');
      function show(f){if(!f)return;fname.textContent=f.name+' ('+Math.round(f.size/1024)+' KB)';btn.disabled=f.size>20*1024*1024;if(f.size>20*1024*1024){status.className='status err';status.textContent='File too large. Max 20MB.';}else{status.textContent='';}}
      file.addEventListener('change',()=>show(file.files[0]));
      ['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('dragover')}));
      ['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('dragover')}));
      drop.addEventListener('drop',ev=>{const f=ev.dataTransfer.files[0];if(f){file.files=ev.dataTransfer.files;show(f);}});
      form.addEventListener('submit',async ev=>{
        ev.preventDefault();
        if(!file.files[0])return;
        btn.disabled=true;btn.textContent='Uploading…';status.className='status';status.textContent='';
        const fd=new FormData();fd.append('file',file.files[0]);
        try{
          const res=await fetch(location.pathname,{method:'POST',body:fd});
          if(res.ok){status.className='status ok';status.textContent='✓ Uploaded. Brandon will reply within one business day.';btn.style.display='none';drop.style.display='none';}
          else{const t=await res.text();throw new Error(t||'upload failed')}
        }catch(e){status.className='status err';status.textContent='Upload failed: '+e.message+'. Email info@signaladvise.com and we will pick it up.';btn.disabled=false;btn.textContent='Upload';}
      });
    </script>` + foot;
}

const UPLOAD_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

async function serveUploadPage(token: string, env: Env): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return new Response(uploadPageHtml({ token, firstName: "", expired: true }), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const row = await lookupAudit(env, token);
  if (!row) {
    return new Response(uploadPageHtml({ token, firstName: "", expired: true }), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - row.created_at;
  if (ageSeconds > UPLOAD_TOKEN_TTL_SECONDS) {
    return new Response(uploadPageHtml({ token, firstName: row.first_name, expired: true }), {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (row.uploaded_at) {
    return new Response(
      uploadPageHtml({ token, firstName: row.first_name, alreadyUploaded: true }),
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  return new Response(uploadPageHtml({ token, firstName: row.first_name }), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleUploadSubmission(
  token: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return new Response("invalid token", { status: 404 });
  }
  const row = await lookupAudit(env, token);
  if (!row) return new Response("invalid token", { status: 404 });
  const ageSeconds = Math.floor(Date.now() / 1000) - row.created_at;
  if (ageSeconds > UPLOAD_TOKEN_TTL_SECONDS) {
    return new Response("link expired", { status: 410 });
  }
  if (row.uploaded_at) return new Response("already uploaded", { status: 409 });

  const form = await req.formData();
  const file = form.get("file") as unknown as
    | { name: string; size: number; type: string; stream(): ReadableStream }
    | null;
  if (!file || typeof file !== "object" || !("stream" in file)) {
    return new Response("missing file", { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return new Response("file too large", { status: 413 });
  }

  // Sanitize filename and prefix with audit id + timestamp for uniqueness.
  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const r2Key = `audit-${row.id}/${Date.now()}-${cleanName}`;

  await env.AUDIT_UPLOADS.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: {
      auditId: String(row.id),
      company: row.company,
      email: row.email,
      originalFilename: file.name,
    },
  });

  await env.DB.prepare(
    `UPDATE audit_requests SET uploaded_at = unixepoch(), uploaded_filename = ?2,
       uploaded_size = ?3, r2_key = ?4, status = 'uploaded'
     WHERE id = ?1`,
  )
    .bind(row.id, file.name, file.size, r2Key)
    .run();

  // Notify Brandon with a download link.
  const downloadUrl = `https://api.signaladvise.com/admin/audit/${row.id}/download`;
  await sendNotification(env, {
    to: "brandon@signaladvise.com",
    subject: `Audit upload received — ${row.company} (${row.first_name})`,
    text:
      `New invoice uploaded for the audit request from ${row.first_name} at ${row.company}.\n\n` +
      `Filename: ${file.name}\n` +
      `Size: ${Math.round(file.size / 1024)} KB\n` +
      `Type: ${file.type || "unknown"}\n\n` +
      `Download (requires admin secret):\n${downloadUrl}\n\n` +
      `Or download from R2 dashboard:\nBucket signal-audit-uploads · Key ${r2Key}\n\n` +
      `Reply to ${row.email} with the marked-up version within one business day.`,
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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

async function handleAdminDownload(auditId: number, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r2_key, uploaded_filename FROM audit_requests WHERE id = ?1`,
  )
    .bind(auditId)
    .first<{ r2_key: string | null; uploaded_filename: string | null }>();
  if (!row || !row.r2_key) return new Response("not found", { status: 404 });
  const obj = await env.AUDIT_UPLOADS.get(row.r2_key);
  if (!obj) return new Response("file missing", { status: 410 });
  const filename = row.uploaded_filename || "invoice";
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    },
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
