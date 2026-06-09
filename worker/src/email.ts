import type { Lead, Env } from "./types";
import { SEQUENCE_STEPS } from "./sequence";

export function renderTemplate(tpl: string, lead: Lead): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = (lead as unknown as Record<string, unknown>)[key];
    return v == null ? "" : String(v);
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

  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
    bodyText.split(/\n\n+/).map(blockToHtml).join("") +
    sigHtml() +
    `<p style="font-size:10px;color:#bbb;margin-top:18px">${escapeHtml(env.PHYSICAL_ADDRESS)}</p>` +
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

export async function sendViaResend(
  msg: ReturnType<typeof buildEmail>,
  apiKey: string,
): Promise<{ id: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(msg),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
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

// Plain, text-style signature for cold outreach: no image, single link.
// Designed HTML/images on a first cold touch are a Promotions/spam signal,
// and the text and HTML signatures are kept in sync to avoid mismatch flags.
function sigHtml(): string {
  return (
    `<p style="margin:1em 0 0">` +
    `Brandon<br>` +
    `Principal Advisor, Signal Advisory<br>` +
    `brandon@signaladvise.com · 816.355.3350<br>` +
    `<a href="https://signaladvise.com" style="color:#222">signaladvise.com</a>` +
    `</p>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
