// Multi-touch email sequence templates. Steps 2-4 are intentionally short,
// conversational, and use only {{first_name}} and {{company}} merge tags.
// Step 1 uses the per-lead body stored in D1 (carries the role-specific opener).

export interface SequenceStep {
  step: number;
  subject: string;
  body: string;
  delayDays: number; // days from the previous step's send_at
}

// Step 1 is intentionally absent here — its body is stored per-lead in
// leads.body_template (each row has a role-specific opener baked in).
export const SEQUENCE_STEPS: Record<number, SequenceStep> = {
  2: {
    step: 2,
    subject: "Re: {{company}} carrier network renewals",
    delayDays: 4,
    body: `Hi {{first_name}},

Floating this back up. One pattern worth flagging: your network providers (Spectrum, AT&T, Lumen, Verizon, take your pick) are pushing 3-year renewals hard right now to lock pricing ahead of Q3 rate increases. The usual trade is 18 months early-renewal in exchange for "rate protection." In most cases the protection isn't worth what you give up in flexibility.

If {{company}} has anything coming up on the renewal radar, even just informally, happy to take a look before you sign. Zero commitment.

Brandon`,
  },
  3: {
    step: 3,
    subject: "Re: {{company}} carrier network renewals",
    delayDays: 6,
    body: `Hi {{first_name}},

Last note from me for a stretch. Wanted to leave something useful either way.

Fastest place to find leverage on a carrier invoice: line items labeled "regulatory recovery fee," "carrier service fee," or "administrative cost recovery." They aren't taxes, they're carrier margin, and they're renegotiable. Most agents don't touch them because they don't move commission. They typically run 8-12% of your monthly invoice. For a mid-sized account that's $5k-15k a year sitting in plain sight.

That's the kind of thing I dig into in every engagement.

If it ever becomes useful to compare notes, you know where to find me.

Brandon`,
  },
  4: {
    step: 4,
    subject: "Re: {{company}} carrier network renewals",
    delayDays: 7,
    body: `Hi {{first_name}},

I'll stop showing up in your inbox after this one. Not trying to be a nuisance.

If carrier, cloud, or UCaaS becomes a priority later, the line stays open. No hard feelings either way.

Brandon`,
  },
};
