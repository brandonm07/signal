-- Local KC-metro prospect campaign (hand-collected business cards).
-- "Exclusive" handling = one segment tag on the existing, proven leads
-- pipeline (at-most-once, suppression, idempotency, throttle all inherited),
-- not a separate database. Step-1 openers are industry-specific per lead;
-- steps 2-4 reuse SEQUENCE_STEPS. Cold framing (recipients were NOT met).
--
-- SAFETY: inserted as status='paused' so they do NOT send when this migration
-- is applied. Release with one statement when ready:
--   UPDATE leads SET status='queued' WHERE segment='local-2026' AND status='paused';
-- They then drip out under DAILY_CAP + send window, from the OUTREACH_SENDER_* identity.

ALTER TABLE leads ADD COLUMN segment TEXT;

INSERT OR IGNORE INTO leads
  (email, first_name, last_name, company, title, subject_template, body_template, status, segment, unsubscribe_token)
VALUES
-- 1. Manning GC — exterior general contractor
('Braxton@ManningGC.com','Braxton','Vardys','Manning GC','Project Manager',
 'Manning''s wireless + internet bills',
 '{{first_name}}, quick one. I''m an independent technology advisor here in the metro — I audit and renegotiate business telecom, internet, and wireless contracts with the carriers on the company''s behalf. Carrier-neutral, no cost to look.

With crews spread across job sites running phones, tablets, and trucks, those bills quietly bloat — extra lines, data overages, services nobody canceled.

Send me one recent invoice and I''ll show you where I''d target before we even talk — or grab 15 minutes, whichever''s easier.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 2. Hoffmann Brothers — home services (HVAC/plumbing/electrical)
('adam.brooks@hoffmannbros.com','Adam','Brooks','Hoffmann Brothers','Director of Fleet',
 'Hoffmann Brothers'' wireless bill',
 '{{first_name}}, I''ll be direct. I''m an independent technology advisor in the metro.

With a fleet and field team your size, the wireless bill is usually one of the messiest costs in the building — dozens of lines, data overages, devices still billing long after they''re retired.

I audit exactly that and renegotiate it with the carriers for you. Carrier-neutral, no cost to look.

Worth 15 minutes to see what''s hiding in it?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 3. Bothwell Regional Health Center — Materials Management (buyer)
('rlangdon@brhc.org','Rick','Langdon','Bothwell Regional Health Center','Director of Materials Management',
 'Bothwell''s telecom contracts',
 '{{first_name}}, quick one given your seat over vendor contracts. I''m an independent technology advisor — I audit and renegotiate telecom, internet, and wireless spend with the carriers on the organization''s behalf.

Hospital connectivity — circuits, internet redundancy, wireless, the long tail of recurring line items — almost always has room and rarely gets a market check.

Carrier-neutral, no cost to look. Worth 15 minutes to compare what Bothwell pays against what''s available?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 4. Bothwell — LAN/WAN (commercials angle)
('gsims@brhc.org','Grace','Sims','Bothwell Regional Health Center','LAN/WAN Administrator',
 'Carrier circuits at Bothwell',
 '{{first_name}}, I work with hospital IT teams on the carrier side of the network — the data circuits, internet, and wireless contracts behind the WAN you run.

Not the architecture, just the commercials: rates, terms, and the line items that linger after circuits change. I benchmark and renegotiate them with the carriers, carrier-neutral, no cost to look.

If contract and cost isn''t your lane, point me to who owns it. Worth a quick 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 5. Bothwell — LAN/WAN (right-size angle)
('jneas@brhc.org','Jeff','Neas','Bothwell Regional Health Center','LAN/WAN Administrator',
 'Bothwell''s WAN circuits — paying for what you use?',
 '{{first_name}}, quick one for the network side. When a hospital''s WAN evolves — sites added, bandwidth bumped, links made redundant — the carrier contracts rarely keep pace, so you pay for circuits and tiers that no longer match reality.

I''m an independent advisor who audits exactly that and renegotiates with the carriers, carrier-neutral, no cost to look.

If it''s more a purchasing call, happy to be pointed there. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 6. P1 Service — multi-branch mechanical service
('pwinter@p1-service.com','Peter','Winter','P1 Service, LLC','IT Technician',
 'P1''s telecom across branches',
 '{{first_name}}, I work with multi-branch service companies like P1 on something that usually sits half-in IT''s lap: the telecom, internet, and wireless bills. Across branches and field techs they sprawl fast and rarely get benchmarked.

I audit and renegotiate that independently — carrier-neutral, no cost to look.

If it''s not your area, point me to whoever owns those contracts and I''ll take it from there. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 7. Epic Landscape Productions — commercial landscaping
('tyconstant@epicland.net','Ty','Constant','Epic Landscape Productions','',
 'Epic''s wireless + internet',
 '{{first_name}}, quick one. I''m an independent technology advisor in the metro — I audit and renegotiate business telecom, internet, and wireless contracts with the carriers for you.

With seasonal crews, trucks, and phones in the field, those bills swing and sprawl — lines that should''ve been suspended, data overages, charges nobody''s checked in a while.

Carrier-neutral, no cost to look. Worth 15 minutes to see what''s in there?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 8. Tempcon — Operations (field/ops angle)
('don@tempcon.net','Don','Winders','Tempcon','Operations Manager',
 'Tempcon''s field wireless',
 '{{first_name}}, quick one for the ops side. Running an HVAC field operation means a pile of wireless lines, tablets, and trucks — and those carrier bills quietly bloat with overages and lines that outlive the techs who carried them.

I''m an independent advisor who audits and renegotiates that with the carriers, carrier-neutral, no cost to look.

Worth 15 minutes to see what''s hiding in Tempcon''s bills?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 9. Tempcon — Purchasing (vendor/cost angle)
('kmendoza@tempcon.net','Katrina','Mendoza','Tempcon','Purchasing Agent',
 'Tempcon''s carrier contracts',
 '{{first_name}}, quick one since purchasing''s in your lane. I''m an independent technology advisor — I audit and renegotiate telecom, internet, and wireless contracts with the carriers on the company''s behalf.

They''re some of the few recurring vendor costs that rarely get a market check — rates above market, services no one uses, fees that aren''t actually taxes.

Carrier-neutral, no cost to look. Send me one recent invoice and I''ll show you where I''d target. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 10. Tompkins Industries — fluid power manufacturer-distributor
('cjackson@tompkinsind.com','Chris','Jackson','Tompkins Industries, Inc.','Chief Operating Officer',
 'Tompkins'' telecom spend',
 '{{first_name}}, quick one. I''m an independent technology advisor in the metro — I audit and renegotiate business telecom, internet, and wireless contracts with the carriers on the company''s behalf. Carrier-neutral, no cost to look.

For a distributor like Tompkins — multiple sites, the data circuits linking them, a mobile fleet — those bills rarely get a market check, and there''s usually room.

Send me one recent invoice and I''ll show you where I''d target before we even talk. Or grab 15 minutes.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 11. Cobb Refrigeration (a Temp-Con company) — President
('luke@tempcon.net','Luke','Chambers','Cobb Refrigeration','President',
 'Cobb''s telecom spend',
 '{{first_name}}, quick one for your desk. I''m an independent technology advisor in the metro — I audit and renegotiate business telecom, internet, and wireless contracts with the carriers on the company''s behalf. Carrier-neutral, no cost to look.

Across a refrigeration and HVAC field operation — trucks, techs, multiple sites — those bills rarely get a market check, and what I find usually drops straight to the bottom line.

Worth 15 minutes, or send me a recent invoice and I''ll show you where I''d target first?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 12. RadSource Imaging Technologies — medical imaging tech/service
('bnordling@radsource.net','Burk','Nordling','RadSource Imaging Technologies','IT Services Director',
 'RadSource''s telecom + connectivity spend',
 '{{first_name}}, I work with IT leaders on the carrier side of their stack — the telecom, internet, and wireless contracts behind the systems you run.

I audit and renegotiate them with the carriers, carrier-neutral, no cost to look — rates, terms, and the recurring line items that linger after things change.

For a multi-site imaging-tech operation, that spend rarely gets benchmarked. Worth 15 minutes to see where RadSource stands against the market?',
 'paused','local-2026',lower(hex(randomblob(16))));
