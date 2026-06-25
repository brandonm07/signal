-- Local KC-metro prospect campaign (hand-collected business cards).
-- "Exclusive" handling = one segment tag on the existing, proven leads
-- pipeline (at-most-once, suppression, idempotency, throttle all inherited),
-- not a separate database. Step-1 openers are industry-specific per lead;
-- steps 2-4 reuse SEQUENCE_STEPS. Cold framing (recipients were NOT met).
--
-- Each opener leads with a current dynamic in the recipient's industry, names
-- the concrete telecom leak it creates, and earns the reply with Brandon's
-- 25-years-inside-the-carriers credibility + a low-effort payoff (one invoice).
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
 'More phone lines than people?',
 '{{first_name}} — most contractors I look at are paying for 20-30% more active wireless lines than they have people in the field. Crews scale up for a busy stretch, lines get added, and nobody closes them out when a job wraps or a hire leaves.

I spent 25 years inside the big carriers, so I know exactly where that waste hides — and I find and renegotiate it without you switching anything.

Forward me one recent Verizon or AT&T invoice and I''ll tell you how many lines you''re actually paying for versus how many you use. Want me to take a look?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 2. Hoffmann Brothers — home services (HVAC/plumbing/electrical)
('adam.brooks@hoffmannbros.com','Adam','Brooks','Hoffmann Brothers','Director of Fleet',
 'The carrier mess after a roll-up',
 '{{first_name}} — home-services groups are growing and acquiring faster than ever right now, and the wireless and connectivity contracts almost never get merged in. You end up carrying each shop''s old carrier account, its own rate plan, and lines for trucks that left the fleet years ago.

I spent 25 years inside the carriers — consolidating that mess and repricing it is exactly what I do, independent and with no switching.

Send me your current wireless invoices and I''ll map every account, plan, and dead line onto a single page. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 3. Bothwell Regional Health Center — Materials Management (buyer)
('rlangdon@brhc.org','Rick','Langdon','Bothwell Regional Health Center','Director of Materials Management',
 'Before the next copper repricing letter',
 '{{first_name}} — the carriers are retiring their copper lines, and hospitals are getting hit hardest: alarm, elevator, fire, and fax lines that sat at a fixed rate for years are being repriced several times over or force-migrated — often before Materials ever sees it coming.

I spent 25 years inside those carriers. I find every one of those lines, cut the ones you no longer need, and renegotiate the rest, independent of any vendor.

Worth 15 minutes to get ahead of it before the next repricing letter? I can start from a single invoice.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 4. Bothwell — LAN/WAN (pre-cloud circuits angle)
('gsims@brhc.org','Grace','Sims','Bothwell Regional Health Center','LAN/WAN Administrator',
 'Still paying pre-cloud circuit rates?',
 '{{first_name}} — most hospital networks I see are still paying for MPLS circuits and bandwidth tiers sized for the pre-cloud days, even after EHR and telehealth moved the traffic. The contracts just quietly auto-renew at the old commercials.

I spent 25 years inside the carriers — I read those circuit contracts for a living and know what they''ll actually concede.

Not your architecture, just the commercials. Point me at one circuit invoice and I''ll tell you whether you''re still on legacy rates. Worth a quick look?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 5. Bothwell — LAN/WAN (right-size angle)
('jneas@brhc.org','Jeff','Neas','Bothwell Regional Health Center','LAN/WAN Administrator',
 'WAN circuits that no longer match reality',
 '{{first_name}} — nearly every hospital WAN I audit has circuits that no longer match reality: a link added for a project that ended, redundant pairs billed at full primary rate, bandwidth bumped once and never revisited. The carrier won''t volunteer any of it.

I spent 25 years inside those carriers, so I know which charges are real and which are slack.

Send me a recent circuit bill and I''ll flag what you''re overpaying for — no commitment. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 6. P1 Service — multi-branch mechanical service
('pwinter@p1-service.com','Peter','Winter','P1 Service, LLC','IT Technician',
 'Every P1 branch on a different rate',
 '{{first_name}} — in multi-branch shops like P1, each location usually signed its own internet and phone contract with whatever local rep showed up, years apart, at wildly different rates. Nobody has ever put them side by side.

I spent 25 years inside the carriers — benchmarking and consolidating exactly that is what I do, independent and with no switching.

If keeping those branches online is half your job, let me take the cost side off your plate. Point me at a couple of invoices and I''ll show you the spread. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 7. Epic Landscape Productions — commercial landscaping
('tyconstant@epicland.net','Ty','Constant','Epic Landscape Productions','',
 'What winter costs on your wireless bill',
 '{{first_name}} — commercial landscapers staff way up for the season, add a phone or tablet for every crew, then carry those wireless lines straight through winter when half the crews are gone. The bill never scales back down.

I spent 25 years inside the carriers and know how to suspend, pool, and reprice those lines so you''re paying for the season you''re actually in.

Forward me a recent wireless invoice and I''ll show you what winter is costing you. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 8. Tempcon — Operations (machine + mobile SIM angle)
('don@tempcon.net','Don','Winders','Tempcon','Operations Manager',
 'How many of your SIMs are dormant?',
 '{{first_name}} — refrigeration and HVAC service runs on cellular now: monitoring units phoning home over their own SIMs, a tablet in every truck, techs on the road all day. Those machine and mobile lines multiply quietly, and carriers are happy to keep billing the dormant ones.

I spent 25 years inside the carriers — finding and repricing exactly those lines is what I do.

Send me a recent wireless invoice and I''ll tell you how many lines are live, dormant, or overpaying. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 9. Tempcon — Purchasing (never-RFP''d vendor spend angle)
('kmendoza@tempcon.net','Katrina','Mendoza','Tempcon','Purchasing Agent',
 'The vendor spend that never gets RFP''d',
 '{{first_name}} — telecom and wireless are usually the one recurring vendor spend that never runs through purchasing the way equipment and materials do. It just auto-renews, year after year, at whatever rate someone set once.

I spent 25 years inside the carriers, so I know the real floor on those contracts and negotiate down to it — independent and carrier-neutral.

Send me a current invoice and I''ll show you where it sits against the market. Worth 15 minutes to put it under the same scrutiny as your other vendors?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 10. Tompkins Industries — fluid power manufacturer-distributor
('cjackson@tompkinsind.com','Chris','Jackson','Tompkins Industries, Inc.','Chief Operating Officer',
 'SG&A you can cut without touching ops',
 '{{first_name}} — with distribution margins as tight as they are right now, telecom and connectivity are some of the only SG&A lines you can cut without touching headcount or service. The multi-site circuits, the fleet, the phone system — all of it rarely gets benchmarked.

I spent 25 years inside the carriers, so I know exactly where the margin is buried and how to get it back, independent of any vendor.

Send me one recent invoice and I''ll show you the room before we even talk. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 11. Cobb Refrigeration (a Temp-Con company) — President
('luke@tempcon.net','Luke','Chambers','Cobb Refrigeration','President',
 'Cobb''s connectivity is bigger than it looks',
 '{{first_name}} — as Cobb and Temp-Con have grown, so has the connectivity footprint underneath: monitoring SIMs in equipment, a line in every truck, internet at each location. It compounds quietly, and it drops straight to the bottom line the moment it''s cleaned up.

I spent 25 years inside the carriers. I find the waste and renegotiate the rest — independent, carrier-neutral, no cost to look.

Worth 15 minutes, or send me a recent invoice and I''ll show you where I''d start?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 12. RadSource Imaging Technologies — medical imaging tech/service
('bnordling@radsource.net','Burk','Nordling','RadSource Imaging Technologies','IT Services Director',
 'Imaging got heavier; your circuits didn''t',
 '{{first_name}} — imaging only gets heavier: cloud PACS, teleradiology, bigger studies moving between sites. Most imaging operations I see keep buying more bandwidth while the older circuit contracts at remote and service sites quietly stay on legacy pricing.

I spent 25 years inside the carriers — I read those circuit and wireless contracts for a living and know what they''ll concede.

Point me at a recent invoice and I''ll tell you where RadSource is overpaying. Worth 15 minutes?',
 'paused','local-2026',lower(hex(randomblob(16))));
