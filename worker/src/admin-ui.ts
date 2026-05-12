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

const COOKIE_NAME = "sa_admin";

// ---------- entry ----------

export async function handleAdminUi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/admin\/ui\/?/, "/");

  // Login routes don't require auth
  if (path === "/login" && req.method === "POST") return await handleLogin(req, env);
  if (path === "/logout") return handleLogout();

  if (!isAuthed(req, env)) {
    if (path === "/" || path === "/login") {
      return html(loginPageHtml(url.searchParams.get("err")), 200);
    }
    return Response.redirect(`${url.origin}/admin/ui/`, 302);
  }

  // Authed routes
  if (path === "/" || path === "/invoices") return await serveInvoiceList(env, url);
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

  return html(`<h1>Not found</h1>`, 404);
}

// ---------- auth ----------

function isAuthed(req: Request, env: Env): boolean {
  const cookies = parseCookies(req.headers.get("cookie"));
  const provided = cookies[COOKIE_NAME];
  if (!provided || !env.ADMIN_SECRET) return false;
  // Constant-time string compare
  if (provided.length !== env.ADMIN_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ env.ADMIN_SECRET.charCodeAt(i);
  return diff === 0;
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
  let ok = false;
  if (provided && env.ADMIN_SECRET && provided.length === env.ADMIN_SECRET.length) {
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ env.ADMIN_SECRET.charCodeAt(i);
    }
    ok = diff === 0;
  }

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, outcome) VALUES (?1, ?2)`,
  )
    .bind(ip, ok ? "ok" : "fail")
    .run();

  if (!ok) {
    return Response.redirect(new URL(req.url).origin + "/admin/ui/?err=Invalid+secret", 302);
  }
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(provided)}; Path=/admin/ui; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(req.url).origin + "/admin/ui/invoices",
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
    ${nav("Invoices", "/admin/ui/invoices")}
    ${nav("Clients", "/admin/ui/clients")}
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

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    ? `<tr><td colspan="4"><div class="empty">No clients yet. <a href="/admin/ui/clients/new">Add your first client</a>.</div></td></tr>`
    : rows.results.map((c) => `
        <tr>
          <td><a href="/admin/ui/clients/${c.id}">${esc(c.company_legal_name)}</a></td>
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
      <thead><tr><th>Company</th><th>Email</th><th>Location</th><th>Stripe Customer</th></tr></thead>
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
