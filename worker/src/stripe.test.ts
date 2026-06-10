import { describe, expect, it } from "vitest";
import { verifyStripeWebhook } from "./stripe";

const SECRET = "whsec_stripe_test_secret";

async function stripeSign(timestamp: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

describe("verifyStripeWebhook", () => {
  const body = `{"id":"evt_1","type":"checkout.session.completed"}`;

  it("accepts a valid, fresh signature", async () => {
    const t = now();
    const sig = await stripeSign(t, body);
    const res = await verifyStripeWebhook(body, `t=${t},v1=${sig}`, SECRET);
    expect(res.valid).toBe(true);
  });

  it("accepts when v1 follows older v0 entries", async () => {
    const t = now();
    const sig = await stripeSign(t, body);
    const res = await verifyStripeWebhook(body, `t=${t},v0=deadbeef,v1=${sig}`, SECRET);
    expect(res.valid).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const t = now();
    const sig = await stripeSign(t, body);
    const res = await verifyStripeWebhook(body.replace("evt_1", "evt_2"), `t=${t},v1=${sig}`, SECRET);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("signature mismatch");
  });

  it("rejects a stale timestamp (replay)", async () => {
    const t = now() - 600; // 10 min old, tolerance is 5
    const sig = await stripeSign(t, body);
    const res = await verifyStripeWebhook(body, `t=${t},v1=${sig}`, SECRET);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("timestamp outside tolerance");
  });

  it("rejects a missing header", async () => {
    const res = await verifyStripeWebhook(body, null, SECRET);
    expect(res.valid).toBe(false);
  });

  it("rejects a malformed header", async () => {
    const res = await verifyStripeWebhook(body, "garbage", SECRET);
    expect(res.valid).toBe(false);
  });

  it("rejects the right signature under the wrong secret", async () => {
    const t = now();
    const sig = await stripeSign(t, body);
    const res = await verifyStripeWebhook(body, `t=${t},v1=${sig}`, "whsec_other");
    expect(res.valid).toBe(false);
  });
});
