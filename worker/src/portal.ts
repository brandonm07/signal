// Client portal: magic-link login, then a live read-only dashboard of the
// client's contracts, invoices, and monthly spend. Mounted at /portal/* on
// api.signaladvise.com. Auth is a stateless HMAC-signed token (keyed on
// PORTAL_SIGNING_SECRET, falling back to ADMIN_SECRET until it is set),
// so email link-scanners cannot consume a one-time login.
import type { Env } from "./types";
import {
  OWNER_EMAIL,
  escapeHtml as esc,
  nowSec,
  sendEmail,
  signToken,
  verifyToken,
} from "./shared";

const HOST = "https://api.signaladvise.com";
const COOKIE = "sa_portal";
const MAGIC_TTL = 15 * 60; // seconds
const SESSION_TTL = 7 * 24 * 60 * 60; // seconds

// Dedicated HMAC key for portal sessions/magic links, falling back to
// ADMIN_SECRET until PORTAL_SIGNING_SECRET is set.
function portalSecret(env: Env): string {
  return env.PORTAL_SIGNING_SECRET || env.ADMIN_SECRET;
}

export async function handlePortal(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/portal";

  if (path === "/portal" && req.method === "GET") return loginPage(null);
  if (path === "/portal/login" && req.method === "POST") return handleLogin(req, env);
  if (path === "/portal/signup" && req.method === "GET") return signupPage(null);
  if (path === "/portal/signup" && req.method === "POST") return handleSignup(req, env);
  if (path === "/portal/auth" && req.method === "GET") return handleAuth(url, env);
  if (path === "/portal/logout") return logout();
  if (path === "/portal/dashboard" && req.method === "GET") return dashboard(req, env);

  return new Response("Not found", { status: 404 });
}

// ---------- auth ----------

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

  // Throttle magic-link sending: max 5 attempts per IP in 15 minutes,
  // so a known client email can't be used to flood inboxes.
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM login_attempts
       WHERE ip = ?1 AND outcome = 'portal_login' AND attempted_at > unixepoch() - 900`,
  )
    .bind(ip)
    .first<{ n: number }>();
  if (recent && recent.n >= 5) {
    return loginPage("Too many attempts. Wait 15 minutes and try again.");
  }
  await env.DB.prepare(`INSERT INTO login_attempts (ip, outcome) VALUES (?1, 'portal_login')`)
    .bind(ip)
    .run();

  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // Always respond the same way, whether or not the email matches a client.
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const client = await env.DB.prepare(
      `SELECT id, company_legal_name FROM clients WHERE lower(email) = ?1`,
    )
      .bind(email)
      .first<{ id: number; company_legal_name: string }>();
    if (client) {
      await sendMagicLink(env, client.id, email);
    }
  }
  return loginPage("If that email is on file, a login link is on its way. Check your inbox.");
}

async function sendMagicLink(env: Env, clientId: number, email: string): Promise<void> {
  const token = await signToken(portalSecret(env), { cid: clientId, exp: nowSec() + MAGIC_TTL });
  const link = `${HOST}/portal/auth?t=${encodeURIComponent(token)}`;
  // Best-effort: the login/signup responses are identical whether or not the
  // email matched a client (no account enumeration), so a Resend failure must
  // log rather than 500 and break that symmetry.
  await sendEmail(env, {
    to: email,
    subject: "Your Signal Advisory dashboard link",
    text:
      `Here is your secure login link for the Signal Advisory client dashboard:\n\n${link}\n\n` +
      `This link is good for 15 minutes. If you did not request it, ignore this email.`,
    html:
      `<p>Here is your secure login link for the Signal Advisory client dashboard:</p>` +
      `<p><a href="${link}">Open my dashboard</a></p>` +
      `<p style="color:#888;font-size:12px">This link is good for 15 minutes. If you did not request it, ignore this email.</p>`,
  });
}

async function handleSignup(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

  // Open endpoint that creates rows and sends email: max 5 attempts per IP
  // in 15 minutes, tracked in the same login_attempts table the admin uses.
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM login_attempts
       WHERE ip = ?1 AND outcome = 'signup' AND attempted_at > unixepoch() - 900`,
  )
    .bind(ip)
    .first<{ n: number }>();
  if (recent && recent.n >= 5) {
    return signupPage("Too many attempts. Wait 15 minutes and try again.");
  }

  const form = await req.formData();
  const company = String(form.get("company") ?? "").trim().slice(0, 200);
  const name = String(form.get("name") ?? "").trim().slice(0, 120);
  const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 254);
  if (!company || !name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return signupPage("Please fill in your company, your name, and a valid email.");
  }

  await env.DB.prepare(`INSERT INTO login_attempts (ip, outcome) VALUES (?1, 'signup')`)
    .bind(ip)
    .run();

  // If the email is already on file, send a login link instead of creating a
  // duplicate. The response is identical either way (no account enumeration).
  const existing = await env.DB.prepare(`SELECT id FROM clients WHERE lower(email) = ?1`)
    .bind(email)
    .first<{ id: number }>();
  let clientId: number;
  if (existing) {
    clientId = existing.id;
  } else {
    const ins = await env.DB.prepare(
      `INSERT INTO clients (company_legal_name, signatory_name, email, status, notes)
         VALUES (?1, ?2, ?3, 'prospect', 'Self-service signup via portal')`,
    )
      .bind(company, name, email)
      .run();
    clientId = Number(ins.meta.last_row_id);
    await sendEmail(env, {
      to: OWNER_EMAIL,
      replyTo: email,
      subject: `New portal signup: ${company}`,
      text:
        `${name} (${email}) created a client account for ${company} via the portal signup page.\n\n` +
        `Manage at ${HOST}/admin/ui/clients`,
      html:
        `<p>${esc(name)} (${esc(email)}) created a client account for <strong>${esc(company)}</strong> via the portal signup page.</p>` +
        `<p><a href="${HOST}/admin/ui/clients">Open admin portal</a></p>`,
    });
  }
  await sendMagicLink(env, clientId, email);
  return signupPage("Check your inbox — your secure login link is on its way.");
}

