import type { Lead, Env } from "./types";
import { SEQUENCE_STEPS } from "./sequence";
import { escapeHtml } from "./shared";

// Fallbacks for merge tags when a lead row is missing data. Without these a
// null first_name renders "Hi ," and a null company renders "Following up, "
// — instant mass-mail tells that tank reply rates and invite spam folders.
const TEMPLATE_FALLBACKS: Record<string, string> = {
  first_name: "there",
  company: "your team",
};

export function renderTemplate(tpl: string, lead: Lead): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = (lead as unknown as Record<string, unknown>)[key];
    if (v != null && String(v).trim() !== "") return String(v);
    return TEMPLATE_FALLBACKS[key] ?? "";
  });
}

export function buildEmail(lead: Lead, env: Env): {
  from: string;
  to: string;
  reply_to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
} {
  // Step 1 uses the per-lead body (with role-specific opener).
  // Steps 2+ use shared, generic follow-up templates.
  const step = lead.step ?? 1;
  let subjectTpl = lead.subject_template;
  let bodyTpl = lead.body_template;
  if (step >= 2) {
    const tpl = SEQUENCE_STEPS[step];
    if (!tpl) throw new Error(`No template for step ${step}`);
    subjectTpl = tpl.subject;
    bodyTpl = tpl.body;
  }
  const subject = renderTemplate(subjectTpl, lead);
  const bodyText = renderTemplate(bodyTpl, lead);
  const unsubUrl = `${env.UNSUBSCRIBE_BASE_URL}?t=${lead.unsubscribe_token}`;

  const sigText =
    `Brandon\n` +
    `Principal Advisor, Signal Advisory\n` +
    `brandon@signaladvise.com · 816.355.3350\n` +
    `signaladvise.com`;

  // Option 2 formatting: keep List-Unsubscribe headers (Gmail/Yahoo native button +
  // CAN-SPAM compliance), drop the visible body footer block. Physical address
  // shown as a single very small gray line — required by CAN-SPAM, visually subtle.
  const text =
    `${bodyText}\n${sigText}\n\n` +
    `${env.PHYSICAL_ADDRESS}\n`;

  // First-party open pixel, gated by OPEN_TRACKING. A 1x1 image fetched from
  // our own worker writes an 'opened' event keyed on the lead's unsubscribe
  // token. Tradeoff: any tracking pixel is a mild deliverability signal, so
  // this is controllable and off-able without a code change.
  const openPixel =
    env.OPEN_TRACKING === "1"
      ? `<img src="https://api.signaladvise.com/o/${lead.unsubscribe_token}.gif" width="1" height="1" alt="" style="display:none;border:0">`
      : "";

  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
    bodyText.split(/\n\n+/).map(blockToHtml).join("") +
    sigHtml() +
    `<p style="font-size:10px;color:#bbb;margin-top:18px">${escapeHtml(env.PHYSICAL_ADDRESS)}</p>` +
    openPixel +
    `</div>`;

  return {
    // Cold outreach goes from a person-forward identity (and, once set, a
    // dedicated cold domain) so it lands like a 1:1 email and keeps spam
    // complaints off the primary signaladvise.com transactional reputation.
    from: `${env.OUTREACH_SENDER_NAME || env.SENDER_NAME} <${env.OUTREACH_SENDER_EMAIL || env.SENDER_EMAIL}>`,
    to: lead.email,
    reply_to: env.REPLY_TO,
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

// Thrown when Resend rejects a send; carries the HTTP status so callers can
// distinguish permanent failures (4xx — don't retry) from transient ones
// (5xx/429/network — safe to retry).
export class ResendError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Resend ${status}: ${body}`);
    this.name = "ResendError";
  }
}

export async function sendViaResend(
  msg: ReturnType<typeof buildEmail>,
  apiKey: string,
  idempotencyKey?: string,
): Promise<{ id: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  // Resend dedupes requests sharing an Idempotency-Key for 24h, so a queue
  // retry after a mid-flight crash cannot deliver the same email twice.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ResendError(res.status, body);
  }
  const json = (await res.json()) as { id: string };
  return json;
}

function blockToHtml(block: string): string {
  const lines = block.split("\n").filter((l) => l.length > 0);
  if (lines.length > 0 && lines.every((l) => /^[•\-]\s+/.test(l))) {
    const items = lines
      .map((l) => `<li>${escapeHtml(l.replace(/^[•\-]\s+/, ""))}</li>`)
      .join("");
    return `<ul style="margin:0 0 1em 0;padding-left:1.25em">${items}</ul>`;
  }
  return `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`;
}

// Formatted HTML signature: logo, then a left accent bar, bold name, muted
// title, and clickable email/phone/site. The logo is one small image — a mild
// deliverability tradeoff on a cold first touch, but requested for brand. The
// plain-text part keeps the same details for clients that strip HTML.
function sigHtml(): string {
  return (
    `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif">` +
    `<tr>` +
    `<td style="vertical-align:top;padding-right:14px">` +
    `<img src="https://signaladvise.com/email-icon.png" width="46" height="46" alt="Signal Advisory" style="display:block;border-radius:8px">` +
    `</td>` +
    `<td style="vertical-align:top;border-left:3px solid #c9462c;padding-left:12px;line-height:1.5">` +
    `<div style="font-weight:bold;font-size:15px;color:#1a1f24">Brandon</div>` +
    `<div style="font-size:13px;color:#7a7067">Principal Advisor · Signal Advisory</div>` +
    `<div style="font-size:13px;color:#222;margin-top:4px">` +
    `<a href="mailto:brandon@signaladvise.com" style="color:#222;text-decoration:none">brandon@signaladvise.com</a>` +
    ` &nbsp;·&nbsp; <a href="tel:+18163553350" style="color:#222;text-decoration:none">816.355.3350</a>` +
    `</div>` +
    `<div style="font-size:13px;margin-top:2px">` +
    `<a href="https://signaladvise.com" style="color:#c9462c;text-decoration:none;font-weight:600">signaladvise.com</a>` +
    `</div>` +
    `</td></tr></table>`
  );
}
