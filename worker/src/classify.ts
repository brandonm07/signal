// Claude-based intent classifier for inbound replies.
import type { ClassifiedReply, Env, Intent } from "./types";

const SYSTEM_PROMPT = `You classify replies to a B2B cold sales email into ONE intent.

Original outbound: a short pitch from Signal Advisory (independent telecom/cloud/UCaaS broker) ending with "Worth 15 minutes to look at what's coming up?"

Intents:
- meeting: prospect is open to or asking about a meeting/call (any positive engagement: "yes", "send time", "let's chat", asking about availability, asking what we do, asking for more info, "tell me more", "interested")
- unsubscribe: explicit request to be removed, stop emailing, opt out, "remove me", "not interested do not contact", "take me off your list"
- bounce: delivery failure / mailbox-not-found / NDR. Almost always from mailer-daemon@, postmaster@, or noreply MTAs. Body explicitly says "could not be delivered" or "delivery failed" or "address not found". Do NOT classify product announcements, security codes, marketing emails, or normal automated notifications as bounce.
- ooo: out-of-office, vacation responder, "I am out", "will reply when I return"
- other: anything else (objection like "we're already covered", "wrong person", forward request, complaint, product notifications, security codes, transactional emails, etc.)

Be lenient on the meeting bucket — if there's any positive engagement (curiosity, request for info, asking what we do), classify as meeting.
Be strict on unsubscribe — only classify as unsubscribe if the prospect explicitly asks to stop or opt out.

Output JSON only: {"intent":"<intent>","confidence":0..1,"reasoning":"<one sentence>"}`;

export async function classifyReply(
  env: Env,
  subject: string,
  bodyText: string,
  fromEmail: string,
): Promise<ClassifiedReply> {
  const userMsg =
    `From: ${fromEmail}\n` +
    `Subject: ${subject}\n` +
    `Body:\n${truncate(bodyText, 2000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  const text = json.content.find((c) => c.type === "text")?.text ?? "";
  return parseJsonResult(text);
}

function parseJsonResult(s: string): ClassifiedReply {
  // Strip code fences if present
  const cleaned = s
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: { intent?: string; confidence?: number; reasoning?: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract first { ... } block
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { intent: "other", confidence: 0 };
  }
  const intent: Intent = isIntent(parsed.intent) ? parsed.intent : "other";
  return {
    intent,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    reasoning: parsed.reasoning ?? "",
  };
}

function isIntent(v: unknown): v is Intent {
  return (
    v === "meeting" ||
    v === "unsubscribe" ||
    v === "bounce" ||
    v === "ooo" ||
    v === "other"
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n[…truncated]";
}