async function handleAuth(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  const payload = await verifyToken(portalSecret(env), token);
  if (!payload || typeof payload.cid !== "number") {
    return loginPage("That login link is invalid or has expired. Request a new one.");
  }
  const session = await signToken(portalSecret(env), { cid: payload.cid, exp: nowSec() + SESSION_TTL });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${HOST}/portal/dashboard`,
      "Set-Cookie": `${COOKIE}=${session}; Path=/portal; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
    },
  });
}

function logout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${HOST}/portal`,
      "Set-Cookie": `${COOKIE}=; Path=/portal; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}

async function sessionClientId(req: Request, env: Env): Promise<number | null> {
  const cookies = req.headers.get("cookie") ?? "";
  const m = cookies.match(/(?:^|;\s*)sa_portal=([^;]+)/);
  if (!m) return null;
  const payload = await verifyToken(portalSecret(env), decodeURIComponent(m[1]));
  return payload && typeof payload.cid === "number" ? payload.cid : null;
}

// ---------- dashboard ----------

async function dashboard(req: Request, env: Env): Promise<Response> {
  const cid = await sessionClientId(req, env);
  if (!cid) {
    return new Response(null, { status: 302, headers: { Location: `${HOST}/portal` } });
  }

  const client = await env.DB.prepare(
    `SELECT id, company_legal_name FROM clients WHERE id = ?1`,
  )
    .bind(cid)
    .first<{ id: number; company_legal_name: string }>();
  if (!client) return logout();

  const contractsRs = await env.DB.prepare(
    `SELECT provider, service_type, monthly_spend_cents, contract_expiration
       FROM client_contracts WHERE client_id = ?1
       ORDER BY contract_expiration ASC`,
  )
    .bind(cid)
    .all<{ provider: string; service_type: string; monthly_spend_cents: number; contract_expiration: number }>();
  const contracts = contractsRs.results ?? [];

  const invoicesRs = await env.DB.prepare(
    `SELECT invoice_number, description, total_cents, currency, status, view_token, created_at
       FROM invoices WHERE client_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(cid)
    .all<{ invoice_number: string; description: string; total_cents: number; currency: string; status: string; view_token: string; created_at: number }>();
  const invoices = invoicesRs.results ?? [];

  const monthlyTotal = contracts.reduce((s, c) => s + (c.monthly_spend_cents || 0), 0);
  const annualTotal = monthlyTotal * 12;
  const now = nowSec();

  const contractRows = contracts.length
    ? contracts.map((c) => {
        const days = Math.round((c.contract_expiration - now) / 86400);
        const badge =
          days < 0 ? `<span class="b expired">Expired</span>` :
          days <= 90 ? `<span class="b soon">${days}d</span>` :
          `<span class="b ok">${days}d</span>`;
        return `<tr><td>${esc(c.provider)}</td><td>${esc(c.service_type)}</td>` +
          `<td class="r">${money(c.monthly_spend_cents)}/mo</td>` +
          `<td>${fmtDate(c.contract_expiration)}</td><td>${badge}</td></tr>`;
      }).join("")
    : `<tr><td colspan="5" class="empty">No contracts on file yet. Once your advisor builds your inventory, it shows here.</td></tr>`;

  const invoiceRows = invoices.length
    ? invoices.map((i) => {
        const link = i.view_token ? `<a href="${HOST}/i/${i.view_token}">${esc(i.invoice_number)}</a>` : esc(i.invoice_number);
        return `<tr><td>${link}</td><td>${esc(i.description || "")}</td>` +
          `<td class="r">${money(i.total_cents, i.currency)}</td>` +
          `<td><span class="b ${i.status}">${esc(i.status)}</span></td>` +
          `<td>${fmtDate(i.created_at)}</td></tr>`;
      }).join("")
    : `<tr><td colspan="5" class="empty">No invoices yet.</td></tr>`;

  const body = `
    <div class="hd">
      <div>
        <div class="eyebrow">Client dashboard</div>
        <h1>${esc(client.company_legal_name)}</h1>
      </div>
      <form method="POST" action="/portal/logout"><button class="logout">Log out</button></form>
    </div>

    <div class="cards">
      <div class="card"><div class="num">${money(monthlyTotal)}</div><div class="lbl">Tracked monthly spend</div></div>
      <div class="card"><div class="num">${money(annualTotal)}</div><div class="lbl">Annualized</div></div>
      <div class="card"><div class="num">${contracts.length}</div><div class="lbl">Contracts in inventory</div></div>
    </div>

    <h2>Contract inventory</h2>
    <table><thead><tr><th>Provider</th><th>Service</th><th class="r">Monthly</th><th>Renews</th><th>Countdown</th></tr></thead><tbody>${contractRows}</tbody></table>

    <h2>Invoices</h2>
    <table><thead><tr><th>Number</th><th>Description</th><th class="r">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${invoiceRows}</tbody></table>

    <p class="foot">Questions about anything here? Reply to your advisor or email
      <a href="mailto:brandon@signaladvise.com">brandon@signaladvise.com</a>.</p>`;
  return html(shell("Dashboard", body));
}

// ---------- views ----------

function loginPage(flash: string | null): Response {
  const msg = flash ? `<div class="flash">${esc(flash)}</div>` : "";
  const body = `
    <div class="login">
      <div class="mark"></div>
      <h1>Client dashboard</h1>
      <p class="sub">Enter the email on your account. We will send you a secure login link.</p>
      ${msg}
      <form method="POST" action="/portal/login">
        <input type="email" name="email" placeholder="you@company.com" required autofocus>
        <button type="submit">Send my login link</button>
      </form>
      <p class="alt">New here? <a href="/portal/signup">Create your account</a></p>
    </div>`;
  return html(shell("Sign in", body));
}

function signupPage(flash: string | null): Response {
  const msg = flash ? `<div class="flash">${esc(flash)}</div>` : "";
  const body = `
    <div class="login">
      <div class="mark"></div>
      <h1>Create your account</h1>
      <p class="sub">Tell us who you are and we will email you a secure login link. No password needed.</p>
      ${msg}
      <form method="POST" action="/portal/signup">
        <input type="text" name="company" placeholder="Company legal name" maxlength="200" required autofocus>
        <input type="text" name="name" placeholder="Your name" maxlength="120" required>
        <input type="email" name="email" placeholder="you@company.com" required>
        <button type="submit">Create account</button>
      </form>
      <p class="alt">Already have an account? <a href="/portal">Sign in</a></p>
    </div>`;
  return html(shell("Create account", body));
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)} · Signal Advisory</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#faf7f1;color:#1a1f24;margin:0;line-height:1.5}
  .wrap{max-width:920px;margin:0 auto;padding:40px 24px}
  .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:28px}
  .eyebrow{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#7a7067}
  h1{font-family:Georgia,serif;font-weight:500;font-size:28px;margin:4px 0 0}
  h2{font-family:Georgia,serif;font-weight:500;font-size:18px;margin:34px 0 12px}
  .logout{background:#fff;border:1px solid #ddd5c2;border-radius:5px;padding:8px 14px;font-size:13px;cursor:pointer;color:#1a1f24}
  .logout:hover{border-color:#1a1f24}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .card{background:#fff;border:1px solid #e3ddd0;border-radius:8px;padding:20px}
  .card .num{font-family:Georgia,serif;font-size:30px;font-weight:500;color:#c9462c}
  .card .lbl{font-size:12px;color:#7a7067;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3ddd0;border-radius:8px;overflow:hidden}
  th{text-align:left;padding:10px 14px;background:#f7f1e2;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7a7067;border-bottom:1px solid #e3ddd0}
  td{padding:12px 14px;border-bottom:1px solid #f1ecdf;font-size:14px}
  tr:last-child td{border-bottom:none}
  td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
  td a{color:#c9462c;text-decoration:none}
  td a:hover{text-decoration:underline}
  .empty{color:#7a7067;text-align:center;padding:28px}
  .b{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600}
  .b.ok,.b.paid{background:#e0eddb;color:#2f4a3c}
  .b.soon,.b.sent{background:#fef3ef;color:#c9462c}
  .b.expired,.b.void{background:#e3ddd0;color:#999}
  .b.draft{background:#efe9d9;color:#7a7067}
  .foot{margin-top:30px;font-size:13px;color:#7a7067}
  .foot a{color:#c9462c}
  .login{max-width:380px;margin:8vh auto 0;background:#fff;border:1px solid #e3ddd0;border-radius:10px;padding:36px}
  .login .mark{width:48px;height:48px;background:#1a1f24;border-radius:8px;position:relative;margin-bottom:18px}
  .login .mark::before{content:"";position:absolute;left:50%;top:50%;width:7px;height:7px;background:#c9462c;border-radius:50%;transform:translate(-50%,-50%)}
  .login .mark::after{content:"";position:absolute;left:50%;top:50%;width:26px;height:13px;border:2px solid #faf7f1;border-bottom:0;border-radius:26px 26px 0 0;transform:translate(-50%,-50%)}
  .login h1{font-size:22px}
  .login .sub{font-size:14px;color:#7a7067;margin:8px 0 20px}
  .login input{width:100%;padding:11px 13px;border:1px solid #ddd5c2;border-radius:6px;font-size:15px;margin-bottom:12px}
  .login input:focus{outline:none;border-color:#c9462c}
  .login button{width:100%;padding:12px;background:#c9462c;color:#fff;border:0;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
  .login button:hover{background:#1a1f24}
  .login .alt{font-size:13px;color:#7a7067;margin:16px 0 0;text-align:center}
  .login .alt a{color:#c9462c}
  .flash{background:#e0eddb;border:1px solid #b5cba6;color:#2f4a3c;padding:11px 14px;border-radius:6px;margin-bottom:16px;font-size:14px}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function html(s: string): Response {
  return new Response(s, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

// ---------- small helpers ----------

function money(cents: number, currency = "usd"): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
    maximumFractionDigits: 0,
  });
}
function fmtDate(epoch: number | null): string {
  if (!epoch) return "-";
  return new Date(epoch * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
