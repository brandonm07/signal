// Minimal Gmail API client for the inbound subsystem.
// Uses refresh-token flow; no SDK; just fetch.

import type { Env } from "./types";

interface AccessToken {
  token: string;
  expiresAt: number;
}

let cachedToken: AccessToken | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.token;
}

interface GmailListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}

export async function listInboxMessages(
  env: Env,
  query: string,
  maxResults = 25,
): Promise<{ id: string; threadId: string }[]> {
  const token = await getAccessToken(env);
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(env.GMAIL_USER)}/messages?` +
    new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail list failed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as GmailListResponse;
  return json.messages ?? [];
}

interface GmailMessageHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string; size: number };
  parts?: GmailMessagePart[];
  headers?: GmailMessageHeader[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload: GmailMessagePart & { headers: GmailMessageHeader[] };
  historyId: string;
  internalDate: string;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: number;
  labels: string[];
  from: string;
  to: string;
  subject: string;
  snippet: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
  autoSubmitted?: string;
}

export async function getMessage(env: Env, id: string): Promise<ParsedMessage> {
  const token = await getAccessToken(env);
  const url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(env.GMAIL_USER)}/messages/${id}?format=full`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Gmail get failed ${res.status}: ${await res.text()}`);
  }
  const m = (await res.json()) as GmailMessage;
  const headers: Record<string, string> = {};
  for (const h of m.payload.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  return {
    id: m.id,
    threadId: m.threadId,
    historyId: m.historyId,
    internalDate: parseInt(m.internalDate, 10),
    labels: m.labelIds ?? [],
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    subject: headers["subject"] ?? "",
    snippet: m.snippet ?? "",
    bodyText: extractTextBody(m.payload),
    inReplyTo: headers["in-reply-to"],
    references: headers["references"],
    messageId: headers["message-id"],
    autoSubmitted: headers["auto-submitted"],
  };
}

function extractTextBody(part: GmailMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    // prefer text/plain, fall back to first text/html stripped
    for (const p of part.parts) {
      if (p.mimeType === "text/plain" && p.body?.data) {
        return decodeBase64Url(p.body.data);
      }
    }
    for (const p of part.parts) {
      if (p.mimeType === "text/html" && p.body?.data) {
        return decodeBase64Url(p.body.data).replace(/<[^>]+>/g, " ");
      }
      if (p.parts) {
        const nested = extractTextBody(p);
        if (nested) return nested;
      }
    }
  }
  if (part.body?.data) return decodeBase64Url(part.body.data);
  return "";
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    return atob(padded);
  } catch {
    return "";
  }
}

function encodeBase64Url(s: string): string {
  // btoa needs a Latin1 string; encode to UTF-8 first.
  const utf8 = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface DraftRequest {
  threadId: string;
  to: string;
  from: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  bodyText: string;
}

export async function createDraftReply(
  env: Env,
  req: DraftRequest,
): Promise<{ id: string }> {
  const token = await getAccessToken(env);
  // Build a minimal RFC 5322 message.
  const headers: string[] = [
    `From: ${req.from}`,
    `To: ${req.to}`,
    `Subject: ${req.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Auto-Submitted: auto-generated`,
  ];
  if (req.inReplyTo) headers.push(`In-Reply-To: ${req.inReplyTo}`);
  if (req.references) headers.push(`References: ${req.references}`);

  const raw = encodeBase64Url(headers.join("\r\n") + "\r\n\r\n" + req.bodyText);

  const url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(env.GMAIL_USER)}/drafts`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: { raw, threadId: req.threadId },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail draft create failed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string };
  return { id: json.id };
}
