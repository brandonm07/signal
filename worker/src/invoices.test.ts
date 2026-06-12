import { describe, expect, it } from "vitest";
import { formatMoney } from "./invoices";

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
