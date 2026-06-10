// Shared helpers. Security-relevant functions (escaping, constant-time
// comparison, token signing, webhook verification) live here and ONLY here —
// a fix applied to one of these must never silently miss a second copy.
import type { Env } from "./types";

export const OWNER_EMAIL = "brandon@signaladvise.com";

// ---------- escaping ----------

export function escapeHtml(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- crypto primitives ----------

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison so secret/signature checks don't leak
// content through response timing. Length is allowed to leak.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- signed tokens (portal sessions, magic links, admin sessions) ----------
//
// Format: base64url(JSON payload) + "." + hex(HMAC-SHA256(payload)).
// Stateless: expiry lives in the payload as `exp` (unix seconds).

export async function signToken(secret: string, obj: Record<string, unknown>): Promise<string> {
  const payload = b64url(JSON.stringify(obj));
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifyToken(
  secret: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(secret, payload);
  if (!safeEqual(sig, expected)) return null;
  try {
    const obj = JSON.parse(b64urlDecode(payload)) as Record<string, unknown>;
    if (typeof obj.exp === "number" && obj.exp < nowSec()) return null;
    return obj;
  } catch {
    return null;
  }
}

// ---------- svix webhook verification (Resend) ----------

const SVIX_TOLERANCE_SECONDS = 300; // reject replays older/newer than 5 minutes

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export async function verifySvix(
  headers: SvixHeaders,
  body: string,
  secret: string,
  nowEpochSec: number = nowSec(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowEpochSec - ts) > SVIX_TOLERANCE_SECONDS) {
    return false; // stale or future-dated — replay protection
  }
  const key = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const toSign = new TextEncoder().encode(`${id}.${ts}.${body}`);
  const macBuf = await crypto.subtle.sign("HMAC", cryptoKey, toSign);
  const expected = btoa(String.fromCharCode(...new Uint8Array(macBuf)));
  // Header may list several space-separated "v1,<sig>" candidates.
  return signature.split(" ").some((s) => {
    const candidate = s.split(",")[1] ?? "";
    return safeEqual(candidate, expected);
  });
}

// ---------- worker_state key/value ----------

export async function getState(env: Env, key: string): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT value FROM worker_state WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return row ? parseInt(row.value, 10) : null;
}

export async function setState(env: Env, key: string, value: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO worker_state (key, value, updated_at) VALUES (?1, ?2, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  )
    .bind(key, String(value))
    .run();
}

// ---------- transactional / notification email ----------
//
// Best-effort sender for everything EXCEPT the cold-outreach sequence (which
// uses email.ts sendViaResend so failures throw and the queue can retry).
// Always sends from the primary transactional identity. Returns false on
// failure instead of throwing — callers decide whether failure matters.

export async function sendEmail(
  env: Env,
  msg: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  },
): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
        to: msg.to,
        reply_to: msg.replyTo ?? env.REPLY_TO,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: msg.headers,
      }),
    });
    if (!res.ok) {
      console.error("sendEmail failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendEmail failed", err);
    return false;
  }
}

export async function notifyOwner(env: Env, subject: string, text: string): Promise<boolean> {
  return sendEmail(env, { to: OWNER_EMAIL, subject, text });
}
