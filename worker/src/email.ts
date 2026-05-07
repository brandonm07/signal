import type { Lead, Env } from "./types";

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
  const subject = renderTemplate(lead.subject_template, lead);
  const bodyText = renderTemplate(lead.body_template, lead);
  const unsubUrl = `${env.UNSUBSCRIBE_BASE_URL}?t=${lead.unsubscribe_token}`;

  const text =
    `${bodyText}\n\n` +
    `---\n` +
    `${env.PHYSICAL_ADDRESS}\n` +
    `Unsubscribe: ${unsubUrl}\n`;

  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
    bodyText
      .split(/\n\n+/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("") +
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
