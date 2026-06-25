-- Local KC-metro prospect campaign (hand-collected business cards).
-- "Exclusive" handling = one segment tag on the existing, proven leads
-- pipeline (at-most-once, suppression, idempotency, throttle all inherited),
-- not a separate database. Step-1 openers are industry-specific per lead;
-- steps 2-4 reuse SEQUENCE_STEPS. Cold framing (recipients were NOT met).
--
-- Each opener leads with a current dynamic in the recipient's industry, names
-- the concrete telecom leak it creates (wireline-led, wireless alongside), and
-- earns the reply with Brandon's 25-years-inside-the-carriers credibility.
-- CTA is a 15-minute session to review the invoices TOGETHER (no "send a
-- stranger your bill"). No em dashes in body copy.
--
-- SAFETY: inserted as status='paused' so they do NOT send when this migration
-- is applied. Release with one statement when ready:
--   UPDATE leads SET status='queued' WHERE segment='local-2026' AND status='paused';
-- They then drip out under DAILY_CAP + send window, from the OUTREACH_SENDER_* identity.

ALTER TABLE leads ADD COLUMN segment TEXT;

INSERT OR IGNORE INTO leads
  (email, first_name, last_name, company, title, subject_template, body_template, status, segment, unsubscribe_token)
VALUES
-- 1. Manning GC - exterior general contractor
('Braxton@ManningGC.com','Braxton','Vardys','Manning GC','Project Manager',
 'More phone lines than people?',
 '{{first_name}}, most contractors I look at are paying for 20-30% more active wireless lines than they have people in the field. Crews scale up for a busy stretch, lines get added, and nobody closes them out when a job wraps or a hire leaves. Same story on the wireline side: the office internet and phone lines nobody renegotiates.

I spent 25 years inside the big carriers, so I know exactly where that waste hides, and I find and renegotiate it without you switching anything.

Worth 15 minutes to walk through your wireline and wireless invoices together? Nothing to send over. We pull them up live and I''ll flag what I''d go after.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 2. Hoffmann Brothers - home services (HVAC/plumbing/electrical)
('adam.brooks@hoffmannbros.com','Adam','Brooks','Hoffmann Brothers','Director of Fleet',
 'The carrier mess after a roll-up',
 '{{first_name}}, home-services groups are growing and acquiring faster than ever right now, and the telecom contracts almost never get merged in. You end up carrying each shop''s old carrier account, its own rate plan, lines for trucks that left the fleet years ago, and a different internet and phone deal at every location.

I spent 25 years inside the carriers. Consolidating that mess and repricing it is exactly what I do, independent and with no switching.

Let''s spend 15 minutes going through your wireline and wireless invoices together. I''ll map the accounts and dead lines with you on the call, nothing to email over. Worth a look?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 3. Bothwell Regional Health Center - Materials Management (buyer)
('rlangdon@brhc.org','Rick','Langdon','Bothwell Regional Health Center','Director of Materials Management',
 'Before the next copper repricing letter',
 '{{first_name}}, the carriers are retiring their copper lines, and hospitals are getting hit hardest: alarm, elevator, fire, and fax lines that sat at a fixed rate for years are being repriced several times over or force-migrated, often before Materials ever sees it coming.

I spent 25 years inside those carriers. I find every one of those lines, cut the ones you no longer need, and renegotiate the rest, independent of any vendor.

Worth 15 minutes to walk your wireline and wireless invoices together before the next repricing letter? We just look at them on the call, nothing to send ahead.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 4. Bothwell - LAN/WAN (pre-cloud circuits angle)
('gsims@brhc.org','Grace','Sims','Bothwell Regional Health Center','LAN/WAN Administrator',
 'Still paying pre-cloud circuit rates?',
 '{{first_name}}, most hospital networks I see are still paying for MPLS circuits and bandwidth tiers sized for the pre-cloud days, even after EHR and telehealth moved the traffic. The contracts just quietly auto-renew at the old commercials.

I spent 25 years inside the carriers. I read those circuit contracts for a living and know what they''ll actually concede.

No need to hand anything over. Let''s spend 15 minutes on your circuit and wireless invoices together and I''ll tell you whether you''re on legacy rates. Worth a quick look?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 5. Bothwell - LAN/WAN (right-size angle)
('jneas@brhc.org','Jeff','Neas','Bothwell Regional Health Center','LAN/WAN Administrator',
 'WAN circuits that no longer match reality',
 '{{first_name}}, nearly every hospital WAN I audit has circuits that no longer match reality: a link added for a project that ended, redundant pairs billed at full primary rate, bandwidth bumped once and never revisited. The carrier won''t volunteer any of it.

I spent 25 years inside those carriers, so I know which charges are real and which are slack.

Worth 15 minutes to go through a couple circuit bills together? I''ll flag what looks like slack live on the call, nothing to send me.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 6. P1 Service - multi-branch mechanical service
('pwinter@p1-service.com','Peter','Winter','P1 Service, LLC','IT Technician',
 'Every P1 branch on a different rate',
 '{{first_name}}, in multi-branch shops like P1, each location usually signed its own internet, phone, and wireless contracts with whatever local rep showed up, years apart, at wildly different rates. Nobody has ever put them side by side.

I spent 25 years inside the carriers. Benchmarking and consolidating exactly that is what I do, independent and with no switching.

Let''s put 15 minutes on the calendar and compare your branch internet, phone, and wireless invoices together. I''ll show you the spread on the call. Worth it?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 7. Epic Landscape Productions - commercial landscaping
('tyconstant@epicland.net','Ty','Constant','Epic Landscape Productions','',
 'What winter costs on your wireless bill',
 '{{first_name}}, commercial landscapers staff way up for the season, add a phone or tablet for every crew, then carry those wireless lines straight through winter when half the crews are gone. The bill never scales back down, and the office internet and phone lines rarely get a second look either.

I spent 25 years inside the carriers and know how to suspend, pool, and reprice those lines so you''re paying for the season you''re actually in.

Worth 15 minutes to walk your wireless and wireline invoices together? Nothing to send. We just look at them live.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 8. Tempcon - Operations (machine + mobile SIM angle)
('don@tempcon.net','Don','Winders','Tempcon','Operations Manager',
 'How many of your SIMs are dormant?',
 '{{first_name}}, refrigeration and HVAC service runs on cellular now: monitoring units phoning home over their own SIMs, a tablet in every truck, techs on the road all day. Those machine and mobile lines multiply quietly, and carriers are happy to keep billing the dormant ones, same as the wireline at each shop nobody revisits.

I spent 25 years inside the carriers. Finding and repricing exactly those lines is what I do.

Let''s spend 15 minutes going through your wireless and wireline invoices together. I''ll point out the live, dormant, and overpriced lines on the call. Worth a look?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 9. Tempcon - Purchasing (never-RFP''d vendor spend angle)
('kmendoza@tempcon.net','Katrina','Mendoza','Tempcon','Purchasing Agent',
 'The vendor spend that never gets RFP''d',
 '{{first_name}}, telecom is usually the one recurring vendor spend that never runs through purchasing the way equipment and materials do. Wireless and wireline both just auto-renew, year after year, at whatever rate someone set once.

I spent 25 years inside the carriers, so I know the real floor on those contracts and negotiate down to it, independent and carrier-neutral.

Worth 15 minutes to put your telecom invoices under the same scrutiny as your other vendors, together on a call? Nothing to send ahead.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 10. Tompkins Industries - fluid power manufacturer-distributor
('cjackson@tompkinsind.com','Chris','Jackson','Tompkins Industries, Inc.','Chief Operating Officer',
 'SG&A you can cut without touching ops',
 '{{first_name}}, with distribution margins as tight as they are right now, telecom is one of the only SG&A lines you can cut without touching headcount or service. The multi-site circuits, the phone system, the fleet wireless: all of it rarely gets benchmarked.

I spent 25 years inside the carriers, so I know exactly where the margin is buried and how to get it back, independent of any vendor.

Worth 15 minutes to walk the circuits, phone system, and wireless invoices together? I''ll show you the room on the call, before any commitment.',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 11. Cobb Refrigeration (a Temp-Con company) - President
('luke@tempcon.net','Luke','Chambers','Cobb Refrigeration','President',
 'Cobb''s connectivity is bigger than it looks',
 '{{first_name}}, as Cobb and Temp-Con have grown, so has the connectivity footprint underneath: monitoring SIMs in equipment, a line in every truck, internet and phone at each location. It compounds quietly, and it drops straight to the bottom line the moment it''s cleaned up.

I spent 25 years inside the carriers. I find the waste and renegotiate the rest. Independent, carrier-neutral, no switching.

Worth 15 minutes to go through the wireline and wireless invoices together, and I''ll show you where I''d start?',
 'paused','local-2026',lower(hex(randomblob(16)))),

-- 12. RadSource Imaging Technologies - medical imaging tech/service
('bnordling@radsource.net','Burk','Nordling','RadSource Imaging Technologies','IT Services Director',
 'Imaging got heavier; your circuits didn''t',
 '{{first_name}}, imaging only gets heavier: cloud PACS, teleradiology, bigger studies moving between sites. Most imaging operations I see keep buying more bandwidth while the older circuit contracts at remote and service sites quietly stay on legacy pricing.

I spent 25 years inside the carriers. I read those circuit and wireless contracts for a living and know what they''ll concede.

Worth 15 minutes to walk your circuit and wireless invoices together? I''ll tell you where it looks like legacy pricing, live on the call.',
 'paused','local-2026',lower(hex(randomblob(16))));
