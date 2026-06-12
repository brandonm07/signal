import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  randomHex,
  safeEqual,
  signToken,
  verifyToken,
  verifySvix,
  nowSec,
} from "./shared";

describe("escapeHtml", () => {
  it("escapes all five dangerous characters", () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;",
    );
  });
  it("handles null/undefined/numbers", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("randomHex", () => {
  it("returns 2 hex chars per byte", () => {
    const t = randomHex(16);
    expect(t).toMatch(/^[a-f0-9]{32}$/);
  });
  it("is not constant", () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("safeEqual", () => {
  it("matches equal strings", () => {
    expect(safeEqual("secret-token", "secret-token")).toBe(true);
  });
  it("rejects different strings of equal length", () => {
    expect(safeEqual("aaaa", "aaab")).toBe(false);
  });
  it("rejects different lengths", () => {
    expect(safeEqual("short", "longer-string")).toBe(false);
  });
  it("matches empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("signToken / verifyToken", () => {
  const SECRET = "test-secret-please-ignore";

  it("round-trips a payload", async () => {
    const token = await signToken(SECRET, { cid: 7, exp: nowSec() + 60 });
    const payload = await verifyToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.cid).toBe(7);
  });

  it("rejects an expired token", async () => {
    const token = await signToken(SECRET, { cid: 7, exp: nowSec() - 1 });
    expect(await verifyToken(SECRET, token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signToken(SECRET, { cid: 7, exp: nowSec() + 60 });
    const [, sig] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
    const forged = btoa(JSON.stringify({ cid: 999, exp: nowSec() + 60 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyToken(SECRET, `${forged}.${sig}`)).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signToken("other-secret", { adm: true, exp: nowSec() + 60 });
    expect(await verifyToken(SECRET, token)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyToken(SECRET, "")).toBeNull();
    expect(await verifyToken(SECRET, "no-dot-here")).toBeNull();
    expect(await verifyToken(SECRET, "a.b")).toBeNull();
  });

  it("admin claim does not verify as a portal claim shape", async () => {
    const token = await signToken(SECRET, { adm: true, exp: nowSec() + 60 });
    const payload = await verifyToken(SECRET, token);
    expect(payload!.adm).toBe(true);
    expect(typeof payload!.cid).not.toBe("number");
  });
});

// --- svix (Resend webhook) verification ---

const SVIX_KEY_BYTES = new TextEncoder().encode("svix-test-secret");
const SVIX_SECRET = "whsec_" + btoa(String.fromCharCode(...SVIX_KEY_BYTES));

async function svixSign(id: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", SVIX_KEY_BYTES, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

describe("verifySvix", () => {
  const body = `{"type":"email.delivered","data":{"to":["a@b.com"]}}`;
  const id = "msg_123";

  it("accepts a valid signature within tolerance", async () => {
    const now = nowSec();
    const sig = await svixSign(id, now, body);
    const ok = await verifySvix(
      { id, timestamp: String(now), signature: `v1,${sig}` },
      body, SVIX_SECRET, now,
    );
    expect(ok).toBe(true);
  });

  it("accepts when the valid signature is one of several candidates", async () => {
    const now = nowSec();
    const sig = await svixSign(id, now, body);
    const ok = await verifySvix(
      { id, timestamp: String(now), signature: `v1,bogus= v1,${sig}` },
      body, SVIX_SECRET, now,
    );
    expect(ok).toBe(true);
  });

  it("rejects a bad signature", async () => {
    const now = nowSec();
    const ok = await verifySvix(
      { id, timestamp: String(now), signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      body, SVIX_SECRET, now,
    );
    expect(ok).toBe(false);
  });

  it("rejects a replayed (stale) timestamp", async () => {
    const now = nowSec();
    const old = now - 600; // 10 minutes ago, tolerance is 5
    const sig = await svixSign(id, old, body);
    const ok = await verifySvix(
      { id, timestamp: String(old), signature: `v1,${sig}` },
      body, SVIX_SECRET, now,
    );
    expect(ok).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const now = nowSec();
    const sig = await svixSign(id, now, body);
    const ok = await verifySvix(
      { id, timestamp: String(now), signature: `v1,${sig}` },
      body.replace("a@b.com", "evil@x.com"), SVIX_SECRET, now,
    );
    expect(ok).toBe(false);
  });

  it("rejects missing headers", async () => {
    expect(await verifySvix({ id: null, timestamp: "1", signature: "v1,x" }, body, SVIX_SECRET)).toBe(false);
    expect(await verifySvix({ id, timestamp: null, signature: "v1,x" }, body, SVIX_SECRET)).toBe(false);
    expect(await verifySvix({ id, timestamp: "1", signature: null }, body, SVIX_SECRET)).toBe(false);
  });
});
