// Invoice business logic: create clients, create invoices, send via email,
// receive payment confirmations via Stripe webhook.
//
// Money: every amount is integer cents. Validation is server-side.
// Idempotency: invoice_events table has UNIQUE index on stripe_event_id.

import type { Env } from "./types";
import {
  createCustomer,
  createCheckoutSession,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  verifyStripeWebhook,
} from "./stripe";

// Customer-facing invoice URLs go on api.signaladvise.com for now (where the
// worker is bound). If we later add a Cloudflare route for signaladvise.com/i/*
// → signal-pitcher, this can flip back to the bare domain for nicer branding.
const BILLING_HOST = "https://api.signaladvise.com";
const ADMIN_HOST = "https://api.signaladvise.com";

// ---------- shared types ----------

export interface ClientRow {
  id: number;
  company_legal_name: string;
  signatory_name: string | null;
  signatory_title: string | null;
  email: string;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string;
  ein_last_four: string | null;
  stripe_customer_id: string | null;
  msa_signed_at: number | null;
  msa_doc_url: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface InvoiceRow {
  id: number;
  client_id: number;
  invoice_number: string;
  description: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  view_token: string;
  due_date: number | null;
  sent_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LineItemRow {
  id: number;
  invoice_id: number;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  position: number;
}

// ---------- helpers ----------

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function formatMoney(cents: number, currency = "usd"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${remainder.toString().padStart(2, "0")} ${currency.toUpperCase()}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function nextInvoiceNumber(env: Env, year: number): Promise<string> {
  // Atomic increment using D1 batch. Returns "SA-YYYY-0001" format.
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoice_counter (year, last_number) VALUES (?1, 1)
         ON CONFLICT(year) DO UPDATE SET last_number = last_number + 1
       RETURNING last_number`,
    ).bind(year),
  ]);
  const row = (result[0].results[0] as { last_number: number }) ?? { last_number: 1 };
  return `SA-${year}-${row.last_number.toString().padStart(4, "0")}`;
}

// ---------- POST /admin/clients ----------

export async function handleCreateClient(req: Request, env: Env): Promise<Response> {
  let body: Partial<ClientRow>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "bad json" }, 400);
  }
  const { company_legal_name, signatory_name, signatory_title, email, phone,
    address_line1, address_line2, city, state, postal_code, country = "US",
    ein_last_four, msa_signed_at, msa_doc_url, notes } = body;
  if (!company_legal_name || !email || !email.includes("@")) {
    return jsonResponse({ error: "missing required fields (company_legal_name, email)" }, 400);
  }

  // Create Stripe customer first (idempotent by email-based key).
  const idemp = `client-create-${email.toLowerCase()}-${Date.now()}`;
  let stripeCustomerId: string;
  try {
    const cust = await createCustomer(env, {
      email: email.toLowerCase(),
      name: company_legal_name,
      phone: phone || undefined,
      address: address_line1 ? {
        line1: address_line1,
        line2: address_line2 || undefined,
        city: city || undefined,
        state: state || undefined,
        postal_code: postal_code || undefined,
        country: country,
      } : undefined,
      metadata: {
        signatory_name: signatory_name || "",
        ein_last_four: ein_last_four || "",
      },
      idempotencyKey: idemp,
    });
    stripeCustomerId = cust.id;
  } catch (err) {
    return jsonResponse({
      error: "stripe customer create failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 502);
  }

  const result = await env.DB.prepare(
    `INSERT INTO clients (
       company_legal_name, signatory_name, signatory_title, email, phone,
       address_line1, address_line2, city, state, postal_code, country,
       ein_last_four, stripe_customer_id, msa_signed_at, msa_doc_url, notes
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
     RETURNING id`,
  )
    .bind(
      company_legal_name, signatory_name ?? null, signatory_title ?? null,
      email.toLowerCase(), phone ?? null,
      address_line1 ?? null, address_line2 ?? null, city ?? null, state ?? null,
      postal_code ?? null, country,
      ein_last_four ?? null, stripeCustomerId, msa_signed_at ?? null,
      msa_doc_url ?? null, notes ?? null,
    )
    .first<{ id: number }>();
  if (!result) return jsonResponse({ error: "db insert failed" }, 500);

  return jsonResponse({
    id: result.id,
    stripe_customer_id: stripeCustomerId,
    company_legal_name,
    email: email.toLowerCase(),
  }, 201);
}

// ---------- POST /admin/invoices ----------

interface CreateInvoiceBody {
  client_id: number;
  description?: string;
  line_items: Array<{
    description: string;
    quantity?: number;
    unit_amount_cents: number;
  }>;
  due_in_days?: number;
}

export async function handleCreateInvoice(req: Request, env: Env): Promise<Response> {
  let body: CreateInvoiceBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "bad json" }, 400);
  }
  if (!body.client_id || !Array.isArray(body.line_items) || body.line_items.length === 0) {
    return jsonResponse({ error: "client_id and non-empty line_items required" }, 400);
  }
  // Validate amounts are positive integers
  for (const li of body.line_items) {
    if (!Number.isInteger(li.unit_amount_cents) || li.unit_amount_cents <= 0) {
      return jsonResponse({ error: "unit_amount_cents must be positive integer" }, 400);
    }
    const q = li.quantity ?? 1;
    if (!Number.isInteger(q) || q <= 0) {
      return jsonResponse({ error: "quantity must be positive integer" }, 400);
    }
  }

  const client = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?1`)
    .bind(body.client_id)
    .first<ClientRow>();
  if (!client) return jsonResponse({ error: "client not found" }, 404);
  if (!client.stripe_customer_id) {
    return jsonResponse({ error: "client missing stripe_customer_id" }, 500);
  }

  // Compute totals
  let subtotal = 0;
  const lineItemsForDb: Array<{ description: string; quantity: number; unit: number; amount: number; pos: number }> = [];
  body.line_items.forEach((li, i) => {
    const qty = li.quantity ?? 1;
    const amount = qty * li.unit_amount_cents;
    subtotal += amount;
    lineItemsForDb.push({
      description: li.description,
      quantity: qty,
      unit: li.unit_amount_cents,
      amount,
      pos: i,
    });
  });
  const total = subtotal; // no tax for now

  const now = Math.floor(Date.now() / 1000);
  const year = new Date().getUTCFullYear();
  const invoiceNumber = await nextInvoiceNumber(env, year);
  const viewToken = randomHex(16);
  const dueDate = body.due_in_days
    ? now + body.due_in_days * 24 * 60 * 60
    : now + 30 * 24 * 60 * 60;

  const inserted = await env.DB.prepare(
    `INSERT INTO invoices (
       client_id, invoice_number, description,
       subtotal_cents, tax_cents, total_cents, currency, status,
       stripe_customer_id, view_token, due_date
     ) VALUES (?1,?2,?3,?4,0,?5,'usd','draft',?6,?7,?8)
     RETURNING id`,
  )
    .bind(
      body.client_id, invoiceNumber, body.description ?? null,
      subtotal, total, client.stripe_customer_id, viewToken, dueDate,
    )
    .first<{ id: number }>();
  if (!inserted) return jsonResponse({ error: "db insert failed" }, 500);
  const invoiceId = inserted.id;

  for (const li of lineItemsForDb) {
    await env.DB.prepare(
      `INSERT INTO invoice_line_items
        (invoice_id, description, quantity, unit_amount_cents, amount_cents, position)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(invoiceId, li.description, li.quantity, li.unit, li.amount, li.pos).run();
  }

  await env.DB.prepare(
    `INSERT INTO invoice_events (invoice_id, event_type, payload)
     VALUES (?1, 'created', ?2)`,
  ).bind(invoiceId, JSON.stringify({ invoiceNumber, total })).run();

  return jsonResponse({
    id: invoiceId,
    invoice_number: invoiceNumber,
    view_token: viewToken,
    view_url: `${BILLING_HOST}/i/${viewToken}`,
    pay_url: `${ADMIN_HOST}/i/${viewToken}/pay`,
    total_cents: total,
    due_date: dueDate,
    status: "draft",
  }, 201);
}

// ---------- POST /admin/invoices/:id/send ----------

export async function handleSendInvoice(invoiceId: number, env: Env): Promise<Response> {
  const inv = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`)
    .bind(invoiceId)
    .first<InvoiceRow>();
  if (!inv) return jsonResponse({ error: "invoice not found" }, 404);
  if (inv.status === "paid" || inv.status === "void") {
    return jsonResponse({ error: `invoice already ${inv.status}` }, 409);
  }

  const client = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?1`)
    .bind(inv.client_id)
    .first<ClientRow>();
  if (!client) return jsonResponse({ error: "client missing" }, 500);

  const viewUrl = `${BILLING_HOST}/i/${inv.view_token}`;
  const html = invoiceEmailHtml(inv, client, viewUrl);
  const text = invoiceEmailText(inv, client, viewUrl);

  await sendBrandedEmail(env, {
    to: client.email,
    subject: `Invoice ${inv.invoice_number} from Signal Advisory · ${formatMoney(inv.total_cents)} due`,
    html,
    text,
  });

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE invoices SET status = 'sent', sent_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ?1 AND status IN ('draft','sent')`,
    ).bind(invoiceId),
    env.DB.prepare(
      `INSERT INTO invoice_events (invoice_id, event_type, payload)
         VALUES (?1, 'sent', ?2)`,
    ).bind(invoiceId, JSON.stringify({ to: client.email, view_url: viewUrl })),
  ]);

  return jsonResponse({ ok: true, sent_to: client.email, view_url: viewUrl });
}

// ---------- POST /admin/invoices/:id/void ----------

export async function handleVoidInvoice(invoiceId: number, env: Env): Promise<Response> {
  const inv = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`)
    .bind(invoiceId)
    .first<InvoiceRow>();
  if (!inv) return jsonResponse({ error: "invoice not found" }, 404);
  if (inv.status === "paid") return jsonResponse({ error: "cannot void paid invoice" }, 409);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE invoices SET status='void', voided_at=unixepoch(), updated_at=unixepoch()
         WHERE id = ?1`,
    ).bind(invoiceId),
    env.DB.prepare(
      `INSERT INTO invoice_events (invoice_id, event_type) VALUES (?1, 'voided')`,
    ).bind(invoiceId),
  ]);
  return jsonResponse({ ok: true });
}

