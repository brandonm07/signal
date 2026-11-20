import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutOutcome,
  formatMoney,
  handlePayInvoice,
  handleSendInvoice,
  handleStripeWebhook,
  handleVoidInvoice,
  serveInvoicePage,
} from "./invoices";
import { notifyOwner, sendEmail } from "./shared";
import type { Env } from "./types";

vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  sendEmail: vi.fn(async () => true),
  notifyOwner: vi.fn(async () => true),
}));

describe("formatMoney", () => {
  it("formats zero", () => {
    expect(formatMoney(0)).toBe("$0.00 USD");
  });
  it("formats cents with grouping", () => {
    expect(formatMoney(123456)).toBe("$1,234.56 USD");
  });
  it("pads single-digit cents", () => {
    expect(formatMoney(1005)).toBe("$10.05 USD");
  });
  it("formats negative amounts", () => {
    expect(formatMoney(-123456)).toBe("-$1,234.56 USD");
  });
  it("upcases the currency", () => {
    expect(formatMoney(500, "usd")).toBe("$5.00 USD");
  });
  it("never hits float arithmetic (integer cents in, exact string out)", () => {
    expect(formatMoney(1)).toBe("$0.01 USD");
    expect(formatMoney(10)).toBe("$0.10 USD");
    expect(formatMoney(2999999999)).toBe("$29,999,999.99 USD");
  });
});

describe("checkoutOutcome", () => {
  it("treats a completed session with payment_status paid as paid", () => {
    expect(checkoutOutcome("checkout.session.completed", { payment_status: "paid" })).toBe("paid");
  });
  it("treats a completed ACH session (unpaid) as pending, never paid", () => {
    expect(checkoutOutcome("checkout.session.completed", { payment_status: "unpaid" })).toBe("pending");
  });
  it("ignores a completed session with a missing or unknown payment_status", () => {
    expect(checkoutOutcome("checkout.session.completed", {})).toBe("ignore");
    expect(checkoutOutcome("checkout.session.completed", undefined)).toBe("ignore");
    expect(checkoutOutcome("checkout.session.completed", { payment_status: "whatever" })).toBe("ignore");
  });
  it("maps the async events regardless of payload", () => {
    expect(checkoutOutcome("checkout.session.async_payment_succeeded", {})).toBe("paid");
    expect(checkoutOutcome("checkout.session.async_payment_failed", {})).toBe("failed");
  });
  it("ignores unrelated event types", () => {
    expect(checkoutOutcome("payment_intent.succeeded", { payment_status: "paid" })).toBe("ignore");
  });
});

