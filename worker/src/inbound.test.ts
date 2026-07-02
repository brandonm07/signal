import { describe, expect, it } from "vitest";
import { leadIdFromRecipients } from "./inbound";
import { replyToWithLeadTag } from "./email";

describe("replyToWithLeadTag", () => {
  it("injects the lead tag before the @", () => {
    expect(replyToWithLeadTag("brandon@signaladvise.com", 42)).toBe(
      "brandon+lead42@signaladvise.com",
    );
  });

  it("passes through addresses it cannot tag", () => {
    expect(replyToWithLeadTag("not-an-address", 42)).toBe("not-an-address");
    expect(replyToWithLeadTag("@nodomain.com", 42)).toBe("@nodomain.com");
  });
});

describe("leadIdFromRecipients", () => {
  it("reads the tag from a bare address", () => {
    expect(leadIdFromRecipients("brandon+lead42@signaladvise.com")).toBe(42);
  });

  it("reads the tag from a display-name recipient", () => {
    expect(
      leadIdFromRecipients('"Brandon" <brandon+lead7@signaladvise.com>'),
    ).toBe(7);
  });

  it("reads the tag from a multi-recipient header", () => {
    expect(
      leadIdFromRecipients(
        "someone@else.com, Brandon <brandon+lead123@signaladvise.com>",
      ),
    ).toBe(123);
  });

  it("is case-insensitive", () => {
    expect(leadIdFromRecipients("brandon+LEAD9@signaladvise.com")).toBe(9);
  });

  it("returns null when no tag is present", () => {
    expect(leadIdFromRecipients("brandon@signaladvise.com")).toBeNull();
    expect(leadIdFromRecipients("")).toBeNull();
    expect(leadIdFromRecipients("brandon+other@signaladvise.com")).toBeNull();
  });

  it("round-trips with replyToWithLeadTag", () => {
    const tagged = replyToWithLeadTag("brandon@signaladvise.com", 314);
    expect(leadIdFromRecipients(`Reply <${tagged}>`)).toBe(314);
  });
});
