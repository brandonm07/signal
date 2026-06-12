export interface Env {
  DB: D1Database;
  AUDIT_UPLOADS: R2Bucket;
  PITCHER_QUEUE: Queue<QueueJob>;
  RESEND_API_KEY: string;
  SENDER_EMAIL: string;
  SENDER_NAME: string;
  // Cold-outreach sender identity. Falls back to SENDER_* when unset.
  // Point OUTREACH_SENDER_EMAIL at a dedicated cold domain to protect the
  // primary domain's transactional reputation.
  OUTREACH_SENDER_NAME?: string;
  OUTREACH_SENDER_EMAIL?: string;
  REPLY_TO: string;
  PHYSICAL_ADDRESS: string;
  UNSUBSCRIBE_BASE_URL: string;
  DAILY_CAP: string;
  SEND_WINDOW_TZ: string;
  SEND_WINDOW_START_HOUR: string;
  SEND_WINDOW_END_HOUR: string;
  JITTER_MAX_SECONDS: string;
  CALENDLY_URL: string;
  GMAIL_USER: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  DRAFT_MODE: string; // "1" = create drafts, "0" = auto-send
  ADMIN_SECRET: string;
  // Dedicated HMAC key for portal sessions/magic links. Falls back to
  // ADMIN_SECRET until set: wrangler secret put PORTAL_SIGNING_SECRET
  PORTAL_SIGNING_SECRET?: string;
  RESEND_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PUBLISHABLE_KEY?: string;
}

export interface Lead {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  subject_template: string;
  body_template: string;
  status: string;
  scheduled_for: number | null;
  sent_at: number | null;
  error: string | null;
  unsubscribe_token: string;
  resend_message_id: string | null;
  step: number;
  // Overnight ICP scoring (migration 0009). Null until scored; -1 marks a
  // scoring error so the nightly job doesn't retry the same bad row forever.
  lead_score?: number | null;
  lead_tier?: string | null;
  score_reason?: string | null;
  opening_angle?: string | null;
  scored_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface QueueJob {
  leadId: number;
}

export type Intent = "meeting" | "unsubscribe" | "bounce" | "ooo" | "other";

export interface ClassifiedReply {
  intent: Intent;
  confidence: number;
  reasoning: string;
}
