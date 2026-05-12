// Minimal Stripe REST client.
// No SDK; just fetch + form-encoded bodies. Stripe API expects
// application/x-www-form-urlencoded with bracketed-nested keys.
//
// Every request includes an Idempotency-Key header so retries don't create
// duplicate objects.

import type { Env } from "./types";

const STRIPE_API = "https://api.stripe.com/v1";

/** Flatten a nested object into Stripe's bracketed-key form-encoded format. */
function flatten(obj: unknown, prefix = "", out: [string, string][] = []): [string, string][] {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v !== undefined && v !== null) flatten(v, key, out);
    }
    return out;
  }
  out.push([prefix, String(obj)]);
  return out;
}

function encode(obj: unknown): string {
  return flatten(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function stripeRequest<T>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": "2024-11-20.acacia",
  };
  let url = `${STRIPE_API}${path}`;
  let reqBody: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    reqBody = body ? encode(body) : "";
  } else if (body) {
    const qs = encode(body);
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, { method, headers, body: reqBody });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} → ${res.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

// --- Typed API surface ---

export interface StripeCustomer {
  id: string;
  email: string;
  name?: string;
  livemode: boolean;
}

export interface CheckoutSession {
  id: string;
  url: string;
  payment_status: string;
  customer: string | null;
  payment_intent: string | null;
}

export interface PaymentIntent {
  id: string;
  status: string;
  amount: number;
  amount_received: number;
  customer: string | null;
}

export async function createCustomer(
  env: Env,
  args: {
    email: string;
    name: string;
    phone?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
    };
    metadata?: Record<string, string>;
    idempotencyKey: string;
  },
): Promise<StripeCustomer> {
  const { idempotencyKey, ...body } = args;
  return await stripeRequest<StripeCustomer>(
    env,
    "POST",
    "/customers",
    body,
    idempotencyKey,
  );
}

export async function createCheckoutSession(
  env: Env,
  args: {
    customer: string;
    line_items: Array<{
      price_data: {
        currency: string;
        unit_amount: number;
        product_data: { name: string; description?: string };
      };
      quantity: number;
    }>;
    success_url: string;
    cancel_url: string;
    invoice_creation?: { enabled: boolean };
    payment_method_types?: string[];
    metadata: Record<string, string>;
    idempotencyKey: string;
  },
): Promise<CheckoutSession> {
  const { idempotencyKey, ...rest } = args;
  return await stripeRequest<CheckoutSession>(
    env,
    "POST",
    "/checkout/sessions",
    { mode: "payment", ...rest },
    idempotencyKey,
  );
}

export async function retrieveCheckoutSession(
  env: Env,
  sessionId: string,
): Promise<CheckoutSession> {
  return await stripeRequest<CheckoutSession>(
    env,
    "GET",
    `/checkout/sessions/${sessionId}`,
  );
}

export async function retrievePaymentIntent(
  env: Env,
  piId: string,
): Promise<PaymentIntent> {
  return await stripeRequest<PaymentIntent>(env, "GET", `/payment_intents/${piId}`);
}

// --- Webhook signature verification (Stripe's variant of HMAC, not svix) ---
//
// Header format: `t=<timestamp>,v1=<sig>[,v0=<oldsig>,...]`
// We compute HMAC-SHA256 of `${timestamp}.${rawBody}` with the webhook secret,
// hex-encode, and timing-safe compare to v1.
//
// Reject events with timestamps older than the tolerance to prevent replay.

const WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<{ valid: boolean; timestamp: number; reason?: string }> {
  if (!signatureHeader) return { valid: false, timestamp: 0, reason: "missing signature header" };
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const eq = kv.indexOf("=");
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    }),
  ) as Record<string, string>;
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { valid: false, timestamp: 0, reason: "missing t or v1" };
  const timestamp = parseInt(t, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    return { valid: false, timestamp, reason: "timestamp outside tolerance" };
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Timing-safe-ish compare. Worker's crypto.subtle.timingSafeEqual is not available,
  // but constant-time comparison via xor accumulation is fine.
  if (expected.length !== v1.length) return { valid: false, timestamp, reason: "sig length mismatch" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return { valid: diff === 0, timestamp, reason: diff === 0 ? undefined : "signature mismatch" };
}
