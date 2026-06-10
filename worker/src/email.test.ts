import { describe, expect, it } from "vitest";
import { buildEmail, renderTemplate } from "./email";
import type { Env, Lead } from "./types";

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 1,
    email: "jane@acme.com",
    first_name: "Jane",
    last_name: "Doe",
    company: "Acme Manufacturing",
    title: "VP of IT",
    subject_template: "Quick question, {{company}}",
    body_template: "{{first_name}},\n\nSaw {{company}} is growing. Worth a look?",
    status: "sending",
    scheduled_for: null,
    sent_at: null,
    error: null,
    unsubscribe_token: "tok123",
    resend_message_id: null,
    step: 1,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SENDER_NAME: "Signal Advisory",
    SENDER_EMAIL: "brandon@signaladvise.com",
    REPLY_TO: "brandon@signaladvise.com",
    PHYSICAL_ADDRESS: "Signal Advisory LLC, Kansas City, MO",
    UNSUBSCRIBE_BASE_URL: "https://api.signaladvise.com/u",
    ...overrides,
  } as Env;
}

describe("renderTemplate", () => {
  it("substitutes lead fields, tolerating tag whitespace", () => {
    expect(renderTemplate("Hi {{ first_name }} of {{company}}", makeLead())).toBe(
      "Hi Jane of Acme Manufacturing",
    );
  });

  it("falls back to 'there' for a missing first_name — never 'Hi ,'", () => {
    const out = renderTemplate("{{first_name}},", makeLead({ first_name: null }));
    expect(out).toBe("there,");
  });

  it("falls back for an empty-string company", () => {
    const out = renderTemplate("companies like {{company}}", makeLead({ company: "  " }));
    expect(out).toBe("companies like your team");
  });

  it("renders unknown keys as empty rather than leaking the tag", () => {
    expect(renderTemplate("x{{nonexistent}}y", makeLead())).toBe("xy");
  });
});

describe("buildEmail", () => {
  it("step 1 uses the per-lead subject and body", () => {
    const msg = buildEmail(makeLead({ step: 1 }), makeEnv());
    expect(msg.subject).toBe("Quick question, Acme Manufacturing");
    expect(msg.text).toContain("Saw Acme Manufacturing is growing.");
  });

  it("steps 2+ use the shared sequence templates", () => {
    const msg = buildEmail(makeLead({ step: 2 }), makeEnv());
    expect(msg.subject).toBe("Following up, Acme Manufacturing");
    expect(msg.text).toContain("Following up on my last note.");
  });

  it("throws for a step with no template (permanent failure, not a silent send)", () => {
    expect(() => buildEmail(makeLead({ step: 99 }), makeEnv())).toThrow(/No template for step/);
  });

  it("always carries one-click List-Unsubscribe headers", () => {
    const msg = buildEmail(makeLead(), makeEnv());
    expect(msg.headers["List-Unsubscribe"]).toBe("<https://api.signaladvise.com/u?t=tok123>");
    expect(msg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("includes the CAN-SPAM physical address in text and html", () => {
    const msg = buildEmail(makeLead(), makeEnv());
    expect(msg.text).toContain("Signal Advisory LLC, Kansas City, MO");
    expect(msg.html).toContain("Signal Advisory LLC, Kansas City, MO");
  });

  it("prefers the dedicated cold-outreach identity when configured", () => {
    const msg = buildEmail(
      makeLead(),
      makeEnv({
        OUTREACH_SENDER_NAME: "Brandon at Signal Advisory",
        OUTREACH_SENDER_EMAIL: "brandon@colddomain.com",
      }),
    );
    expect(msg.from).toBe("Brandon at Signal Advisory <brandon@colddomain.com>");
  });

  it("falls back to the primary identity when no outreach identity is set", () => {
    const msg = buildEmail(makeLead(), makeEnv());
    expect(msg.from).toBe("Signal Advisory <brandon@signaladvise.com>");
  });

  it("escapes HTML in lead-provided values", () => {
    const msg = buildEmail(
      makeLead({ body_template: "{{first_name}}", first_name: `<script>alert(1)</script>` }),
      makeEnv(),
    );
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });
});