describe("invoice payment lifecycle", () => {
  const SECRET = "whsec_invoices_test_secret";
  const TOKEN = "a".repeat(32);

  const INVOICE = {
    id: 8,
    client_id: 3,
    invoice_number: "SA-2026-0008",
    description: null,
    total_cents: 40000,
    currency: "usd",
    status: "sent",
    view_token: TOKEN,
    due_date: 1789000000,
    paid_at: null,
    created_at: 1788900000,
  };
  const CLIENT = {
    id: 3,
    company_legal_name: "Test Church",
    signatory_name: "Pat",
    email: "pat@example.org",
    address_line1: null,
    address_line2: null,
    city: null,
    state: null,
    postal_code: null,
  };
  const LINES = [{ description: "Website deposit", quantity: 1, unit_amount_cents: 40000, amount_cents: 40000 }];

  // Stateful enough to behave like D1 where it matters: the event ledger enforces
  // UNIQUE and honors DELETE, and the conditional "processing" UPDATE reports
  // changes only when the invoice really is processing.
  function fakeDb(opts: { invoiceStatus?: string; seededEvents?: string[]; failPaidUpdateOnce?: boolean } = {}) {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const events = new Set(opts.seededEvents ?? []);
    let failPaidUpdate = opts.failPaidUpdateOnce ?? false;
    const invoice = { ...INVOICE, status: opts.invoiceStatus ?? "sent" };
    return {
      calls,
      events,
      prepare(sql: string) {
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              calls.push({ sql, args });
              if (sql.includes("INSERT INTO invoice_events")) {
                const id = String(args[1]);
                if (events.has(id)) throw new Error("D1_ERROR: UNIQUE constraint failed: invoice_events.stripe_event_id");
                events.add(id);
              }
              if (sql.includes("DELETE FROM invoice_events")) events.delete(String(args[0]));
              if (failPaidUpdate && sql.includes("status = 'paid'")) {
                failPaidUpdate = false;
                throw new Error("D1_ERROR: transient failure");
              }
              const changes = sql.includes("AND status = 'processing'") && invoice.status !== "processing" ? 0 : 1;
              return { meta: { changes } };
            },
            first: async () => (sql.includes("FROM invoices") ? invoice : sql.includes("FROM clients") ? CLIENT : null),
            all: async () => ({ results: LINES }),
          }),
        };
      },
    };
  }
  type FakeDb = ReturnType<typeof fakeDb>;

  const envFor = (db: FakeDb) => ({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }) as unknown as Env;

  async function sign(t: number, body: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
    return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function eventBody(type: string, session: Record<string, unknown>): string {
    return JSON.stringify({
      id: "evt_1",
      type,
      data: { object: { id: "cs_live_1", payment_intent: "pi_1", metadata: { invoice_id: "8" }, ...session } },
    });
  }

  async function deliver(db: FakeDb, body: string, signature?: string): Promise<Response> {
    const t = Math.floor(Date.now() / 1000);
    const header = signature ?? `t=${t},v1=${await sign(t, body)}`;
    return handleStripeWebhook(
      new Request("https://api.signaladvise.com/webhook/stripe", {
        method: "POST",
        headers: { "stripe-signature": header },
        body,
      }),
      envFor(db),
    );
  }

  const paidUpdates = (db: FakeDb) => db.calls.filter((c) => c.sql.includes("status = 'paid'"));
  const stateWrites = (db: FakeDb) => db.calls.filter((c) => !c.sql.includes("invoice_events"));
  const emailedClient = () => vi.mocked(sendEmail).mock.calls.some(([, msg]) => msg.to === CLIENT.email);
  const ownerAlerts = () => vi.mocked(notifyOwner).mock.calls;

  beforeEach(() => {
    vi.mocked(sendEmail).mockClear();
    vi.mocked(notifyOwner).mockClear();
  });

  describe("webhook: bank (ACH) payments", () => {
    it("moves the invoice to processing, without a paid mark or receipt, when ACH completes as unpaid", async () => {
      const db = fakeDb();
      const res = await deliver(db, eventBody("checkout.session.completed", { payment_status: "unpaid" }));
      expect(res.status).toBe(200);
      expect(paidUpdates(db)).toHaveLength(0);
      expect(emailedClient()).toBe(false);
      const processing = db.calls.find((c) => c.sql.includes("status = 'processing'"));
      expect(processing?.args).toEqual([8, "pi_1"]);
      expect(ownerAlerts()).toHaveLength(1);
      expect(ownerAlerts()[0]![1]).toBe("⏳ Invoice SA-2026-0008 — bank payment started, not yet paid");
    });

    it.each(["processing", "paid", "void"])("ignores a pending event for an invoice that is already %s", async (status) => {
      const db = fakeDb({ invoiceStatus: status });
      await deliver(db, eventBody("checkout.session.completed", { payment_status: "unpaid" }));
      expect(stateWrites(db)).toHaveLength(0);
      expect(ownerAlerts()).toHaveLength(0);
    });

    it("marks paid when the delayed ACH payment later succeeds", async () => {
      const db = fakeDb({ invoiceStatus: "processing" });
      await deliver(db, eventBody("checkout.session.async_payment_succeeded", { payment_status: "paid" }));
      expect(paidUpdates(db)).toHaveLength(1);
      expect(paidUpdates(db)[0]!.args).toEqual([8, "pi_1"]);
      expect(emailedClient()).toBe(true);
    });

    it("reopens a processing invoice for a fresh payment when the delayed payment fails", async () => {
      const db = fakeDb({ invoiceStatus: "processing" });
      await deliver(db, eventBody("checkout.session.async_payment_failed", { payment_status: "unpaid" }));
      expect(paidUpdates(db)).toHaveLength(0);
      expect(emailedClient()).toBe(false);
      const reopen = db.calls.find((c) => c.sql.includes("status = 'sent'"));
      expect(reopen?.sql).toContain("stripe_checkout_session_id = NULL");
      expect(reopen?.args).toEqual([8]);
      expect(ownerAlerts()[0]![1]).toBe("⚠️  Invoice payment failed (invoice id 8)");
      expect(ownerAlerts()[0]![2]).toContain("payable again");
    });

    it("alerts the owner without changing status when the failed payment's invoice was not processing", async () => {
      const db = fakeDb({ invoiceStatus: "paid" });
      await deliver(db, eventBody("checkout.session.async_payment_failed", { payment_status: "unpaid" }));
      expect(ownerAlerts()).toHaveLength(1);
      expect(ownerAlerts()[0]![2]).toContain("status is unchanged");
    });
  });

  describe("webhook: card payments and safety", () => {
    it("marks paid, receipts the client, and notifies the owner when a card payment completes as paid", async () => {
      const db = fakeDb();
      await deliver(db, eventBody("checkout.session.completed", { payment_status: "paid" }));
      expect(paidUpdates(db)).toHaveLength(1);
      expect(paidUpdates(db)[0]!.args).toEqual([8, "pi_1"]);
      expect(emailedClient()).toBe(true);
      expect(ownerAlerts()).toHaveLength(1);
      expect(ownerAlerts()[0]![1]).toBe("💰 Invoice SA-2026-0008 paid — $400.00 USD");
    });

    it("does not resend receipts when the invoice is already paid", async () => {
      const db = fakeDb({ invoiceStatus: "paid" });
      await deliver(db, eventBody("checkout.session.async_payment_succeeded", { payment_status: "paid" }));
      expect(paidUpdates(db)).toHaveLength(0);
      expect(emailedClient()).toBe(false);
    });

    it("rejects a bad signature before touching the database", async () => {
      const db = fakeDb();
      const t = Math.floor(Date.now() / 1000);
      const res = await deliver(
        db,
        eventBody("checkout.session.completed", { payment_status: "paid" }),
        `t=${t},v1=${"0".repeat(64)}`,
      );
      expect(res.status).toBe(401);
      expect(db.calls).toHaveLength(0);
    });

    it("swallows a duplicate event delivery without re-running any handler", async () => {
      const db = fakeDb({ seededEvents: ["evt_1"] });
      const res = await deliver(db, eventBody("checkout.session.completed", { payment_status: "paid" }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("duplicate");
      expect(paidUpdates(db)).toHaveLength(0);
      expect(ownerAlerts()).toHaveLength(0);
    });

    it("records the payment when Stripe retries after a transient database error", async () => {
      const db = fakeDb({ failPaidUpdateOnce: true });
      const body = eventBody("checkout.session.completed", { payment_status: "paid" });

      await expect(deliver(db, body)).rejects.toThrow("transient failure");
      expect(db.events.has("evt_1")).toBe(false);

      const retry = await deliver(db, body);
      expect(retry.status).toBe(200);
      expect(await retry.text()).toBe("ok");
      expect(paidUpdates(db)).toHaveLength(2);
      expect(db.events.has("evt_1")).toBe(true);
      expect(emailedClient()).toBe(true);
    });
  });

  describe("processing invoices on the client-facing and admin paths", () => {
    it("shows a processing notice, with no pay button or pay link", async () => {
      const res = await serveInvoicePage(TOKEN, envFor(fakeDb({ invoiceStatus: "processing" })));
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("Bank payment in progress");
      expect(html).not.toContain("/pay");
      expect(html).not.toContain("Pay $400.00");
      expect(html).not.toContain("Paid in full");
    });

    it("still shows the pay button for an unpaid invoice and 'Paid in full' for a paid one", async () => {
      const sent = await (await serveInvoicePage(TOKEN, envFor(fakeDb()))).text();
      expect(sent).toContain(`/i/${TOKEN}/pay`);
      const paid = await (await serveInvoicePage(TOKEN, envFor(fakeDb({ invoiceStatus: "paid" })))).text();
      expect(paid).toContain("Paid in full");
    });

    it("sends the payer back to the invoice page instead of minting a second Checkout Session", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Stripe must not be called"));
      try {
        const res = await handlePayInvoice(TOKEN, envFor(fakeDb({ invoiceStatus: "processing" })));
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`https://api.signaladvise.com/i/${TOKEN}`);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("refuses to re-send or void an invoice while a bank payment is in flight", async () => {
      const db = fakeDb({ invoiceStatus: "processing" });
      const send = await handleSendInvoice(8, envFor(db));
      expect(send.status).toBe(409);
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      const voided = await handleVoidInvoice(8, envFor(db));
      expect(voided.status).toBe(409);
      expect(stateWrites(db)).toHaveLength(0);
    });
  });
});
