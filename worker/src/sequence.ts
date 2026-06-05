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
    subject: "Following up, {{company}}",
    delayDays: 4,
    body: `{{first_name}},

Following up on my last note. The reason I reach out to companies like {{company}} is simple. When no single person owns all the technology contracts, costs drift up and renewals get signed without anyone checking the market.

I look at what you pay now, compare it to what is available, and tell you where the room is. There is no cost to look.

Are you open to a short call this week or next?`,
  },
  3: {
    step: 3,
    subject: "What a quick review usually finds",
    delayDays: 6,
    body: `{{first_name}},

One more from me. When I review a company's invoices, the savings usually come from three places: rates that sit above market, services no one uses anymore, and fees buried in the bill that are not actually taxes.

For a company your size, that often adds up to real money over a year.

Send me one recent invoice and I will show you what I would target before we even talk. Or we grab 15 minutes. Whichever is easier for you.`,
  },
  4: {
    step: 4,
    subject: "Closing the loop",
    delayDays: 7,
    body: `{{first_name}},

I will stop reaching out after this one. I do not want to crowd your inbox.

If lowering technology costs or cleaning up vendor contracts ever becomes a priority, I am easy to find. The first look is always free.

Wishing you the best either way.`,
  },
};
