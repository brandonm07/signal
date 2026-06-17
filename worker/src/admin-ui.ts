// Admin UI for Signal Advisory billing.
// Single-page server-rendered HTML; auth via httpOnly cookie containing the
// admin secret. Mounted at /admin/ui/* on api.signaladvise.com.

import type { Env } from "./types";
import {
  handleCreateClient,
  handleCreateInvoice,
  handleSendInvoice,
  handleVoidInvoice,
  type ClientRow,
  type InvoiceRow,
  type LineItemRow,
} from "./invoices";
import { escapeHtml as esc, getState, nowSec, safeEqual, signToken, verifyToken } from "./shared";
import { runCallBrief } from "./callbrief";
import { pollInbound } from "./inbound";

const COOKIE_NAME = "sa_admin";
const SESSION_TTL_SECONDS = 86400; // 24h admin session

// ---------- entry ----------

export async function handleAdminUi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/admin\/ui\/?/, "/");

  // Login routes don't require auth
  if (path === "/login" && req.method === "POST") return await handleLogin(req, env);
  if (path === "/logout") return handleLogout();

  if (!(await isAuthed(req, env))) {
    if (path === "/" || path === "/login") {
      return html(loginPageHtml(url.searchParams.get("err")), 200);
    }
    return Response.redirect(`${url.origin}/admin/ui/`, 302);
  }

  // Authed routes
  if (path === "/") return await serveControlCenter(env, url.searchParams.get("flash"));
  if (path === "/run/brief" && req.method === "POST") {
    await runCallBrief(env);
    return Response.redirect(`${url.origin}/admin/ui/?flash=${encodeURIComponent("Call brief generated and emailed.")}`, 302);
  }
  if (path === "/run/poll" && req.method === "POST") {
    await pollInbound(env);
    return Response.redirect(`${url.origin}/admin/ui/?flash=${encodeURIComponent("Inbound poll complete.")}`, 302);
  }
  if (path === "/invoices") return await serveInvoiceList(env, url);
  if (path === "/invoices/new" && req.method === "GET") return await serveInvoiceNewForm(env, url.searchParams.get("err"));
  if (path === "/invoices/new" && req.method === "POST") return await handleInvoiceNewSubmit(req, env);
  const invDetail = path.match(/^\/invoices\/(\d+)$/);
  if (invDetail) return await serveInvoiceDetail(parseInt(invDetail[1], 10), env, url.searchParams.get("flash"));
  const invSend = path.match(/^\/invoices\/(\d+)\/send$/);
  if (invSend && req.method === "POST") return await handleInvoiceSendSubmit(parseInt(invSend[1], 10), env);
  const invVoid = path.match(/^\/invoices\/(\d+)\/void$/);
  if (invVoid && req.method === "POST") return await handleInvoiceVoidSubmit(parseInt(invVoid[1], 10), env);

  if (path === "/clients") return await serveClientList(env);
  if (path === "/clients/new" && req.method === "GET") return await serveClientNewForm(url.searchParams.get("err"));
  if (path === "/clients/new" && req.method === "POST") return await handleClientNewSubmit(req, env);
  const cliDetail = path.match(/^\/clients\/(\d+)$/);
  if (cliDetail) return await serveClientDetail(parseInt(cliDetail[1], 10), env);
  const cliStatus = path.match(/^\/clients\/(\d+)\/status$/);
  if (cliStatus && req.method === "POST") return await handleClientStatusToggle(parseInt(cliStatus[1], 10), req, env);

  if (path === "/contracts") return await serveContractList(env, url.searchParams.get("flash"));
  if (path === "/contracts/new" && req.method === "GET") return await serveContractNewForm(env, url.searchParams.get("err"));
  if (path === "/contracts/new" && req.method === "POST") return await handleContractNewSubmit(req, env);
  const cxDelete = path.match(/^\/contracts\/(\d+)\/delete$/);
  if (cxDelete && req.method === "POST") return await handleContractDelete(parseInt(cxDelete[1], 10), env);

  return html(`<h1>Not found</h1>`, 404);
}

// ---------- auth ----------

// The cookie holds an HMAC-signed, expiring session token — never the admin
// secret itself. A leaked cookie expires in 24h; the secret never leaves the
// server side, and rotating ADMIN_SECRET invalidates every session.
async function isAuthed(req: Request, env: Env): Promise<boolean> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies[COOKIE_NAME];
  if (!token || !env.ADMIN_SECRET) return false;
  const payload = await verifyToken(env.ADMIN_SECRET, token);
  return payload?.adm === true;
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = decodeURIComponent(part.slice(eq + 1).trim());
    out[k] = v;
  }
  return out;
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

  // Brute-force throttle: max 5 failed attempts per IP in last 15 minutes.
  const recentFails = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM login_attempts
       WHERE ip = ?1 AND outcome = 'fail' AND attempted_at > unixepoch() - 900`,
  )
    .bind(ip)
    .first<{ n: number }>();
  if (recentFails && recentFails.n >= 5) {
    return Response.redirect(
      new URL(req.url).origin + "/admin/ui/?err=" + encodeURIComponent("Too many failed attempts. Wait 15 minutes."),
      302,
    );
  }

  const form = await req.formData();
  const provided = String(form.get("secret") ?? "");

  // Constant-time compare to avoid timing-based secret extraction.
  const ok = Boolean(provided && env.ADMIN_SECRET && safeEqual(provided, env.ADMIN_SECRET));

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, outcome) VALUES (?1, ?2)`,
  )
    .bind(ip, ok ? "ok" : "fail")
    .run();

  if (!ok) {
    return Response.redirect(new URL(req.url).origin + "/admin/ui/?err=Invalid+secret", 302);
  }
  const session = await signToken(env.ADMIN_SECRET, {
    adm: true,
    exp: nowSec() + SESSION_TTL_SECONDS,
  });
  const cookie = `${COOKIE_NAME}=${session}; Path=/admin/ui; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(req.url).origin + "/admin/ui/",
      "Set-Cookie": cookie,
    },
  });
}

function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin/ui/",
      "Set-Cookie": `${COOKIE_NAME}=; Path=/admin/ui; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    },
  });
}

// ---------- shared HTML chrome ----------

