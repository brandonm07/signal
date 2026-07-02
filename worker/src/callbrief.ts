// Daily call brief: every weekday morning, email Brandon a ready-to-dial
// sheet of the 5 warmest prospects, ranked by engagement (email opens) then
// ICP score. Each entry carries a call opener and a 20-second voicemail
// script so the only remaining work is dialing.
//
// Opens rank the call sheet but must never drive automated sends: pixel
// "opens" include mail-client image-proxy prefetches (Apple Mail, Outlook),
// so an open is not proof a human read anything. An earlier version
// auto-accelerated 2+-open leads' next sequence step to "now" every day,
// which collapsed the 4/6/7-day cadence into consecutive daily emails for
// any lead whose client prefetched images. Do not reintroduce that.
import type { Env } from "./types";
import { OWNER_EMAIL, escapeHtml, getState, sendEmail, setState } from "./shared";

const KEY_LAST_BRIEF = "last_call_brief_ts";
const DAY_SECONDS = 24 * 60 * 60;
const BRIEF_SIZE = 5;
const REBRIEF_AFTER_DAYS = 7; // a lead can reappear on the sheet after a week

interface BriefRow {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  lead_score: number | null;
  lead_tier: string | null;
  opening_angle: string | null;
  step: number | null;
  opens: number;
}

/** Call once per cron tick. Gates itself to once per day. */
export async function maybeDailyCallBrief(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const last = await getState(env, KEY_LAST_BRIEF);
  if (last && now - last < DAY_SECONDS - 3600) return;
  await runCallBrief(env);
  await setState(env, KEY_LAST_BRIEF, now);
}

/** The actual work — exposed so /admin/brief can force a run. */
export async function runCallBrief(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Pick the call sheet: contacted leads (step 1 sent), not suppressed,
  // not briefed this week, ranked by opens then score.
  const rs = await env.DB.prepare(
    `SELECT l.id, l.email, l.first_name, l.last_name, l.company, l.title,
            l.lead_score, l.lead_tier, l.opening_angle, l.step,
            COALESCE(e.opens, 0) AS opens
       FROM leads l
       LEFT JOIN (
         SELECT recipient, COUNT(*) AS opens FROM email_events
          WHERE event_type = 'opened' GROUP BY recipient
       ) e ON e.recipient = l.email
      WHERE l.sent_at IS NOT NULL
        AND l.status IN ('queued', 'completed', 'sent')
        AND (l.lead_score IS NULL OR l.lead_score >= 40)
        AND (l.briefed_at IS NULL OR l.briefed_at < ?1)
      ORDER BY opens DESC, l.lead_score DESC NULLS LAST, l.sent_at DESC
      LIMIT ?2`,
  )
    .bind(now - REBRIEF_AFTER_DAYS * DAY_SECONDS, BRIEF_SIZE)
    .all<BriefRow>();
  const rows = rs.results ?? [];
  if (rows.length === 0) return;

  const text = buildBriefText(rows, env);
  await sendEmail(env, {
    to: OWNER_EMAIL,
    replyTo: OWNER_EMAIL,
    subject: `Call sheet: ${rows.length} prospects to dial today`,
    text,
    html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(text)}</pre>`,
  });

  // Stamp so they don't reappear tomorrow.
  for (const r of rows) {
    await env.DB.prepare(
      `UPDATE leads SET briefed_at = unixepoch() WHERE id = ?1`,
    )
      .bind(r.id)
      .run();
  }
}

function buildBriefText(rows: BriefRow[], env: Env): string {
  const lines: string[] = [
    "Today's call sheet. Ranked by email engagement, then fit.",
    "",
  ];
  rows.forEach((r, i) => {
    const who = [r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)";
    const first = r.first_name || "there";
    const company = r.company || "their company";
    const angle =
      r.opening_angle ||
      "They are likely overpaying on at least one carrier or phone contract and nobody owns the renewal calendar.";
    const heat =
      r.opens >= 2 ? `HOT: opened your email ${r.opens}x` :
      r.opens === 1 ? "WARM: opened your email" :
      "COLD: no opens tracked";

    lines.push(`${i + 1}. ${who}${r.title ? ", " + r.title : ""} at ${company}`);
    lines.push(`   ${r.email} | score ${r.lead_score ?? "n/a"} (${r.lead_tier ?? "unscored"}) | sequence step ${r.step ?? 1} | ${heat}`);
    lines.push(`   Find the number: https://www.google.com/search?q=${encodeURIComponent(`"${company}" phone`)}`);
    lines.push("");
    lines.push(`   CALL OPENER:`);
    lines.push(`   "${first}, this is Brandon Murphy with Signal Advisory in Kansas City. I sent you a note recently about ${company}'s technology contracts. ${angle} Did I catch you at an ok time?"`);
    lines.push("");
    lines.push(`   VOICEMAIL (20 sec):`);
    lines.push(`   "${first}, Brandon Murphy with Signal Advisory. I work with companies like ${company} on the buyer's side of their internet, phone, and carrier contracts. I sent you an email recently. No rush, but if you have a renewal coming up I can usually find real money in it. My number is 816-355-3350. Again, Brandon, 816-355-3350. Thanks."`);
    lines.push("");
  });
  lines.push(`Booking link to offer: ${env.CALENDLY_URL}`);
  lines.push("Pipeline: https://api.signaladvise.com/admin/ui/");
  return lines.join("\n");
}
