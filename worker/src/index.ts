import type { Env, Lead, QueueJob } from "./types";
import { buildEmail, sendViaResend, ResendError } from "./email";
import { pollInbound } from "./inbound";
import { runPeriodicMaintenance } from "./health";
import { nextSequenceState } from "./sequence";
import {
  escapeHtml,
  notifyOwner,
  randomHex,
  safeEqual,
  sendEmail,
  verifySvix,
} from "./shared";
import {
  handleCreateClient,
  handleCreateInvoice,
  handleSendInvoice,
  handleVoidInvoice,
  serveInvoicePage,
  handlePayInvoice,
  handleStripeWebhook,
} from "./invoices";
import { handleAdminUi } from "./admin-ui";
import { handlePortal } from "./portal";
import { runCallBrief } from "./callbrief";

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
      return handleUnsubscribe(url, req, env);
    }
    const openMatch = url.pathname.match(/^\/o\/([a-f0-9]{32})\.gif$/);
    if (openMatch) {
      return handleOpenPixel(openMatch[1], env);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    // --- Client portal (magic-link auth, read-only dashboard) ---
    if (url.pathname === "/portal" || url.pathname.startsWith("/portal/")) {
      return handlePortal(req, env);
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
    // --- Billing: public invoice view + pay redirect ---
    const viewMatch = url.pathname.match(/^\/i\/([a-f0-9]{32})$/);
    if (viewMatch && req.method === "GET") {
      return serveInvoicePage(viewMatch[1], env);
    }
    const payMatch = url.pathname.match(/^\/i\/([a-f0-9]{32})\/pay$/);
    if (payMatch) {
      return handlePayInvoice(payMatch[1], env);
    }
    // --- Billing: Stripe webhook (no admin auth — uses HMAC) ---
    if (url.pathname === "/webhook/stripe" && req.method === "POST") {
      return handleStripeWebhook(req, env);
    }
    // --- Admin UI (cookie-auth, browser-friendly) ---
    if (url.pathname === "/admin/ui" || url.pathname.startsWith("/admin/ui/")) {
      return handleAdminUi(req, env);
    }
    if (url.pathname.startsWith("/admin/")) {
      const secret = req.headers.get("x-admin-secret");
      if (!env.ADMIN_SECRET || !secret || !safeEqual(secret, env.ADMIN_SECRET)) {
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
      if (url.pathname === "/admin/brief") {
        ctx.waitUntil(runCallBrief(env));
        return new Response("call brief triggered", { status: 202 });
      }
      const dlMatch = url.pathname.match(/^\/admin\/audit\/(\d+)\/download$/);
      if (dlMatch) {
        return handleAdminDownload(parseInt(dlMatch[1], 10), env);
      }
      // --- Billing admin ---
      if (url.pathname === "/admin/clients" && req.method === "POST") {
        return handleCreateClient(req, env);
      }
      if (url.pathname === "/admin/invoices" && req.method === "POST") {
        return handleCreateInvoice(req, env);
      }
      const sendMatch = url.pathname.match(/^\/admin\/invoices\/(\d+)\/send$/);
      if (sendMatch && req.method === "POST") {
        return handleSendInvoice(parseInt(sendMatch[1], 10), env);
      }
      const voidMatch = url.pathname.match(/^\/admin\/invoices\/(\d+)\/void$/);
      if (voidMatch && req.method === "POST") {
        return handleVoidInvoice(parseInt(voidMatch[1], 10), env);
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
  // Send only if this lead still holds the claim tick() took ('sending').
  // This single guard closes three races: a duplicate queue delivery after a
  // successful send (status already advanced to 'queued'/'completed'), a
  // retry after a permanent failure (status 'failed'), and an unsubscribe or
  // bounce that landed between claim and delivery.
  if (lead.status !== "sending") return;

  const currentStep = lead.step ?? 1;

  // Template assembly failures are permanent — retrying can't fix a missing
  // template, and an endless retry loop would strand the lead.
  let msg: ReturnType<typeof buildEmail>;
  try {
    msg = buildEmail(lead, env);
  } catch (err) {
    await markSendFailed(env, lead.id, err instanceof Error ? err.message : String(err));
    return;
  }

  let resp: { id: string };
  try {
    // The idempotency key makes Resend dedupe any repeat of (lead, step) for
    // 24h — at-most-once delivery even if we crash between send and DB write.
    resp = await sendViaResend(msg, env.RESEND_API_KEY, `lead-${lead.id}-step-${currentStep}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const permanent =
      err instanceof ResendError && err.status >= 400 && err.status < 500 && err.status !== 429;
    if (permanent) {
      // 4xx (bad recipient, invalid payload): retrying cannot succeed.
      await markSendFailed(env, lead.id, errMsg);
      return;
    }
    // Transient (5xx / 429 / network): log and rethrow so the queue retries.
    // The lead stays in 'sending'; if retries exhaust into the DLQ, the
    // maintenance sweeper returns it to 'queued' after an hour.
    try {
      await env.DB.prepare(
        `INSERT INTO send_log (lead_id, outcome, error) VALUES (?1, 'error', ?2)`,
      ).bind(lead.id, errMsg).run();
    } catch {
      // Logging must not mask the original failure.
    }
    throw err;
  }

  const today = todayInTz(env.SEND_WINDOW_TZ);
  const next = nextSequenceState(currentStep, Math.floor(Date.now() / 1000));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE leads
          SET status = ?2, sent_at = unixepoch(),
              resend_message_id = ?3, step = ?4,
              scheduled_for = ?5, updated_at = unixepoch()
        WHERE id = ?1`,
    ).bind(lead.id, next.status, resp.id, next.step, next.scheduledFor),
    env.DB.prepare(
      `INSERT INTO send_log (lead_id, outcome, resend_message_id)
         VALUES (?1, 'sent', ?2)`,
    ).bind(lead.id, resp.id),
    env.DB.prepare(
      `INSERT INTO daily_counters (day, sent) VALUES (?1, 1)
         ON CONFLICT(day) DO UPDATE SET sent = sent + 1`,
    ).bind(today),
  ]);
  // If the batch above throws, the queue retries: the lead is still 'sending'
  // so the guard passes, and the idempotency key turns the repeat Resend call
  // into a no-op that returns the same message id — the batch then completes.
}

async function markSendFailed(env: Env, leadId: number, errMsg: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE leads SET status = 'failed', error = ?2, updated_at = unixepoch()
        WHERE id = ?1`,
    ).bind(leadId, errMsg),
    env.DB.prepare(
      `INSERT INTO send_log (lead_id, outcome, error) VALUES (?1, 'error', ?2)`,
    ).bind(leadId, errMsg),
  ]);
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
  // This endpoint is unauthenticated and triggers outbound email, so it gets
  // the same IP throttle as the portal: 5 requests per IP per 15 minutes.
  // Without it, a script could use our domain (and Resend reputation) to
  // bomb arbitrary inboxes.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM login_attempts
       WHERE ip = ?1 AND outcome = 'audit_intake' AND attempted_at > unixepoch() - 900`,
  )
    .bind(ip)
    .first<{ n: number }>();
  if (recent && recent.n >= 5) {
    return jsonResponse({ error: "too many requests — try again in 15 minutes" }, 429);
  }
  await env.DB.prepare(`INSERT INTO login_attempts (ip, outcome) VALUES (?1, 'audit_intake')`)
    .bind(ip)
    .run();

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
  const first_name = String(body.first_name ?? "").trim().slice(0, 120);
  const company = String(body.company ?? "").trim().slice(0, 200);
  const email = String(body.email ?? "").trim().slice(0, 254);
  const carrier = String(body.carrier ?? "").trim().slice(0, 200);
  const notes = String(body.notes ?? "").trim().slice(0, 2000);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !first_name || !company) {
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

  // Confirmation to prospect with the upload link. This one matters — if it
  // fails, the prospect has no link, so surface the failure to the form.
  const prospectOk = await sendEmail(env, {
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
      `brandon@signaladvise.com · 816.355.3350`,
  });

  // Notify Brandon with the link he can forward. Best-effort: the request
  // already exists in audit_requests either way.
  await notifyOwner(
    env,
    `New audit request — ${company} (${first_name})`,
    `New invoice audit request from the website:\n\n` +
      `Name: ${first_name}\n` +
      `Company: ${company}\n` +
      `Email: ${email}\n` +
      `Primary carrier: ${carrier || "—"}\n` +
      `Notes: ${notes || "—"}\n\n` +
      `Their upload link${prospectOk ? " (already sent to them automatically)" : " (their copy FAILED to send — forward this manually)"}:\n${uploadUrl}\n\n` +
      `You'll get a notification email when they upload.`,
  );

  if (!prospectOk) {
    return jsonResponse({ error: "could not send the upload link email" }, 502);
  }
  return jsonResponse({ ok: true }, 200);
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
    <h1>Upload your invoice${opts.firstName ? ', ' + escapeHtml(opts.firstName) : ''}</h1>
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
  await notifyOwner(
    env,
    `Audit upload received — ${row.company} (${row.first_name})`,
    `New invoice uploaded for the audit request from ${row.first_name} at ${row.company}.\n\n` +
      `Filename: ${file.name}\n` +
      `Size: ${Math.round(file.size / 1024)} KB\n` +
      `Type: ${file.type || "unknown"}\n\n` +
      `Download (requires admin secret):\n${downloadUrl}\n\n` +
      `Or download from R2 dashboard:\nBucket signal-audit-uploads · Key ${r2Key}\n\n` +
      `Reply to ${row.email} with the marked-up version within one business day.`,
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
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
  // RFC 5987: ASCII fallback (strip control/quote/path chars) + UTF-8 encoded
  // form, so a crafted filename can't break out of the header.
  const asciiName = filename.replace(/[^\w.\-]/g, "_");
  const utf8Name = encodeURIComponent(filename);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    },
  });
}