// ---------- GET /i/:token (public invoice view) ----------

export async function serveInvoicePage(token: string, env: Env): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return new Response(invoiceNotFoundHtml(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const inv = await env.DB.prepare(`SELECT * FROM invoices WHERE view_token = ?1`)
    .bind(token)
    .first<InvoiceRow>();
  if (!inv || inv.status === "void") {
    return new Response(invoiceNotFoundHtml(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const client = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?1`)
    .bind(inv.client_id)
    .first<ClientRow>();
  const lines = await env.DB.prepare(
    `SELECT * FROM invoice_line_items WHERE invoice_id = ?1 ORDER BY position ASC`,
  )
    .bind(inv.id)
    .all<LineItemRow>();
  return new Response(invoiceHtml(inv, client!, lines.results), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---------- GET /i/:token/pay (create checkout, redirect) ----------

export async function handlePayInvoice(token: string, env: Env): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return new Response("invalid", { status: 404 });
  }
  const inv = await env.DB.prepare(`SELECT * FROM invoices WHERE view_token = ?1`)
    .bind(token)
    .first<InvoiceRow>();
  if (!inv) return new Response("not found", { status: 404 });
  if (inv.status === "paid") return Response.redirect(`${BILLING_HOST}/i/${token}?paid=1`, 302);
  if (inv.status === "void") return new Response("invoice voided", { status: 410 });

  // Reuse existing checkout session if still open
  if (inv.stripe_checkout_session_id) {
    try {
      const existing = await retrieveCheckoutSession(env, inv.stripe_checkout_session_id);
      if (existing.payment_status === "unpaid" && existing.url) {
        return Response.redirect(existing.url, 302);
      }
    } catch {
      // fall through and create a new one
    }
  }

  const lines = await env.DB.prepare(
    `SELECT * FROM invoice_line_items WHERE invoice_id = ?1 ORDER BY position ASC`,
  )
    .bind(inv.id)
    .all<LineItemRow>();

  const session = await createCheckoutSession(env, {
    customer: inv.stripe_customer_id!,
    line_items: lines.results.map((li) => ({
      price_data: {
        currency: inv.currency,
        unit_amount: li.unit_amount_cents,
        product_data: {
          name: li.description,
          description: inv.description || undefined,
        },
      },
      quantity: li.quantity,
    })),
    success_url: `${BILLING_HOST}/i/${token}?paid=1`,
    cancel_url: `${BILLING_HOST}/i/${token}`,
    payment_method_types: ["card", "us_bank_account"],
    metadata: {
      invoice_id: String(inv.id),
      invoice_number: inv.invoice_number,
      view_token: token,
    },
    idempotencyKey: `checkout-invoice-${inv.id}-${Date.now()}`,
  });

  await env.DB.prepare(
    `UPDATE invoices SET stripe_checkout_session_id = ?1, updated_at = unixepoch()
       WHERE id = ?2`,
  ).bind(session.id, inv.id).run();

  if (!session.url) return new Response("no checkout url", { status: 502 });
  return Response.redirect(session.url, 302);
}

// ---------- POST /webhook/stripe ----------

export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature");
  const verification = await verifyStripeWebhook(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verification.valid) {
    return new Response(`invalid signature: ${verification.reason}`, { status: 401 });
  }

  let evt: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!evt.id || !evt.type) return new Response("missing id/type", { status: 400 });

  // Idempotency: try inserting the event row. If it already exists, swallow.
  try {
    await env.DB.prepare(
      `INSERT INTO invoice_events (invoice_id, stripe_event_id, event_type, payload)
       VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(
        extractInvoiceId(evt) ?? null,
        evt.id,
        evt.type,
        rawBody.slice(0, 10000),
      )
      .run();
  } catch (err) {
    // Unique constraint violation = duplicate event, already processed.
    if (String(err).includes("UNIQUE")) {
      return new Response("duplicate", { status: 200 });
    }
    throw err;
  }

  // Route by type
  if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
    await handleCheckoutSucceeded(evt, env);
  } else if (evt.type === "checkout.session.async_payment_failed") {
    await handleCheckoutFailed(evt, env);
  }
  // Other event types are logged but no state change.

  return new Response("ok", { status: 200 });
}

function extractInvoiceId(evt: { data?: { object?: Record<string, unknown> } }): number | null {
  const obj = evt.data?.object;
  if (!obj) return null;
  const md = (obj.metadata as Record<string, string> | undefined) ?? undefined;
  if (md?.invoice_id) {
    const n = parseInt(md.invoice_id, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function handleCheckoutSucceeded(
  evt: { data?: { object?: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const session = evt.data?.object as Record<string, unknown> | undefined;
  if (!session) return;
  const invoiceId = extractInvoiceId(evt);
  if (!invoiceId) {
    console.error("checkout.session.completed without invoice_id metadata", session.id);
    return;
  }
  const paymentIntentId = (session.payment_intent as string | null) ?? null;

  const inv = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`)
    .bind(invoiceId)
    .first<InvoiceRow>();
  if (!inv) return;
  if (inv.status === "paid") return;

  await env.DB.prepare(
    `UPDATE invoices SET status = 'paid', paid_at = unixepoch(),
       stripe_payment_intent_id = ?2, updated_at = unixepoch()
     WHERE id = ?1`,
  ).bind(invoiceId, paymentIntentId).run();

  const client = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?1`)
    .bind(inv.client_id)
    .first<ClientRow>();
  if (client) {
    // Branded receipt to client
    await sendBrandedEmail(env, {
      to: client.email,
      subject: `Payment received — Invoice ${inv.invoice_number}`,
      text: receiptEmailText(inv, client),
      html: receiptEmailHtml(inv, client),
    });
    // Notification to Brandon
    await sendBrandedEmail(env, {
      to: "brandon@signaladvise.com",
      subject: `💰 Invoice ${inv.invoice_number} paid — ${formatMoney(inv.total_cents)}`,
      text:
        `Payment received.\n\n` +
        `Invoice: ${inv.invoice_number}\n` +
        `Client: ${client.company_legal_name} (${client.email})\n` +
        `Amount: ${formatMoney(inv.total_cents)}\n` +
        `Stripe PI: ${paymentIntentId ?? "n/a"}\n`,
    });
  }
}

async function handleCheckoutFailed(
  evt: { data?: { object?: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const invoiceId = extractInvoiceId(evt);
  if (!invoiceId) return;
  // Notify Brandon. Don't change status; ACH failures may retry.
  await sendBrandedEmail(env, {
    to: "brandon@signaladvise.com",
    subject: `⚠️  Invoice payment failed (invoice id ${invoiceId})`,
    text: `Stripe reported a payment failure for invoice ${invoiceId}. Check the dashboard for details.`,
  });
}

// ---------- email helpers ----------

async function sendBrandedEmail(
  env: Env,
  msg: { to: string; subject: string; text: string; html?: string },
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
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
      html: msg.html,
    }),
  });
  if (!res.ok) {
    console.error("resend send failed", res.status, await res.text());
  }
}

function invoiceEmailText(inv: InvoiceRow, client: ClientRow, url: string): string {
  return (
    `Hi ${client.signatory_name || client.company_legal_name},\n\n` +
    `Invoice ${inv.invoice_number} from Signal Advisory: ${formatMoney(inv.total_cents)} due ${inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString("en-US") : ""}\n\n` +
    `View and pay: ${url}\n\n` +
    `We accept card and ACH bank transfer (ACH is significantly cheaper for both of us on larger invoices).\n\n` +
    `Reply to this email if anything needs adjustment.\n\n` +
    `Brandon\n` +
    `Principal Advisor · Signal Advisory\n` +
    `brandon@signaladvise.com`
  );
}

function invoiceEmailHtml(inv: InvoiceRow, client: ClientRow, url: string): string {
  const due = inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString("en-US") : "";
  return (
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px">` +
    `<p>Hi ${escapeHtml(client.signatory_name || client.company_legal_name)},</p>` +
    `<p>Invoice <strong>${escapeHtml(inv.invoice_number)}</strong> from Signal Advisory: <strong>${formatMoney(inv.total_cents)}</strong>${due ? ` due ${due}` : ""}.</p>` +
    `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#c9462c;color:#faf7f1;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:600">View and pay invoice</a></p>` +
    `<p>We accept card and ACH bank transfer (ACH is significantly cheaper for both of us on larger invoices).</p>` +
    `<p>Reply if anything needs adjustment.</p>` +
    `<p>Brandon<br>Principal Advisor · Signal Advisory<br><a href="mailto:brandon@signaladvise.com" style="color:#222">brandon@signaladvise.com</a></p>` +
    `</div>`
  );
}

function receiptEmailText(inv: InvoiceRow, client: ClientRow): string {
  return (
    `Hi ${client.signatory_name || client.company_legal_name},\n\n` +
    `Payment received for invoice ${inv.invoice_number} — ${formatMoney(inv.total_cents)}. Thank you.\n\n` +
    `This email serves as your receipt. The invoice page (${BILLING_HOST}/i/${inv.view_token}) will continue to show the paid status for your records.\n\n` +
    `Looking forward to the work ahead.\n\n` +
    `Brandon\n` +
    `Principal Advisor · Signal Advisory`
  );
}

function receiptEmailHtml(inv: InvoiceRow, client: ClientRow): string {
  return (
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px">` +
    `<p>Hi ${escapeHtml(client.signatory_name || client.company_legal_name)},</p>` +
    `<p>Payment received for invoice <strong>${escapeHtml(inv.invoice_number)}</strong> — <strong>${formatMoney(inv.total_cents)}</strong>. Thank you.</p>` +
    `<p>This email serves as your receipt. The invoice page will continue to show the paid status for your records: <a href="${BILLING_HOST}/i/${inv.view_token}">${BILLING_HOST}/i/${inv.view_token}</a></p>` +
    `<p>Looking forward to the work ahead.</p>` +
    `<p>Brandon<br>Principal Advisor · Signal Advisory</p>` +
    `</div>`
  );
}

// ---------- branded invoice page HTML ----------

function invoiceHtml(inv: InvoiceRow, client: ClientRow, lines: LineItemRow[]): string {
  const due = inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
  const issued = new Date(inv.created_at * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const isPaid = inv.status === "paid";
  const statusBadge = isPaid
    ? `<span style="background:#2f4a3c;color:#faf7f1;padding:4px 12px;border-radius:3px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase">Paid</span>`
    : `<span style="background:#c9462c;color:#faf7f1;padding:4px 12px;border-radius:3px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase">Due ${escapeHtml(due)}</span>`;

  const linesHtml = lines.map((li) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e3ddd0">
        <div style="font-weight:500">${escapeHtml(li.description)}</div>
        ${li.quantity > 1 ? `<div style="font-size:12px;color:#7a7067;margin-top:2px">${li.quantity} × ${formatMoney(li.unit_amount_cents)}</div>` : ""}
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #e3ddd0;text-align:right;font-variant-numeric:tabular-nums">${formatMoney(li.amount_cents)}</td>
    </tr>`).join("");

  const payBlock = isPaid
    ? `<div style="margin:32px 0;padding:24px;background:#f5f7f1;border:1px solid #d5dfc8;border-radius:6px;text-align:center"><div style="font-size:24px;color:#2f4a3c;font-weight:500">✓ Paid in full</div><div style="font-size:13px;color:#7a7067;margin-top:6px">${inv.paid_at ? "Received " + new Date(inv.paid_at * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : ""}</div></div>`
    : `<div style="margin:32px 0;text-align:center"><a href="https://api.signaladvise.com/i/${inv.view_token}/pay" style="display:inline-block;background:#c9462c;color:#faf7f1;padding:16px 40px;text-decoration:none;border-radius:4px;font-weight:600;font-size:15px">Pay ${formatMoney(inv.total_cents)}</a><div style="font-size:12px;color:#7a7067;margin-top:12px">Card or ACH bank transfer · Secure checkout via Stripe</div></div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<title>Invoice ${escapeHtml(inv.invoice_number)} · Signal Advisory</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#faf7f1;color:#1a1f24;margin:0;padding:40px 20px;line-height:1.55}
  .invoice{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e3ddd0;border-radius:8px;padding:48px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e3ddd0;padding-bottom:32px;margin-bottom:32px}
  .brand{display:flex;align-items:center;gap:12px}
  .brand-text{font-family:Georgia,serif;font-weight:500;font-size:24px;color:#1a1f24}
  .brand-sub{font-size:10px;letter-spacing:0.2em;color:#7a7067;text-transform:uppercase;margin-top:2px}
  .invoice-meta{text-align:right;font-size:13px;color:#7a7067}
  .invoice-num{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:14px;color:#1a1f24;margin-bottom:8px}
  .section-title{font-size:11px;letter-spacing:0.2em;color:#7a7067;text-transform:uppercase;margin:0 0 8px}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-bottom:32px}
  .party-name{font-weight:600;color:#1a1f24}
  .party-line{color:#1a1f24;font-size:14px;margin-top:2px}
  table.lines{width:100%;border-collapse:collapse;margin-top:8px}
  table.lines th{text-align:left;padding:8px 0;border-bottom:2px solid #1a1f24;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#7a7067}
  table.lines th:last-child{text-align:right}
  .totals{margin-top:24px;padding-top:16px;border-top:2px solid #1a1f24}
  .total-row{display:flex;justify-content:space-between;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .footer{margin-top:40px;padding-top:24px;border-top:1px solid #e3ddd0;font-size:12px;color:#7a7067;line-height:1.6}
  @media (max-width:600px){
    .invoice{padding:24px}
    .header{flex-direction:column;gap:16px}
    .invoice-meta{text-align:left}
    .parties{grid-template-columns:1fr}
  }
  @media print{
    body{background:#fff;padding:0}
    .invoice{border:none;box-shadow:none;max-width:none}
    a.pay-btn{display:none !important}
  }
</style>
</head><body>
<div class="invoice">
  <div class="header">
    <div class="brand">
      <svg width="48" height="48" viewBox="0 0 96 96"><rect width="96" height="96" fill="#1a1f24" rx="8"/><circle cx="48" cy="48" r="6" fill="#c9462c"/><path d="M48 28 A20 20 0 0 1 68 48" stroke="#faf7f1" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M48 20 A28 28 0 0 1 76 48" stroke="#faf7f1" stroke-width="2.8" fill="none" opacity="0.55" stroke-linecap="round"/></svg>
      <div>
        <div class="brand-text">Signal Advisory</div>
        <div class="brand-sub">Independent Technology Advisory</div>
      </div>
    </div>
    <div class="invoice-meta">
      <div class="invoice-num">Invoice ${escapeHtml(inv.invoice_number)}</div>
      <div>${statusBadge}</div>
      <div style="margin-top:12px">Issued ${escapeHtml(issued)}</div>
    </div>
  </div>

  <div class="parties">
    <div>
      <p class="section-title">Billed to</p>
      <div class="party-name">${escapeHtml(client.company_legal_name)}</div>
      ${client.signatory_name ? `<div class="party-line">Attn: ${escapeHtml(client.signatory_name)}${client.signatory_title ? ", " + escapeHtml(client.signatory_title) : ""}</div>` : ""}
      ${client.address_line1 ? `<div class="party-line">${escapeHtml(client.address_line1)}</div>` : ""}
      ${client.address_line2 ? `<div class="party-line">${escapeHtml(client.address_line2)}</div>` : ""}
      ${client.city ? `<div class="party-line">${escapeHtml(client.city)}, ${escapeHtml(client.state || "")} ${escapeHtml(client.postal_code || "")}</div>` : ""}
      <div class="party-line" style="margin-top:6px;color:#7a7067">${escapeHtml(client.email)}</div>
    </div>
    <div>
      <p class="section-title">From</p>
      <div class="party-name">Signal Advisory LLC</div>
      <div class="party-line">Kansas City, MO</div>
      <div class="party-line" style="margin-top:6px;color:#7a7067">brandon@signaladvise.com</div>
      <div class="party-line" style="color:#7a7067">816.355.3350</div>
    </div>
  </div>

  ${inv.description ? `<div style="margin-bottom:16px"><p class="section-title">Engagement</p><div style="font-size:14px;color:#1a1f24">${escapeHtml(inv.description)}</div></div>` : ""}

  <table class="lines">
    <thead><tr><th>Description</th><th>Amount</th></tr></thead>
    <tbody>${linesHtml}</tbody>
  </table>

  <div class="totals">
    <div class="total-row">
      <span>Total due</span>
      <span>${formatMoney(inv.total_cents, inv.currency)}</span>
    </div>
  </div>

  ${payBlock}

  <div class="footer">
    <p><strong>Payment terms.</strong> Due ${escapeHtml(due)}. Payment via card or ACH bank transfer. Invoices unpaid after the due date accrue interest at 1.5% per month or the maximum rate permitted by law.</p>
    <p>Questions? Reply directly to this invoice link or email <a href="mailto:invoice@signaladvise.com" style="color:#c9462c">invoice@signaladvise.com</a>.</p>
    <p style="margin-top:16px;font-size:11px;color:#7a7067">Signal Advisory LLC · Kansas City, MO · signaladvise.com</p>
  </div>
</div>
</body></html>`;
}

function invoiceNotFoundHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice not found</title>
<style>body{font-family:-apple-system,Helvetica,sans-serif;background:#faf7f1;color:#1a1f24;max-width:560px;margin:80px auto;padding:0 24px;text-align:center}</style>
</head><body>
<h1>Invoice not found</h1>
<p>This link is invalid or has been voided. If you believe this is an error, reply to the original invoice email or contact <a href="mailto:brandon@signaladvise.com">brandon@signaladvise.com</a>.</p>
</body></html>`;
}
