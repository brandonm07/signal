// Renewal Defense: scan client_contracts daily, email digest of contracts
// crossing the 180/90/30-day expiration thresholds. Idempotent — each
// tier alerts at most once per contract, gated by alerted_*_at columns.
import type { Env } from "./types";
import { sendViaResend } from "./email";

const KEY_LAST_RENEWAL_CHECK = "last_renewal_check_ts";
const DAY_SECONDS = 24 * 60 * 60;

interface ContractRow {
  id: number;
  client_id: number;
  provider: string;
  service_type: string;
  monthly_spend_cents: number;
  contract_expiration: number;
  auto_renew_notice_days: number;
  notes: string | null;
  client_name: string;
  tier: 180 | 90 | 30;
}

/** Call once per cron tick. Gates itself to fire once per day. */
export async function maybeRunRenewalAlerts(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const last = await getState(env, KEY_LAST_RENEWAL_CHECK);
  if (last && now - last < DAY_SECONDS - 3600) return;

  const tiers: Array<{ days: number; col: string }> = [
    { days: 180, col: "alerted_180_at" },
    { days: 90, col: "alerted_90_at" },
    { days: 30, col: "alerted_30_at" },
  ];

  const findings: ContractRow[] = [];
  for (const t of tiers) {
    const cutoff = now + t.days * DAY_SECONDS;
    const window = cutoff + DAY_SECONDS; // 1-day grace so a contract doesn't slip past on a missed tick
    const rs = await env.DB.prepare(
      `SELECT cc.id, cc.client_id, cc.provider, cc.service_type, cc.monthly_spend_cents,
              cc.contract_expiration, cc.auto_renew_notice_days, cc.notes,
              c.company_legal_name AS client_name
         FROM client_contracts cc
         JOIN clients c ON c.id = cc.client_id
        WHERE cc.${t.col} IS NULL
          AND cc.contract_expiration > ?1
          AND cc.contract_expiration <= ?2`,
    )
      .bind(now, window)
      .all<Omit<ContractRow, "tier">>();
    for (const r of rs.results ?? []) {
      findings.push({ ...r, tier: t.days as 180 | 90 | 30 });
    }
  }

  if (findings.length === 0) {
    await setState(env, KEY_LAST_RENEWAL_CHECK, now);
    return;
  }

  const subject = `Renewal Defense: ${findings.length} contract${findings.length === 1 ? "" : "s"} need attention`;
  const text = buildDigestText(findings, now);

  await sendViaResend(
    {
      from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
      to: "brandon@signaladvise.com",
      reply_to: "brandon@signaladvise.com",
      subject,
      text,
      html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(text)}</pre>`,
      headers: {},
    },
    env.RESEND_API_KEY,
  );

  // Stamp each row's tier column so we never re-alert this combination.
  for (const f of findings) {
    const col =
      f.tier === 180 ? "alerted_180_at" : f.tier === 90 ? "alerted_90_at" : "alerted_30_at";
    await env.DB.prepare(
      `UPDATE client_contracts SET ${col} = ?2, updated_at = unixepoch() WHERE id = ?1`,
    )
      .bind(f.id, now)
      .run();
  }

  await setState(env, KEY_LAST_RENEWAL_CHECK, now);
}

function buildDigestText(rows: ContractRow[], now: number): string {
  const lines: string[] = [];
  lines.push("Contracts crossing renewal-defense thresholds today.");
  lines.push("");

  for (const tier of [180, 90, 30] as const) {
    const group = rows.filter((r) => r.tier === tier);
    if (group.length === 0) continue;
    lines.push(`--- ${tier} days out ---`);
    for (const r of group) {
      const daysOut = Math.round((r.contract_expiration - now) / DAY_SECONDS);
      const spend = (r.monthly_spend_cents / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });
      lines.push(
        `  ${r.client_name} — ${r.provider} (${r.service_type}) — ${spend}/mo — expires in ${daysOut} days`,
      );
      if (r.auto_renew_notice_days > 0) {
        const noticeBy = r.contract_expiration - r.auto_renew_notice_days * DAY_SECONDS;
        const noticeIn = Math.round((noticeBy - now) / DAY_SECONDS);
        const stamp = noticeIn < 0 ? "PASSED" : `in ${noticeIn} days`;
        lines.push(`    Opt-out notice required ${r.auto_renew_notice_days}d prior — deadline ${stamp}`);
      }
      if (r.notes) lines.push(`    Notes: ${r.notes}`);
    }
    lines.push("");
  }

  lines.push("Manage at https://api.signaladvise.com/admin/ui/contracts");
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function getState(env: Env, key: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT value FROM worker_state WHERE key = ?1`,
  )
    .bind(key)
    .first<{ value: string }>();
  return row ? parseInt(row.value, 10) : null;
}

async function setState(env: Env, key: string, value: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO worker_state (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, String(value))
    .run();
}