async function handleResendWebhook(req: Request, env: Env): Promise<Response> {
  // Resend sends svix-style signed webhooks. Signature verification is MANDATORY —
  // we refuse to process any webhook payload without it.
  if (!env.RESEND_WEBHOOK_SECRET) {
    return new Response("webhook secret not configured", { status: 503 });
  }
  const body = await req.text();
  const ok = await verifySvix(
    {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    body,
    env.RESEND_WEBHOOK_SECRET,
  );
  if (!ok) return new Response("invalid signature", { status: 401 });
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
  } else if (type === "email.delivered" || type === "email.opened" || type === "email.clicked") {
    await env.DB.prepare(
      `INSERT INTO email_events (email_id, recipient, event_type) VALUES (?1, ?2, ?3)`,
    ).bind(evt.data?.email_id ?? null, recipient, type.slice("email.".length)).run();
  }
  return new Response("ok", { status: 200 });
}

async function handleUnsubscribe(url: URL, req: Request, env: Env): Promise<Response> {
  const token = url.searchParams.get("t");
  if (!token) return htmlResponse("Invalid link.", 400);

  // GET only renders a confirmation page; link scanners (Microsoft Defender
  // Safe Links, Proofpoint URL Defense, etc.) prefetch GET URLs and would
  // otherwise auto-unsubscribe valid recipients. POST commits the change.
  if (req.method !== "POST") {
    const exists = await env.DB.prepare(
      `SELECT 1 FROM leads WHERE unsubscribe_token = ?1`,
    )
      .bind(token)
      .first();
    if (!exists) return htmlResponse("Invalid or expired link.", 404);
    return htmlResponse(
      `<h1>Unsubscribe from Signal Advisory</h1>` +
        `<p>Click the button below to stop receiving emails from Signal Advisory.</p>` +
        `<form method="post" action="/u?t=${encodeURIComponent(token)}">` +
        `<button type="submit" style="padding:12px 24px;background:#c9462c;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer">Confirm unsubscribe</button>` +
        `</form>`,
    );
  }

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

// First-party open tracking. A 1x1 transparent GIF fetched by the recipient's
// mail client writes an 'opened' event keyed on the lead (via unsubscribe
// token). Always returns the pixel, even on error, so a tracking miss never
// surfaces to the recipient. Per-hour dedup blunts Apple/Gmail prefetch
// inflation. No auth: it is a public image by design.
async function handleOpenPixel(token: string, env: Env): Promise<Response> {
  const gif = Uint8Array.from(
    atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
    (c) => c.charCodeAt(0),
  );
  const headers = {
    "content-type": "image/gif",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    "pragma": "no-cache",
  };
  try {
    const lead = await env.DB.prepare(
      `SELECT email FROM leads WHERE unsubscribe_token = ?1`,
    )
      .bind(token)
      .first<{ email: string }>();
    if (lead?.email) {
      const recent = await env.DB.prepare(
        `SELECT 1 FROM email_events
           WHERE recipient = ?1 AND event_type = 'opened'
             AND created_at > unixepoch() - 3600 LIMIT 1`,
      )
        .bind(lead.email)
        .first();
      if (!recent) {
        await env.DB.prepare(
          `INSERT INTO email_events (recipient, event_type) VALUES (?1, 'opened')`,
        )
          .bind(lead.email)
          .run();
      }
    }
  } catch {
    // never block the pixel on a DB hiccup
  }
  return new Response(gif, { headers });
}