function layout(title: string, body: string, opts: { flash?: string | null; activeNav?: string } = {}): string {
  const flash = opts.flash ? `<div class="flash">${esc(opts.flash)}</div>` : "";
  const nav = (label: string, href: string) => {
    const active = opts.activeNav === label.toLowerCase() ? "active" : "";
    return `<a href="${href}" class="${active}">${label}</a>`;
  };
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)} · Signal Advisory</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#faf7f1;color:#1a1f24;margin:0;line-height:1.55}
  .topbar{background:#1a1f24;color:#faf7f1;padding:14px 24px;display:flex;align-items:center;gap:24px}
  .topbar .brand{font-family:Georgia,serif;font-size:18px;font-weight:500}
  .topbar nav{display:flex;gap:18px;flex:1}
  .topbar nav a{color:#faf7f1;opacity:0.65;text-decoration:none;font-size:14px}
  .topbar nav a:hover, .topbar nav a.active{opacity:1;color:#fff}
  .topbar .right{font-size:13px;opacity:0.6}
  .topbar .right a{color:#faf7f1;text-decoration:underline;opacity:0.7}
  .container{max-width:1080px;margin:0 auto;padding:32px 24px}
  h1{font-family:Georgia,serif;font-weight:500;font-size:28px;margin:0 0 24px}
  h2{font-family:Georgia,serif;font-weight:500;font-size:20px;margin:24px 0 12px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3ddd0;border-radius:6px;overflow:hidden}
  th{text-align:left;padding:10px 14px;background:#f7f1e2;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7a7067;border-bottom:1px solid #e3ddd0}
  td{padding:12px 14px;border-bottom:1px solid #f1ecdf;font-size:14px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  td.amount{font-variant-numeric:tabular-nums;text-align:right}
  td.mono{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}
  .badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;font-weight:600}
  .badge.draft{background:#efe9d9;color:#7a7067}
  .badge.sent{background:#fef3ef;color:#c9462c}
  .badge.paid{background:#e0eddb;color:#2f4a3c}
  .badge.void{background:#e3ddd0;color:#999;text-decoration:line-through}
  .badge.active{background:#e0eddb;color:#2f4a3c}
  .badge.prospect{background:#fef3ef;color:#c9462c}
  .actions{display:flex;gap:8px;flex-wrap:wrap}
  .btn{display:inline-block;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:500;border:1px solid transparent;cursor:pointer;font-family:inherit}
  .btn.primary{background:#c9462c;color:#faf7f1}
  .btn.primary:hover{background:#1a1f24}
  .btn.secondary{background:#fff;color:#1a1f24;border:1px solid #ddd5c2}
  .btn.secondary:hover{border-color:#1a1f24}
  .btn.danger{background:#fff;color:#c9462c;border:1px solid #c9462c}
  .btn.danger:hover{background:#c9462c;color:#fff}
  .card{background:#fff;border:1px solid #e3ddd0;border-radius:6px;padding:24px;margin-bottom:16px}
  .card-title{font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7a7067;margin:0 0 8px}
  form.stacked{background:#fff;border:1px solid #e3ddd0;border-radius:6px;padding:24px}
  label{display:block;font-size:12px;color:#7a7067;letter-spacing:0.1em;text-transform:uppercase;margin:14px 0 6px}
  label:first-child{margin-top:0}
  input[type=text], input[type=email], input[type=number], input[type=tel], textarea, select{width:100%;padding:10px 12px;border:1px solid #ddd5c2;border-radius:4px;font-size:14px;font-family:inherit;background:#fff;color:#1a1f24}
  input:focus, textarea:focus, select:focus{outline:none;border-color:#c9462c}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .row-actions{margin-top:24px;display:flex;gap:12px}
  .flash{background:#e0eddb;border:1px solid #b5cba6;color:#2f4a3c;padding:12px 16px;border-radius:4px;margin-bottom:24px;font-size:14px}
  .err{background:#fef3ef;border:1px solid #f0c4b3;color:#c9462c;padding:12px 16px;border-radius:4px;margin-bottom:24px;font-size:14px}
  .empty{padding:48px 24px;text-align:center;color:#7a7067;background:#fff;border:1px solid #e3ddd0;border-radius:6px}
  .stack-form-row{display:flex;gap:8px;align-items:flex-end;margin-bottom:8px}
  .stack-form-row > div{flex:1}
  .stack-form-row label{margin-top:0}
  .stack-form-row .small{flex:0 0 100px}
  .remove-btn{background:transparent;border:none;color:#c9462c;font-size:18px;cursor:pointer;padding:8px}
  a{color:#c9462c}
  a:hover{text-decoration:underline}
  .meta-grid{display:grid;grid-template-columns:120px 1fr;gap:8px 16px;font-size:14px}
  .meta-grid .label-cell{color:#7a7067;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;align-self:center}
</style>
</head><body>
<header class="topbar">
  <span class="brand">Signal Advisory</span>
  <nav>
    ${nav("Command", "/admin/ui/")}
    ${nav("Invoices", "/admin/ui/invoices")}
    ${nav("Clients", "/admin/ui/clients")}
    ${nav("Contracts", "/admin/ui/contracts")}
  </nav>
  <span class="right">brandon@signaladvise.com · <form method="POST" action="/admin/ui/logout" style="display:inline"><button class="btn secondary" style="padding:4px 10px;font-size:12px">Log out</button></form></span>
</header>
<main class="container">
  ${flash}
  ${body}
</main>
</body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Defense-in-depth headers for the admin UI (logged-in surface).
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      // Restrictive CSP — admin UI uses inline styles + minimal inline JS
      // (the line-item add button), so 'unsafe-inline' is required for now.
      "content-security-policy":
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "cache-control": "no-store, max-age=0",
    },
  });
}

function money(cents: number, currency = "usd"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;
}

function fmtDate(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ---------- login page ----------

function loginPageHtml(err: string | null): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signal Advisory · Admin</title>
<style>
  body{font-family:-apple-system,Helvetica,sans-serif;background:#1a1f24;color:#faf7f1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:#faf7f1;color:#1a1f24;padding:40px;border-radius:8px;max-width:380px;width:90%}
  .brand{font-family:Georgia,serif;font-size:24px;margin-bottom:6px}
  .sub{color:#7a7067;font-size:13px;margin-bottom:28px}
  label{display:block;font-size:12px;color:#7a7067;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px}
  input{width:100%;padding:12px;border:1px solid #ddd5c2;border-radius:4px;font-size:14px;box-sizing:border-box;font-family:inherit}
  input:focus{outline:none;border-color:#c9462c}
  button{width:100%;background:#c9462c;color:#faf7f1;padding:12px;border:none;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;margin-top:16px;font-family:inherit}
  button:hover{background:#1a1f24}
  .err{background:#fef3ef;border:1px solid #f0c4b3;color:#c9462c;padding:10px 12px;border-radius:4px;font-size:13px;margin-bottom:16px}
</style>
</head><body>
<div class="box">
  <div class="brand">Signal Advisory</div>
  <div class="sub">Admin portal</div>
  ${err ? `<div class="err">${esc(err)}</div>` : ""}
  <form method="POST" action="/admin/ui/login">
    <label for="secret">Admin secret</label>
    <input type="password" id="secret" name="secret" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

// ---------- invoices list ----------

interface InvoiceListRow extends InvoiceRow {
  company_legal_name: string;
}

async function serveInvoiceList(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get("status");
  const where = status ? `WHERE i.status = ?1` : "";
  const stmt = env.DB.prepare(
    `SELECT i.*, c.company_legal_name FROM invoices i
       JOIN clients c ON c.id = i.client_id
       ${where}
       ORDER BY i.created_at DESC LIMIT 100`,
  );
  const result = status ? await stmt.bind(status).all<InvoiceListRow>() : await stmt.all<InvoiceListRow>();
  const rows = result.results;

  const tableRows = rows.length === 0
    ? `<tr><td colspan="6"><div class="empty">No invoices yet. <a href="/admin/ui/invoices/new">Create the first one</a>.</div></td></tr>`
    : rows.map((r) => `
        <tr>
          <td class="mono"><a href="/admin/ui/invoices/${r.id}">${esc(r.invoice_number)}</a></td>
          <td>${esc(r.company_legal_name)}</td>
          <td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td>
          <td>${fmtDate(r.due_date)}</td>
          <td>${r.paid_at ? fmtDate(r.paid_at) : "—"}</td>
          <td class="amount">${money(r.total_cents, r.currency)}</td>
        </tr>
      `).join("");

  const body = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h1>Invoices</h1>
      <a href="/admin/ui/invoices/new" class="btn primary">+ New invoice</a>
    </div>
    <table>
      <thead><tr><th>Number</th><th>Client</th><th>Status</th><th>Due</th><th>Paid</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
  return html(layout("Invoices", body, { activeNav: "invoices" }));
}

// ---------- invoice detail ----------

async function serveInvoiceDetail(invoiceId: number, env: Env, flash: string | null): Promise<Response> {
  const inv = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`).bind(invoiceId).first<InvoiceRow>();
  if (!inv) return html(layout("Not found", "<h1>Invoice not found</h1>"), 404);
  const client = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?1`).bind(inv.client_id).first<ClientRow>();
  const lines = await env.DB.prepare(`SELECT * FROM invoice_line_items WHERE invoice_id = ?1 ORDER BY position ASC`).bind(invoiceId).all<LineItemRow>();

  const linesHtml = lines.results.map((l) => `
    <tr>
      <td>${esc(l.description)}</td>
      <td class="amount">${l.quantity}</td>
      <td class="amount">${money(l.unit_amount_cents)}</td>
      <td class="amount">${money(l.amount_cents)}</td>
    </tr>
  `).join("");

  const canSend = inv.status === "draft" || inv.status === "sent";
  const canVoid = inv.status === "draft" || inv.status === "sent";

  const customerLink = `https://api.signaladvise.com/i/${inv.view_token}`;

  const actions = `
    <div class="actions" style="margin-top:24px">
      ${canSend ? `<form method="POST" action="/admin/ui/invoices/${inv.id}/send" style="display:inline"><button class="btn primary" type="submit">${inv.sent_at ? "Re-send" : "Send"} to client</button></form>` : ""}
      ${canVoid ? `<form method="POST" action="/admin/ui/invoices/${inv.id}/void" style="display:inline" onsubmit="return confirm('Void this invoice? This cannot be undone.')"><button class="btn danger" type="submit">Void</button></form>` : ""}
      <a href="${customerLink}" target="_blank" class="btn secondary">Open customer view ↗</a>
    </div>
  `;

  const body = `
    <p style="margin-bottom:8px"><a href="/admin/ui/invoices">← All invoices</a></p>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <h1 style="margin:0">${esc(inv.invoice_number)}</h1>
      <span class="badge ${esc(inv.status)}">${esc(inv.status)}</span>
    </div>

    <div class="card">
      <p class="card-title">Summary</p>
      <div class="meta-grid">
        <div class="label-cell">Client</div><div><a href="/admin/ui/clients/${client?.id}">${esc(client?.company_legal_name ?? "?")}</a> · ${esc(client?.email)}</div>
        <div class="label-cell">Description</div><div>${esc(inv.description) || "—"}</div>
        <div class="label-cell">Subtotal</div><div class="amount" style="text-align:left">${money(inv.subtotal_cents, inv.currency)}</div>
        <div class="label-cell">Tax</div><div class="amount" style="text-align:left">${money(inv.tax_cents, inv.currency)}</div>
        <div class="label-cell">Total</div><div class="amount" style="text-align:left;font-weight:600;font-size:18px">${money(inv.total_cents, inv.currency)}</div>
        <div class="label-cell">Issued</div><div>${fmtDate(inv.created_at)}</div>
        <div class="label-cell">Due</div><div>${fmtDate(inv.due_date)}</div>
        <div class="label-cell">Sent</div><div>${fmtDate(inv.sent_at)}</div>
        <div class="label-cell">Paid</div><div>${fmtDate(inv.paid_at)}</div>
        ${inv.voided_at ? `<div class="label-cell">Voided</div><div>${fmtDate(inv.voided_at)}</div>` : ""}
      </div>
    </div>

    <div class="card">
      <p class="card-title">Line items</p>
      <table>
        <thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${linesHtml}</tbody>
      </table>
    </div>

    <div class="card">
      <p class="card-title">Stripe</p>
      <div class="meta-grid">
        <div class="label-cell">Customer</div><div class="mono">${esc(inv.stripe_customer_id) || "—"}</div>
        <div class="label-cell">Checkout</div><div class="mono">${esc(inv.stripe_checkout_session_id) || "— (created when customer clicks pay)"}</div>
        <div class="label-cell">PaymentIntent</div><div class="mono">${esc(inv.stripe_payment_intent_id) || "—"}</div>
      </div>
    </div>

    ${actions}
  `;

  return html(layout(inv.invoice_number, body, { activeNav: "invoices", flash }));
}

// ---------- new invoice form ----------

async function serveInvoiceNewForm(env: Env, err: string | null): Promise<Response> {
  const clientsRes = await env.DB.prepare(`SELECT id, company_legal_name, email FROM clients ORDER BY company_legal_name ASC`).all<{ id: number; company_legal_name: string; email: string }>();
  const clientOptions = clientsRes.results.map((c) => `<option value="${c.id}">${esc(c.company_legal_name)} · ${esc(c.email)}</option>`).join("");
  const body = `
    <p style="margin-bottom:8px"><a href="/admin/ui/invoices">← All invoices</a></p>
    <h1>New invoice</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    ${clientsRes.results.length === 0 ? `<div class="err">No clients yet. <a href="/admin/ui/clients/new">Add a client first</a>, then come back to create the invoice.</div>` : `
    <form method="POST" action="/admin/ui/invoices/new" class="stacked">
      <label for="client_id">Client</label>
      <select id="client_id" name="client_id" required>
        <option value="">Select a client…</option>
        ${clientOptions}
      </select>

      <label for="description">Description (optional)</label>
      <input type="text" id="description" name="description" placeholder="e.g. Contract review · Spectrum carrier renewal">

      <label>Line items</label>
      <div id="lines">
        ${lineItemRowHtml(0)}
      </div>
      <button type="button" class="btn secondary" id="add-line" style="margin-top:8px">+ Add another line</button>

      <label for="due_in_days">Due in (days)</label>
      <input type="number" id="due_in_days" name="due_in_days" value="30" min="1" max="365">

      <div class="row-actions">
        <button type="submit" class="btn primary">Create invoice</button>
        <a href="/admin/ui/invoices" class="btn secondary">Cancel</a>
      </div>
    </form>
    <script>
      let n = 1;
      document.getElementById('add-line').addEventListener('click', () => {
        const wrap = document.getElementById('lines');
        const div = document.createElement('div');
        div.innerHTML = ${JSON.stringify(lineItemRowTemplate())}.replace(/{i}/g, n);
        wrap.appendChild(div.firstChild);
        n++;
      });
      document.addEventListener('click', (e) => {
        if (e.target.classList && e.target.classList.contains('remove-btn')) {
          e.target.closest('.stack-form-row').remove();
        }
      });
    </script>
    `}
  `;
  return html(layout("New invoice", body, { activeNav: "invoices" }));
}

function lineItemRowTemplate(): string {
  return `<div class="stack-form-row">
    <div><label>Description</label><input type="text" name="line_description_{i}" required placeholder="e.g. Initial contract review"></div>
    <div class="small"><label>Qty</label><input type="number" name="line_quantity_{i}" value="1" min="1" required></div>
    <div class="small"><label>Unit ($)</label><input type="number" name="line_unit_dollars_{i}" step="0.01" min="0.01" required placeholder="2500.00"></div>
    <button type="button" class="remove-btn" title="Remove">×</button>
  </div>`;
}

function lineItemRowHtml(i: number): string {
  return lineItemRowTemplate().replace(/{i}/g, String(i));
}

async function handleInvoiceNewSubmit(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const clientId = parseInt(String(form.get("client_id") ?? "0"), 10);
  const description = String(form.get("description") ?? "");
  const dueDays = parseInt(String(form.get("due_in_days") ?? "30"), 10);

  // Collect line items by scanning numbered fields
  const lineItems: Array<{ description: string; quantity: number; unit_amount_cents: number }> = [];
  for (const [k, v] of form.entries()) {
    const m = k.match(/^line_description_(\d+)$/);
    if (!m) continue;
    const i = m[1];
    const desc = String(v).trim();
    const qty = parseInt(String(form.get(`line_quantity_${i}`) ?? "1"), 10);
    const unitDollars = parseFloat(String(form.get(`line_unit_dollars_${i}`) ?? "0"));
    if (!desc || !Number.isFinite(unitDollars) || unitDollars <= 0 || qty <= 0) continue;
    lineItems.push({ description: desc, quantity: qty, unit_amount_cents: Math.round(unitDollars * 100) });
  }
  if (clientId <= 0 || lineItems.length === 0) {
    return Response.redirect(new URL(req.url).origin + "/admin/ui/invoices/new?err=" + encodeURIComponent("Client and at least one line item required"), 302);
  }
  // Call the existing API handler. Build a fake JSON request.
  const fakeReq = new Request("https://internal/admin/invoices", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": env.ADMIN_SECRET },
    body: JSON.stringify({ client_id: clientId, description: description || undefined, line_items: lineItems, due_in_days: dueDays }),
  });
  const apiRes = await handleCreateInvoice(fakeReq, env);
  if (apiRes.status >= 300) {
    const errBody = await apiRes.text();
    return Response.redirect(new URL(req.url).origin + "/admin/ui/invoices/new?err=" + encodeURIComponent(errBody.slice(0, 200)), 302);
  }
  const data = (await apiRes.json()) as { id: number };
  return Response.redirect(new URL(req.url).origin + `/admin/ui/invoices/${data.id}?flash=Invoice+created.+Click+Send+to+email+the+client.`, 302);
}

async function handleInvoiceSendSubmit(id: number, env: Env): Promise<Response> {
  const apiRes = await handleSendInvoice(id, env);
  const ok = apiRes.status < 300;
  return Response.redirect(`https://api.signaladvise.com/admin/ui/invoices/${id}?flash=` + encodeURIComponent(ok ? "Invoice sent." : "Send failed."), 302);
}

async function handleInvoiceVoidSubmit(id: number, env: Env): Promise<Response> {
  await handleVoidInvoice(id, env);
  return Response.redirect(`https://api.signaladvise.com/admin/ui/invoices/${id}?flash=Invoice+voided.`, 302);
}

// ---------- clients ----------

async function serveClientList(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT * FROM clients ORDER BY company_legal_name ASC`).all<ClientRow>();
  const tableRows = rows.results.length === 0
    ? `<tr><td colspan="5"><div class="empty">No clients yet. <a href="/admin/ui/clients/new">Add your first client</a>.</div></td></tr>`
    : rows.results.map((c) => `
        <tr>
          <td><a href="/admin/ui/clients/${c.id}">${esc(c.company_legal_name)}</a></td>
          <td><span class="badge ${esc(c.status)}">${esc(c.status)}</span></td>
          <td>${esc(c.email)}</td>
          <td>${esc(c.city) || "—"}${c.state ? ", " + esc(c.state) : ""}</td>
          <td class="mono">${esc(c.stripe_customer_id) || "—"}</td>
        </tr>
      `).join("");
  const body = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h1>Clients</h1>
      <a href="/admin/ui/clients/new" class="btn primary">+ New client</a>
    </div>
    <table>
      <thead><tr><th>Company</th><th>Status</th><th>Email</th><th>Location</th><th>Stripe Customer</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
  return html(layout("Clients", body, { activeNav: "clients" }));
}

async function serveClientDetail(clientId: number, env: Env): Promise<Response> {
  const client = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?1`).bind(clientId).first<ClientRow>();
  if (!client) return html(layout("Not found", "<h1>Not found</h1>"), 404);
  const invoices = await env.DB.prepare(`SELECT * FROM invoices WHERE client_id = ?1 ORDER BY created_at DESC`).bind(clientId).all<InvoiceRow>();
  const invRows = invoices.results.length === 0
    ? `<tr><td colspan="5"><div class="empty">No invoices yet for this client.</div></td></tr>`
    : invoices.results.map((i) => `
        <tr>
          <td class="mono"><a href="/admin/ui/invoices/${i.id}">${esc(i.invoice_number)}</a></td>
          <td><span class="badge ${esc(i.status)}">${esc(i.status)}</span></td>
          <td>${fmtDate(i.due_date)}</td>
          <td>${fmtDate(i.paid_at)}</td>
          <td class="amount">${money(i.total_cents, i.currency)}</td>
        </tr>
      `).join("");
  const body = `
    <p style="margin-bottom:8px"><a href="/admin/ui/clients">← All clients</a></p>
    <h1>${esc(client.company_legal_name)}</h1>
    <div class="card">
      <p class="card-title">Contact</p>
      <div class="meta-grid">
        <div class="label-cell">Status</div><div>
          <span class="badge ${esc(client.status)}">${esc(client.status)}</span>
          <form method="POST" action="/admin/ui/clients/${client.id}/status" style="display:inline;margin-left:8px">
            <button class="btn secondary" style="padding:3px 10px;font-size:12px">Mark ${client.status === "prospect" ? "active" : "prospect"}</button>
          </form>
        </div>
        <div class="label-cell">Signatory</div><div>${esc(client.signatory_name) || "—"}${client.signatory_title ? ", " + esc(client.signatory_title) : ""}</div>
        <div class="label-cell">Email</div><div><a href="mailto:${esc(client.email)}">${esc(client.email)}</a></div>
        <div class="label-cell">Phone</div><div>${esc(client.phone) || "—"}</div>
        <div class="label-cell">Address</div><div>${[client.address_line1, client.address_line2].filter(Boolean).map(esc).join("<br>")}${client.city ? "<br>" + esc(client.city) + ", " + esc(client.state || "") + " " + esc(client.postal_code || "") : ""}</div>
        <div class="label-cell">Stripe ID</div><div class="mono">${esc(client.stripe_customer_id) || "—"}</div>
        <div class="label-cell">MSA signed</div><div>${fmtDate(client.msa_signed_at)}</div>
      </div>
    </div>
    <h2>Invoices</h2>
    <table>
      <thead><tr><th>Number</th><th>Status</th><th>Due</th><th>Paid</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${invRows}</tbody>
    </table>
    <div style="margin-top:16px"><a href="/admin/ui/invoices/new" class="btn primary">+ New invoice for ${esc(client.company_legal_name)}</a></div>
  `;
  return html(layout(client.company_legal_name, body, { activeNav: "clients" }));
}

async function handleClientStatusToggle(clientId: number, req: Request, env: Env): Promise<Response> {
  await env.DB.prepare(
    `UPDATE clients
        SET status = CASE status WHEN 'prospect' THEN 'active' ELSE 'prospect' END,
            updated_at = unixepoch()
      WHERE id = ?1`,
  )
    .bind(clientId)
    .run();
  return Response.redirect(new URL(req.url).origin + `/admin/ui/clients/${clientId}`, 302);
}

async function serveClientNewForm(err: string | null): Promise<Response> {
  const body = `
    <p style="margin-bottom:8px"><a href="/admin/ui/clients">← All clients</a></p>
    <h1>New client</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <form method="POST" action="/admin/ui/clients/new" class="stacked">
      <label for="company_legal_name">Legal company name *</label>
      <input type="text" id="company_legal_name" name="company_legal_name" required placeholder="e.g. Acme Manufacturing Inc.">

      <div class="grid">
        <div>
          <label for="signatory_name">Primary contact name</label>
          <input type="text" id="signatory_name" name="signatory_name" placeholder="Jane Doe">
        </div>
        <div>
          <label for="signatory_title">Title</label>
          <input type="text" id="signatory_title" name="signatory_title" placeholder="VP of IT">
        </div>
      </div>

      <div class="grid">
        <div>
          <label for="email">Billing email *</label>
          <input type="email" id="email" name="email" required placeholder="ap@acmemfg.com">
        </div>
        <div>
          <label for="phone">Phone</label>
          <input type="tel" id="phone" name="phone" placeholder="816-555-1234">
        </div>
      </div>

      <label for="address_line1">Street address</label>
      <input type="text" id="address_line1" name="address_line1" placeholder="1234 Industrial Pkwy">

      <input type="text" name="address_line2" placeholder="Suite, unit, etc. (optional)" style="margin-top:8px">

      <div class="grid" style="grid-template-columns:2fr 1fr 1fr">
        <div>
          <label for="city">City</label>
          <input type="text" id="city" name="city">
        </div>
        <div>
          <label for="state">State</label>
          <input type="text" id="state" name="state" placeholder="MO">
        </div>
        <div>
          <label for="postal_code">ZIP</label>
          <input type="text" id="postal_code" name="postal_code">
        </div>
      </div>

      <div class="grid">
        <div>
          <label for="ein_last_four">EIN last 4 (optional)</label>
          <input type="text" id="ein_last_four" name="ein_last_four" maxlength="4">
        </div>
        <div>
          <label for="msa_signed_date">MSA signed date (optional)</label>
          <input type="text" id="msa_signed_date" name="msa_signed_date" placeholder="YYYY-MM-DD">
        </div>
      </div>

      <label for="notes">Notes (optional)</label>
      <textarea id="notes" name="notes" rows="3" placeholder="Engagement details, special billing terms, etc."></textarea>

      <div class="row-actions">
        <button type="submit" class="btn primary">Create client</button>
        <a href="/admin/ui/clients" class="btn secondary">Cancel</a>
      </div>
    </form>
  `;
  return html(layout("New client", body, { activeNav: "clients" }));
}

async function handleClientNewSubmit(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const msaDate = String(form.get("msa_signed_date") ?? "").trim();
  const msaSignedAt = msaDate ? Math.floor(new Date(msaDate + "T12:00:00Z").getTime() / 1000) : undefined;
  const payload: Record<string, unknown> = {
    company_legal_name: String(form.get("company_legal_name") ?? "").trim(),
    signatory_name: String(form.get("signatory_name") ?? "").trim() || undefined,
    signatory_title: String(form.get("signatory_title") ?? "").trim() || undefined,
    email: String(form.get("email") ?? "").trim().toLowerCase(),
    phone: String(form.get("phone") ?? "").trim() || undefined,
    address_line1: String(form.get("address_line1") ?? "").trim() || undefined,
    address_line2: String(form.get("address_line2") ?? "").trim() || undefined,
    city: String(form.get("city") ?? "").trim() || undefined,
    state: String(form.get("state") ?? "").trim() || undefined,
    postal_code: String(form.get("postal_code") ?? "").trim() || undefined,
    country: "US",
    ein_last_four: String(form.get("ein_last_four") ?? "").trim() || undefined,
    msa_signed_at: msaSignedAt,
    notes: String(form.get("notes") ?? "").trim() || undefined,
  };
  const fakeReq = new Request("https://internal/admin/clients", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": env.ADMIN_SECRET },
    body: JSON.stringify(payload),
  });
  const apiRes = await handleCreateClient(fakeReq, env);
  if (apiRes.status >= 300) {
    const errBody = await apiRes.text();
    return Response.redirect(new URL(req.url).origin + "/admin/ui/clients/new?err=" + encodeURIComponent(errBody.slice(0, 200)), 302);
  }
  const data = (await apiRes.json()) as { id: number };
  return Response.redirect(new URL(req.url).origin + `/admin/ui/clients/${data.id}`, 302);
}

// ---------- contracts ----------

interface ContractListRow {
  id: number;
  client_id: number;
  client_name: string;
  provider: string;
  service_type: string;
  monthly_spend_cents: number;
  contract_expiration: number;
  auto_renew_notice_days: number;
  alerted_180_at: number | null;
  alerted_90_at: number | null;
  alerted_30_at: number | null;
}

async function serveContractList(env: Env, flash: string | null): Promise<Response> {
  const rs = await env.DB.prepare(
    `SELECT cc.id, cc.client_id, cc.provider, cc.service_type, cc.monthly_spend_cents,
            cc.contract_expiration, cc.auto_renew_notice_days,
            cc.alerted_180_at, cc.alerted_90_at, cc.alerted_30_at,
            c.company_legal_name AS client_name
       FROM client_contracts cc
       JOIN clients c ON c.id = cc.client_id
      ORDER BY cc.contract_expiration ASC`,
  ).all<ContractListRow>();
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const rows = rs.results ?? [];
  const tableBody = rows.length === 0
    ? `<tr><td colspan="7"><div class="empty">No contracts tracked yet. <a href="/admin/ui/contracts/new">Add the first one</a>.</div></td></tr>`
    : rows.map((r) => {
        const daysOut = Math.round((r.contract_expiration - now) / day);
        let badge = "";
        if (daysOut < 0) badge = `<span class="badge void">Expired</span>`;
        else if (daysOut <= 30) badge = `<span class="badge sent">${daysOut}d</span>`;
        else if (daysOut <= 90) badge = `<span class="badge draft">${daysOut}d</span>`;
        else if (daysOut <= 180) badge = `<span class="badge draft">${daysOut}d</span>`;
        else badge = `<span class="badge paid">${daysOut}d</span>`;
        const spend = money(r.monthly_spend_cents, "usd");
        return `<tr>
          <td><a href="/admin/ui/clients/${r.client_id}">${esc(r.client_name)}</a></td>
          <td>${esc(r.provider)}</td>
          <td>${esc(r.service_type)}</td>
          <td class="amount">${spend}/mo</td>
          <td>${fmtDate(r.contract_expiration)}</td>
          <td>${badge}</td>
          <td><form method="POST" action="/admin/ui/contracts/${r.id}/delete" style="display:inline" onsubmit="return confirm('Delete this contract?')"><button class="btn danger" style="padding:4px 10px;font-size:12px">Delete</button></form></td>
        </tr>`;
      }).join("");
  const body = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <h1 style="margin:0">Contracts</h1>
      <a href="/admin/ui/contracts/new" class="btn primary">+ New contract</a>
    </div>
    <p style="color:#7a7067;font-size:13px;margin:0 0 16px">Renewal-defense alerts fire automatically at 180, 90, and 30 days before expiration.</p>
    <table>
      <thead><tr><th>Client</th><th>Provider</th><th>Service</th><th style="text-align:right">Monthly</th><th>Expires</th><th>Days out</th><th></th></tr></thead>
      <tbody>${tableBody}</tbody>
    </table>`;
  return html(layout("Contracts", body, { flash, activeNav: "contracts" }));
}

async function serveContractNewForm(env: Env, err: string | null): Promise<Response> {
  const clientsRes = await env.DB.prepare(
    `SELECT id, company_legal_name FROM clients ORDER BY company_legal_name`,
  ).all<{ id: number; company_legal_name: string }>();
  const clientOptions = (clientsRes.results ?? [])
    .map((c) => `<option value="${c.id}">${esc(c.company_legal_name)}</option>`)
    .join("");
  const body = `
    <p style="margin-bottom:8px"><a href="/admin/ui/contracts">← All contracts</a></p>
    <h1>New contract</h1>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    ${clientsRes.results.length === 0 ? `<div class="err">No clients yet. <a href="/admin/ui/clients/new">Add a client first</a>.</div>` : `
    <form method="POST" action="/admin/ui/contracts/new" class="stacked">
      <label>Client</label>
      <select name="client_id" required>${clientOptions}</select>

      <div class="grid">
        <div>
          <label>Provider</label>
          <input type="text" name="provider" placeholder="Comcast Business" required>
        </div>
        <div>
          <label>Service type</label>
          <select name="service_type" required>
            <option value="internet">Internet</option>
            <option value="voice">Voice / UCaaS</option>
            <option value="mobile">Mobile</option>
            <option value="cloud">Cloud</option>
            <option value="security">Security</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>

      <div class="grid">
        <div>
          <label>Monthly spend (USD)</label>
          <input type="number" name="monthly_spend" min="0" step="0.01" placeholder="1250.00" required>
        </div>
        <div>
          <label>Contract expiration</label>
          <input type="date" name="contract_expiration" required>
        </div>
      </div>

      <div class="grid">
        <div>
          <label>Contract start (optional)</label>
          <input type="date" name="contract_start">
        </div>
        <div>
          <label>Auto-renew notice required (days)</label>
          <input type="number" name="auto_renew_notice_days" min="0" max="365" value="0">
        </div>
      </div>

      <label>Notes</label>
      <textarea name="notes" rows="3" placeholder="Anything to remember at renewal time."></textarea>

      <div class="row-actions">
        <button type="submit" class="btn primary">Save contract</button>
        <a href="/admin/ui/contracts" class="btn secondary">Cancel</a>
      </div>
    </form>`}`;
  return html(layout("New contract", body, { activeNav: "contracts" }));
}

async function handleContractNewSubmit(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const clientId = parseInt(String(form.get("client_id") ?? ""), 10);
  const provider = String(form.get("provider") ?? "").trim();
  const serviceType = String(form.get("service_type") ?? "").trim();
  const monthlySpend = parseFloat(String(form.get("monthly_spend") ?? "0"));
  const expirationStr = String(form.get("contract_expiration") ?? "");
  const startStr = String(form.get("contract_start") ?? "");
  const noticeDays = parseInt(String(form.get("auto_renew_notice_days") ?? "0"), 10);
  const notes = String(form.get("notes") ?? "").trim() || null;

  const origin = new URL(req.url).origin;
  if (!clientId || !provider || !serviceType || !expirationStr || Number.isNaN(monthlySpend)) {
    return Response.redirect(origin + "/admin/ui/contracts/new?err=" + encodeURIComponent("Missing required fields"), 302);
  }
  const expirationEpoch = Math.floor(new Date(expirationStr + "T12:00:00Z").getTime() / 1000);
  const startEpoch = startStr ? Math.floor(new Date(startStr + "T12:00:00Z").getTime() / 1000) : null;
  const monthlyCents = Math.round(monthlySpend * 100);

  await env.DB.prepare(
    `INSERT INTO client_contracts
       (client_id, provider, service_type, monthly_spend_cents, contract_start,
        contract_expiration, auto_renew_notice_days, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(clientId, provider, serviceType, monthlyCents, startEpoch, expirationEpoch, noticeDays, notes).run();

  return Response.redirect(origin + "/admin/ui/contracts?flash=" + encodeURIComponent("Contract saved."), 302);
}

async function handleContractDelete(id: number, env: Env): Promise<Response> {
  await env.DB.prepare(`DELETE FROM client_contracts WHERE id = ?1`).bind(id).run();
  // Response.redirect() requires an absolute URL in the Workers runtime —
  // a relative path throws a TypeError at request time.
  return Response.redirect(
    "https://api.signaladvise.com/admin/ui/contracts?flash=" +
      encodeURIComponent("Contract deleted."),
    302,
  );
}

// ---------- control center (landing dashboard) ----------

// Aggregates the whole operation onto one page: live ops health, pipeline,
// client/revenue, and system controls. Read-mostly; the only writes are the
// two safe action buttons (call brief, inbound poll) which call exported
// functions directly. Never touches the send pipeline's internals.
async function serveControlCenter(env: Env, flash: string | null): Promise<Response> {
  const day = 86400;
  const today = todayInTzCC(env.SEND_WINDOW_TZ);
  const cap = parseInt(env.DAILY_CAP || "0", 10);

  // --- run a batch of independent aggregates ---
  const one = async <T>(sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
  const many = async <T>(sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql).bind(...binds).all<T>()).results ?? [];

  const sentToday = (await one<{ n: number }>(
    `SELECT sent n FROM daily_counters WHERE day = ?1`, today))?.n ?? 0;
  const lastSend = (await one<{ t: number }>(
    `SELECT MAX(attempted_at) t FROM send_log WHERE outcome='sent'`))?.t ?? null;

  const leadStatus = await many<{ status: string; n: number }>(
    `SELECT status, COUNT(*) n FROM leads GROUP BY status`);
  const ls: Record<string, number> = {};
  for (const r of leadStatus) ls[r.status] = r.n;

  const scoredCounts = (await one<{ scored: number; unscored: number }>(
    `SELECT
        SUM(CASE WHEN lead_score IS NOT NULL AND lead_score >= 0 THEN 1 ELSE 0 END) scored,
        SUM(CASE WHEN lead_score IS NULL THEN 1 ELSE 0 END) unscored
      FROM leads`)) ?? { scored: 0, unscored: 0 };

  // 7-day funnel
  const wk = 7 * day;
  const sent7 = (await one<{ n: number }>(
    `SELECT COUNT(*) n FROM send_log WHERE outcome='sent' AND attempted_at > unixepoch()-?1`, wk))?.n ?? 0;
  const ev7 = await many<{ event_type: string; n: number }>(
    `SELECT event_type, COUNT(DISTINCT recipient) n FROM email_events WHERE created_at > unixepoch()-?1 GROUP BY event_type`, wk);
  const ev: Record<string, number> = {};
  for (const r of ev7) ev[r.event_type] = r.n;
  const replies7 = await many<{ intent: string; n: number }>(
    `SELECT intent, COUNT(*) n FROM replies WHERE received_at > unixepoch()-?1 GROUP BY intent`, wk);
  const rep: Record<string, number> = {};
  let totalReplies7 = 0;
  for (const r of replies7) { rep[r.intent] = r.n; totalReplies7 += r.n; }

  // last-run timestamps from worker_state
  const lastRun = async (k: string) => await getState(env, k);
  const [lastHealth, lastBackup, lastScore, lastBrief, lastRenewal] = await Promise.all([
    lastRun("last_healthcheck_ts"), lastRun("last_backup_ts"), lastRun("last_score_run_ts"),
    lastRun("last_call_brief_ts"), lastRun("last_renewal_check_ts"),
  ]);

  // top warm leads (opens then score)
  const warm = await many<{ first_name: string; company: string; email: string; lead_score: number; lead_tier: string; opens: number; opening_angle: string }>(
    `SELECT l.first_name, l.company, l.email, l.lead_score, l.lead_tier, l.opening_angle,
            COALESCE(e.opens,0) opens
       FROM leads l
       LEFT JOIN (SELECT recipient, COUNT(*) opens FROM email_events WHERE event_type='opened' GROUP BY recipient) e
         ON e.recipient = l.email
      WHERE l.sent_at IS NOT NULL AND l.status NOT IN ('unsubscribed','bounced')
      ORDER BY opens DESC, l.lead_score DESC NULLS LAST LIMIT 6`);

  // clients + revenue
  const clientCounts = await many<{ status: string; n: number }>(
    `SELECT status, COUNT(*) n FROM clients GROUP BY status`);
  const cc: Record<string, number> = {};
  for (const r of clientCounts) cc[r.status] = r.n;
  const contractAgg = (await one<{ n: number; spend: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(monthly_spend_cents),0) spend FROM client_contracts`)) ?? { n: 0, spend: 0 };
  const invByStatus = await many<{ status: string; n: number; total: number }>(
    `SELECT status, COUNT(*) n, COALESCE(SUM(total_cents),0) total FROM invoices GROUP BY status`);
  const invMap: Record<string, { n: number; total: number }> = {};
  let invoicedTotal = 0, paidTotal = 0;
  for (const r of invByStatus) {
    invMap[r.status] = { n: r.n, total: r.total };
    invoicedTotal += r.total;
    if (r.status === "paid") paidTotal += r.total;
  }
  const recentSignups = await many<{ company_legal_name: string; email: string; created_at: number }>(
    `SELECT company_legal_name, email, created_at FROM clients WHERE status='prospect' ORDER BY created_at DESC LIMIT 5`);

  // failures
  const failed = (await one<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE status='failed'`))?.n ?? 0;
  const recentErrors = await many<{ error: string; attempted_at: number }>(
    `SELECT error, attempted_at FROM send_log WHERE outcome='error' AND attempted_at > unixepoch()-?1 ORDER BY attempted_at DESC LIMIT 5`, wk);

  // --- render ---
  const ago = (t: number | null) => {
    if (!t) return `<span style="color:#c9462c">never</span>`;
    const s = nowSec() - t;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < day) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / day)}d ago`;
  };
  const stale = (t: number | null, maxHours: number) => t && (nowSec() - t) > maxHours * 3600;
  const sendDotOk = sentToday >= cap && cap > 0;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

  const kpi = (num: string, label: string, color = "#1a1f24") =>
    `<div class="card" style="margin:0"><div style="font-family:Georgia,serif;font-size:30px;font-weight:500;color:${color}">${num}</div><div class="card-title" style="margin:6px 0 0">${esc(label)}</div></div>`;

  const warmRows = warm.length
    ? warm.map((w) => {
        const heat = w.opens >= 2 ? `<span class="badge sent">HOT ${w.opens}x</span>` :
          w.opens === 1 ? `<span class="badge draft">opened</span>` : `<span class="badge void">cold</span>`;
        return `<tr><td>${esc(w.first_name || "")} · ${esc(w.company || "?")}</td>` +
          `<td class="mono">${esc(w.email)}</td>` +
          `<td>${w.lead_score ?? "—"} ${esc(w.lead_tier || "")}</td><td>${heat}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4" class="empty" style="border:0">No contacted leads yet.</td></tr>`;

  const signupRows = recentSignups.length
    ? recentSignups.map((s) => `<tr><td>${esc(s.company_legal_name)}</td><td class="mono">${esc(s.email)}</td><td>${fmtDate(s.created_at)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty" style="border:0">No portal signups yet.</td></tr>`;

  const errorRows = recentErrors.length
    ? recentErrors.map((e) => `<tr><td>${fmtDate(e.attempted_at)}</td><td class="mono" style="color:#c9462c">${esc((e.error || "").slice(0, 120))}</td></tr>`).join("")
    : `<tr><td colspan="2" class="empty" style="border:0">No send errors in the last 7 days.</td></tr>`;

  const body = `
  <h1>Command center</h1>

  <h2>Today</h2>
  <div class="grid" style="grid-template-columns:repeat(4,1fr)">
    ${kpi(`${sentToday} / ${cap}`, "emails sent today", sendDotOk ? "#2f4a3c" : "#c9462c")}
    ${kpi(ago(lastSend), "last send")}
    ${kpi(`${ls["queued"] ?? 0}`, "leads queued")}
    ${kpi(`${scoredCounts.unscored ?? 0}`, "leads unscored")}
  </div>

  <h2>Automation health</h2>
  <table>
    <thead><tr><th>Job</th><th>Last run</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>Daily send (cron + safety net)</td><td>${ago(lastSend)}</td><td>${sendDotOk ? `<span class="badge paid">cap met</span>` : `<span class="badge sent">${sentToday}/${cap} today</span>`}</td></tr>
      <tr><td>Lead scoring</td><td>${ago(lastScore)}</td><td>${stale(lastScore, 36) ? `<span class="badge sent">stale</span>` : `<span class="badge paid">ok</span>`}</td></tr>
      <tr><td>Call brief</td><td>${ago(lastBrief)}</td><td>${stale(lastBrief, 36) ? `<span class="badge sent">stale</span>` : `<span class="badge paid">ok</span>`}</td></tr>
      <tr><td>Renewal defense</td><td>${ago(lastRenewal)}</td><td>${stale(lastRenewal, 36) ? `<span class="badge draft">idle</span>` : `<span class="badge paid">ok</span>`}</td></tr>
      <tr><td>Healthcheck</td><td>${ago(lastHealth)}</td><td>${stale(lastHealth, 36) ? `<span class="badge sent">stale</span>` : `<span class="badge paid">ok</span>`}</td></tr>
      <tr><td>Weekly backup</td><td>${ago(lastBackup)}</td><td>${stale(lastBackup, 8 * 24) ? `<span class="badge sent">stale</span>` : `<span class="badge paid">ok</span>`}</td></tr>
    </tbody>
  </table>

  <h2>Outreach, last 7 days</h2>
  <div class="grid" style="grid-template-columns:repeat(5,1fr)">
    ${kpi(`${sent7}`, "sent")}
    ${kpi(`${ev["delivered"] ?? 0}`, "delivered")}
    ${kpi(`${ev["opened"] ?? 0}`, `opened (${pct(ev["opened"] ?? 0, sent7)})`)}
    ${kpi(`${totalReplies7}`, `replies (${pct(totalReplies7, sent7)})`, totalReplies7 > 0 ? "#2f4a3c" : "#1a1f24")}
    ${kpi(`${rep["meeting"] ?? 0}`, "meeting / positive", (rep["meeting"] ?? 0) > 0 ? "#2f4a3c" : "#1a1f24")}
  </div>

  <h2>Warmest prospects</h2>
  <table>
    <thead><tr><th>Who</th><th>Email</th><th>Score</th><th>Engagement</th></tr></thead>
    <tbody>${warmRows}</tbody>
  </table>

  <h2>Clients &amp; revenue</h2>
  <div class="grid" style="grid-template-columns:repeat(4,1fr)">
    ${kpi(`${(cc["active"] ?? 0)}`, "active clients")}
    ${kpi(`${(cc["prospect"] ?? 0)}`, "portal prospects")}
    ${kpi(money(invoicedTotal), "total invoiced")}
    ${kpi(money(paidTotal), "collected", "#2f4a3c")}
  </div>
  <div class="grid" style="grid-template-columns:repeat(3,1fr);margin-top:16px">
    ${kpi(`${contractAgg.n}`, "contracts tracked")}
    ${kpi(money(contractAgg.spend), "client monthly spend")}
    ${kpi(`${(invMap["sent"]?.n ?? 0)}`, "invoices awaiting payment")}
  </div>
  <h2 style="font-size:16px">Recent portal signups</h2>
  <table><thead><tr><th>Company</th><th>Email</th><th>When</th></tr></thead><tbody>${signupRows}</tbody></table>

  <h2>System controls</h2>
  <div class="card">
    <div class="card-title">Live settings</div>
    <div class="meta-grid">
      <div class="label-cell">Daily cap</div><div>${esc(env.DAILY_CAP)}</div>
      <div class="label-cell">Open tracking</div><div>${env.OPEN_TRACKING === "1" ? "on" : "off"}</div>
      <div class="label-cell">Reply mode</div><div>${env.DRAFT_MODE === "1" ? "draft (human review)" : "auto-send"}</div>
      <div class="label-cell">Send window</div><div>${esc(env.SEND_WINDOW_START_HOUR)}:00 to ${esc(env.SEND_WINDOW_END_HOUR)}:00 ${esc(env.SEND_WINDOW_TZ)}</div>
    </div>
    <p style="font-size:12px;color:#7a7067;margin:14px 0 0">Settings change via <span class="mono">wrangler.toml</span> + deploy. To send a batch on demand, the safety-net routine and <span class="mono">/admin/tick</span> are the supported paths.</p>
    <div class="actions" style="margin-top:16px">
      <form method="POST" action="/admin/ui/run/brief" style="display:inline"><button class="btn primary" type="submit">Generate call brief now</button></form>
      <form method="POST" action="/admin/ui/run/poll" style="display:inline"><button class="btn secondary" type="submit">Poll inbound now</button></form>
      <a class="btn secondary" href="/admin/ui/contracts">Renewal radar</a>
      <a class="btn secondary" href="/admin/ui/invoices/new">New invoice</a>
    </div>
  </div>

  <h2 style="font-size:16px">Failures</h2>
  <p style="font-size:13px;color:${failed > 0 ? "#c9462c" : "#7a7067"};margin:0 0 10px">${failed} lead(s) in failed state.</p>
  <table><thead><tr><th>When</th><th>Last send errors (7d)</th></tr></thead><tbody>${errorRows}</tbody></table>
  `;
  return html(layout("Command center", body, { flash, activeNav: "command" }));
}

// Local TZ-day helper (admin-ui has no import of the index.ts version).
function todayInTzCC(tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}
