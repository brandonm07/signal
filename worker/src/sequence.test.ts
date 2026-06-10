import { describe, expect, it } from "vitest";
import { SEQUENCE_STEPS, nextSequenceState } from "./sequence";

const NOW = 1_750_000_000;

describe("nextSequenceState", () => {
  it("advances step 1 → 2, queued 4 days out", () => {
    const s = nextSequenceState(1, NOW);
    expect(s).toEqual({ status: "queued", step: 2, scheduledFor: NOW + 4 * 86400 });
  });

  it("advances step 2 → 3, queued 6 days out", () => {
    const s = nextSequenceState(2, NOW);
    expect(s).toEqual({ status: "queued", step: 3, scheduledFor: NOW + 6 * 86400 });
  });

  it("advances step 3 → 4, queued 7 days out", () => {
    const s = nextSequenceState(3, NOW);
    expect(s).toEqual({ status: "queued", step: 4, scheduledFor: NOW + 7 * 86400 });
  });

  it("completes after the final step — no further sends, ever", () => {
    const s = nextSequenceState(4, NOW);
    expect(s).toEqual({ status: "completed", step: 4, scheduledFor: null });
  });

  it("stays consistent with SEQUENCE_STEPS delays if templates change", () => {
    for (const [stepStr, tpl] of Object.entries(SEQUENCE_STEPS)) {
      const prev = Number(stepStr) - 1;
      const s = nextSequenceState(prev, NOW);
      expect(s.status).toBe("queued");
      expect(s.step).toBe(tpl.step);
      expect(s.scheduledFor).toBe(NOW + tpl.delayDays * 86400);
    }
  });
});

describe("SEQUENCE_STEPS content invariants", () => {
  it("every template body is short enough to read like a 1:1 email (<150 words)", () => {
    for (const tpl of Object.values(SEQUENCE_STEPS)) {
      const words = tpl.body.split(/\s+/).length;
      expect(words, `step ${tpl.step} body has ${words} words`).toBeLessThan(150);
    }
  });

  it("no template contains spam-bait formatting (ALL-CAPS runs, $$, !!)", () => {
    for (const tpl of Object.values(SEQUENCE_STEPS)) {
      expect(tpl.subject + tpl.body).not.toMatch(/[A-Z]{6,}|\${2,}|!{2,}/);
    }
  });

  it("only uses merge tags that have fallbacks (first_name, company)", () => {
    for (const tpl of Object.values(SEQUENCE_STEPS)) {
      const tags = [...(tpl.subject + tpl.body).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
      for (const tag of tags) {
        expect(["first_name", "company"], `step ${tpl.step} uses unsupported tag {{${tag}}}`).toContain(tag);
      }
    }
  });
});
