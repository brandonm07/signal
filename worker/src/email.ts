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
    `Principal Advisor\n` +
    `Signal Advisory\n` +
    `brandon@signaladvise.com · 816.721.6501\n` +
    `linkedin.com/company/signal-advisory-llc`;

  const text =
    `${bodyText}\n${sigText}\n\n` +
    `---\n` +
    `${env.PHYSICAL_ADDRESS}\n` +
    `Unsubscribe: ${unsubUrl}\n`;

  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
    bodyText.split(/\n\n+/).map(blockToHtml).join("") +
    sigHtml() +
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">` +
    `<p style="font-size:12px;color:#888">` +
    `${escapeHtml(env.PHYSICAL_ADDRESS)}<br>` +
    `<a href="${unsubUrl}" style="color:#888">Unsubscribe</a>` +
    `</p></div>`;

  return {
    from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
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

function sigHtml(): string {
  return (
    `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#222">` +
    `<tr>` +
    `<td style="vertical-align:middle;padding-right:14px">` +
    `<img src="https://signaladvise.com/email-icon.png" width="44" height="44" alt="Signal Advisory" style="display:block;border-radius:6px">` +
    `</td>` +
    `<td style="vertical-align:middle;line-height:1.45">` +
    `<div style="color:#7a7067;font-size:12px">Principal Advisor · Signal Advisory</div>` +
    `<div><a href="mailto:brandon@signaladvise.com" style="color:#222;text-decoration:none">brandon@signaladvise.com</a> · 816.721.6501</div>` +
    `<div><a href="https://www.linkedin.com/company/signal-advisory-llc" style="color:#c9462c;text-decoration:none">linkedin.com/company/signal-advisory-llc</a></div>` +
    `</td>` +
    `</tr>` +
    `</table>`
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
