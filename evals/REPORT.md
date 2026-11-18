# Lead engine evals: report

Run 2026-11-18T19:36:38.412Z (IST 2026-11-19 01:06), 13.9 s, by `node evals/run.mjs`. What each eval measures and how to read it: `evals/README.md`. Machine-readable: `evals/report.json`.

## Scorecard

| Eval | Headline |
|---|---|
| 1. Draft factuality and lawfulness | 71 drafts from 37 companies: facts 100% from the pack; every check passed by 0/71 (46/71 if the signature's website link is allowed) |
| 2. QC sensitivity | eval:qc 7080/7080 (100.0%), 0 false positives; this suite's mutations 833/1397 (59.6%); 10 of 24 mutation types never caught |
| 3. Compliance gate | 36/39 cases agree (92.3%); 3 disagreement(s), 0 harness error(s) |
| 4. Privacy egress | 13 outside calls over 6 services; LEAKS on 2 path(s): llm:reply_classify (director name); llm:reply_classify (mobile, number written "+91 9876 543 210", number written "0522 4012345") |
| 5. Matching and websites | 48 pairs: precision 100.0%, recall 47.1% (linked or sent to review 29/34); websites 27/30, directories and social networks rejected 22/23; web search egress clean |
| 6. Docs agree with the code | 234 items checked; 4 mismatch(es) |

## Findings

Most severe first. Each was observed in this run; the file:line points at the code responsible, as it reads today.

### 1. [High] Reply classification sends a founder's name and phone numbers to the LLM gateway

- **Where:** services/src/inbound/parse.js:284, services/src/inbound/classify.js:86
- **Failing cases:** reply_classify: a signature without a "-- " line: director name, reply_classify: numbers written other ways: mobile, number written "+91 9876 543 210", number written "0522 4012345"
- **Why it matters:** When the rules are unsure, the reply's new text goes to the gateway's small model (an outside service, possibly outside India, per the legal pack's processor question). newText() drops the signature only after a "-- " line, which most people never type, so "Regards, <name>, Director" goes out; scrub() removes emails and mobiles written 98765 43210, but not a mobile grouped +91 9876 543 210 nor a landline such as 0522 4012345. Leaked here: director name, mobile, number written "+91 9876 543 210", number written "0522 4012345". The design's rule is never a person's data to an outside service, and classify.js says the model sees the reply "with every address and number taken out".

### 2. [Medium-high] The gate does not re-check recipient.use_website_email: a website address drafted while the switch was on is still sent after it is turned off

- **Where:** services/src/outreach/gate.js:99, config/outreach.json:40
- **Failing cases:** stop.website_address_switch_turned_off: send (gate: ok)
- **Why it matters:** The switch exists because the lawyer has not yet approved writing to website addresses (legal pack, question 2). If the answer is no and the switch goes off, every approved draft to a website address still in the queue is sent anyway, because the gate accepts the basis published_by_company whatever the switch says. A one-line check at the gate closes it.

### 3. [Medium-high] The quality check misses wrong facts whose digits appear elsewhere in the evidence pack

- **Where:** services/src/outreach/qc.js:77, services/src/outreach/qc.js:72, config/outreach.json:10
- **Failing cases:** date.us_format_wrong (a wrong date written "Month D, YYYY"): caught 20/34, date.swapped (two deadlines' dates swapped): caught 0/20, section.near_miss (a section one letter off (s.10A as s.10B)): caught 0/22, form.truncated (a form code cut short (INC-20A as INC-20)): caught 0/35, amount.figure_from_a_date (an invented amount whose figure appears in a date of the pack): caught 0/64, amount.misattributed (a scheme amount from the pack given to the wrong scheme): caught 1/2
- **Why it matters:** facts.numbers checks each number in a draft against the set of every digit string in the pack, without context, and facts.forms accepts any form that is a substring of the pack's text. So "₹13 lakh" passes when a date in the pack is the 13th, two deadlines' dates can be swapped, "INC-20A" can become "INC-20" and "s.10A" "s.10B". The templates make none of these mistakes (Eval 1: no factual error in any draft), but the AI drafter could, and once approval.mode becomes "sample" (HANDOVER, design 7.5) 80% of drafts that pass this check are sent without a person reading them.

### 4. [Medium] The gate accepts a recipient labelled "consent" without looking in the consent ledger

- **Where:** services/src/outreach/gate.js:99
- **Failing cases:** stop.consent_label_without_consent: send
- **Why it matters:** config/outreach.json lists consent as a legal basis for email, and the gate checks only the label on the message. No drafting path creates such a recipient today (recipientFor gives only published_under_law or published_by_company), so this is defence in depth: the day a consented address is used for email, the gate should confirm the consent is in the ledger and not withdrawn, as the WhatsApp and call paths already do.

### 5. [Medium] A company whose CIN was issued outside UP is emailed if its record says state UP

- **Where:** services/src/outreach/gate.js:80, schema/collections.json:14
- **Failing cases:** stop.cin_says_not_up (CIN U62099DL2026PTC300102): send
- **Why it matters:** "UP only" is enforced by the database on the state field alone. The CIN carries the state of registration (characters 7-8); a record mislabelled upstream is contacted. A cheap cross-check in the validator or the gate would hold the promise even when an ingest step is wrong.

### 6. [Medium] The quality check misses an extra link written as a bare domain, a director named, another company's name in the greeting, a penalty threat in other words, urgency in other words, a claim that a filing was not made, in other words

- **Where:** services/src/outreach/qc.js:40, services/src/outreach/qc.js:35, config/outreach.json:52
- **Failing cases:** link.extra_bare_domain (an extra link written as a bare domain): caught 0/68, person.director_named (a director named): caught 0/68, company.other_in_greeting (another company's name in the greeting): caught 0/68, tone.penalty_paraphrase (a penalty threat in other words): caught 0/68, tone.urgency_paraphrase (urgency in other words): caught 0/68, tone.missed_paraphrase (a claim that a filing was not made, in other words): caught 0/68
- **Why it matters:** The tone rules are fixed phrase lists, so "Please file on time to avoid penalties" or "this filing was not made on time" pass; links are found only after http(s):// or www.; nothing checks names. A person reading every draft catches these, which is why they rank below the factual misses; under sample approval they would reach founders.

### 7. [Low] Long company names make the reviewed templates fail their own length limits

- **Where:** services/src/outreach/templates.js:32, services/src/outreach/templates.js:63, config/outreach.json:48
- **Failing cases:** navyarth/first_touch/en: subject 94 characters (limit 90); body 253 words (limit 250), navyarth/follow_up/en: subject 98 characters (limit 90), omvara/follow_up/en: subject 94 characters (limit 90)
- **Why it matters:** The first subject is "<name>: your next filing dates" and a follow-up adds "Re: ", so a name over 66 characters (62 for a follow-up) breaks the 90-character limit, and a long name repeated in a full pack pushes the body past 250 words. Such a draft is stored as qc_failed: a person must shorten it by hand before it can be approved, every time, and under sample approval it never goes by the engine's route. MCA allows names this long; the templates could shorten the subject instead (for example without "Private Limited").

### 8. [Low] Every template email carries a third link (the sender's website in the signature)

- **Where:** services/src/outreach/templates.js:27, services/src/outreach/draft.js:34
- **Failing cases:** 71/71 drafts: other links: https://solutionai.in
- **Why it matters:** templates.js promises "one link to the company's page and one to unsubscribe", and the AI prompt says the page link is "the only link", yet the signature it must copy word for word holds https://solutionai.in. qc.js deliberately allows it. Harmless in itself, but the promise, the prompt and the code disagree; decide which is meant.

### 9. [Low] follow_up emails do not say why the founder is getting them

- **Where:** services/src/outreach/templates.js:73
- **Failing cases:** 24 drafts: aarvik/follow_up/en, bhuvira/follow_up/hi, chandral/follow_up/hi, dhanvio/follow_up/en, ekansh/follow_up/hi, falgun/follow_up/en, garvisha/follow_up/en, hemkosh/follow_up/hi and 16 more
- **Why it matters:** First and new-need emails end with where the address came from (the MCA register or the company's own website); follow-ups end with the unsubscribe link only. A founder who sees only the follow-up (the first went to spam) is never told the source, which matters most for a website address, the basis the lawyer has not yet approved.

### 10. [Low] Transliteration variants of the same name are not even put in front of a reviewer

- **Where:** ingest/src/leadengine/names.py:53, ingest/src/leadengine/kb/match.py:361
- **Failing cases:** translit.shri_shree: not linked (best candidate too weak or contradicted), translit.laxmi_lakshmi: not linked (no company with a similar name in the CIN universe we hold), translit.devanagari: not linked (no company with a similar name in the CIN universe we hold), translit.compound_word: not linked (no company with a similar name in the CIN universe we hold), translit.two_vowels: not linked (no company with a similar name in the CIN universe we hold)
- **Why it matters:** Laxmi/Lakshmi, Shri/Shree, a name typed in Devanagari: the founder's company is in the universe but no candidate reaches the review queue, so the startup stays unlinked and its facts never join the company record. Precision is unharmed; recall on Hindi-belt names is.

### 11. [Low] Name normalisation calls two different one-letter-apart names "the same but for a slip"

- **Where:** ingest/src/leadengine/names.py:53
- **Failing cases:** near.one_letter_names
- **Why it matters:** typo_of treats Hiranyo and Hiranya as one name misspelt. In this run the matcher still did not link them automatically (the probability stayed under the threshold), but the name rule alone offers no protection; it relies on the other conditions.

### 12. [Low] Website confirmation takes a free site-builder subdomain for the company's own site

- **Where:** ingest/src/leadengine/web.py:7
- **Failing cases:** builder.weebly: https://tarovikagrofoods.weebly.com/
- **Why it matters:** wixsite.com, blogspot.com and godaddysites.com are refused as shared hosts, but other builders (weebly.com here; similarly jimdo, webnode, myshopify) are not. The contact step then looks for role addresses on that subdomain, so the practical harm is small, but the rule should be a list of kinds, not a handful of names.

### 13. [Low] Website confirmation rejects real company sites whose names are initials or whose domains drop "Shri"

- **Where:** ingest/src/leadengine/enrich/websites.py:94, ingest/src/leadengine/enrich/websites.py:100
- **Failing cases:** own.two_letter_initials: https://vnagro.example/, own.honorific_dropped: https://ganeshagro.example/
- **Why it matters:** distinctive() drops words under three letters and domain_fits() requires the first distinctive word in the domain, so "VN Agro" has no distinctive word at all and "Shri Ganesh Agro" at ganeshagro.* fails. Safe (nothing wrong is accepted) but those companies never get a website address.

### 14. [Low] Docs and code disagree

- **Where:** .env.example, docs/HANDOVER.md, docs/platform-openapi.yaml
- **Failing cases:** CAPS_FILE is read (services/src/config.js:32) but not in .env.example, DKIM_SELECTOR is read (services/src/ops/preflight.js:172) but not in .env.example, SARVAM_API_BASE is read (services/src/voice/sarvam.js:90) but not in .env.example, <MAILBOX_n>_SMTP_USER is read (services/src/outreach/transport.js:30) but not in .env.example
- **Why it matters:** The handover is what the team runs the engine from after 25 November; a variable missing from .env.example is a setting nobody will know to set (DKIM_SELECTOR changes what preflight checks).

## 1. Draft factuality and lawfulness

71 drafts written by the engine (the reviewed templates, as in production until the LLM gateway has a key) for 37 fictional companies: 37 first_touch, 24 follow_up, 6 new_need (deadline), 4 new_need (scheme); 39 in English, 32 in Hindi; 60 to a registered address, 11 to a website address; 57 with schemes; 7 LLP drafts; 36 with a "was due" line. Graded by this suite's own checker, not the engine's.

| Check | Passed | Rate |
|---|---|---|
| facts.dates_in_pack | 71/71 | 100.0% |
| facts.dates_attributed | 71/71 | 100.0% |
| facts.forms_in_pack | 71/71 | 100.0% |
| facts.sections_in_pack | 71/71 | 100.0% |
| facts.rupees_in_pack | 71/71 | 100.0% |
| company.name_right | 71/71 | 100.0% |
| company.no_other_company | 71/71 | 100.0% |
| links.one_page_link | 71/71 | 100.0% |
| links.one_unsubscribe_link | 71/71 | 100.0% |
| links.no_other_links | 0/71 | 0.0% |
| links.no_unknown_placeholders | 71/71 | 100.0% |
| why.matches_basis | 47/71 | 66.2% |
| opt_out.words | 71/71 | 100.0% |
| privacy.no_person | 71/71 | 100.0% |
| lawful.no_conditional_obligation | 71/71 | 100.0% |
| lawful.no_threat_or_urgency | 71/71 | 100.0% |
| length.subject | 68/71 | 95.8% |
| length.body | 70/71 | 98.6% |

**Every failing draft, by check:**

- `links.no_other_links` (71): aarvik/first_touch/en; aarvik/follow_up/en; aarvik/new_need/en; bhuvira/first_touch/hi; bhuvira/follow_up/hi; chandral/first_touch/hi; chandral/follow_up/hi; dhanvio/first_touch/en; dhanvio/follow_up/en; ekansh/first_touch/hi; ekansh/follow_up/hi; falgun/first_touch/en; falgun/follow_up/en; falgun/new_need/en; garvisha/first_touch/en; garvisha/follow_up/en; garvisha/new_need/en; hemkosh/first_touch/hi; hemkosh/follow_up/hi; ilavya/first_touch/hi; ilavya/new_need/hi; jivantra/first_touch/en; jivantra/follow_up/en; kaushvi/first_touch/hi; lavanyo/first_touch/en; lavanyo/follow_up/en; madhurak/first_touch/en; navyarth/first_touch/en; navyarth/follow_up/en; ojasvik/first_touch/hi; ojasvik/follow_up/hi; ojasvik/new_need/hi; prakriva/first_touch/hi; prakriva/follow_up/hi; quarvi/first_touch/en; rudhvik/first_touch/hi; rudhvik/follow_up/hi; saanvra/first_touch/en; saanvra/new_need/en; tanmayo/first_touch/hi; udbhav/first_touch/en; udbhav/follow_up/en; vaidhra/first_touch/en; yashvik/first_touch/hi; yashvik/follow_up/hi; yashvik/new_need/hi; zorvana/first_touch/en; amritsa/first_touch/hi; amritsa/new_need/hi; barkhaya/first_touch/en; barkhaya/follow_up/en; chitrakh/first_touch/en; devansha/first_touch/en; devansha/follow_up/en; eshvika/first_touch/hi; eshvika/follow_up/hi; gaurangi/first_touch/hi; hiranyo/first_touch/en; hiranyo/follow_up/en; indravi/first_touch/hi; indravi/follow_up/hi; jagrit/first_touch/en; jagrit/new_need/en; kalindo/first_touch/en; lokvesh/first_touch/hi; lokvesh/follow_up/hi; lokvesh/new_need/hi; mrinavi/first_touch/en; mrinavi/follow_up/en; omvara/first_touch/en; omvara/follow_up/en — each one: other links: https://solutionai.in
- `why.matches_basis` (24): aarvik/follow_up/en (no "why you are getting this" line (follow_up)); bhuvira/follow_up/hi (no "why you are getting this" line (follow_up)); chandral/follow_up/hi (no "why you are getting this" line (follow_up)); dhanvio/follow_up/en (no "why you are getting this" line (follow_up)); ekansh/follow_up/hi (no "why you are getting this" line (follow_up)); falgun/follow_up/en (no "why you are getting this" line (follow_up)); garvisha/follow_up/en (no "why you are getting this" line (follow_up)); hemkosh/follow_up/hi (no "why you are getting this" line (follow_up)); jivantra/follow_up/en (no "why you are getting this" line (follow_up)); lavanyo/follow_up/en (no "why you are getting this" line (follow_up)); navyarth/follow_up/en (no "why you are getting this" line (follow_up)); ojasvik/follow_up/hi (no "why you are getting this" line (follow_up)); prakriva/follow_up/hi (no "why you are getting this" line (follow_up)); rudhvik/follow_up/hi (no "why you are getting this" line (follow_up)); udbhav/follow_up/en (no "why you are getting this" line (follow_up)); yashvik/follow_up/hi (no "why you are getting this" line (follow_up)); barkhaya/follow_up/en (no "why you are getting this" line (follow_up)); devansha/follow_up/en (no "why you are getting this" line (follow_up)); eshvika/follow_up/hi (no "why you are getting this" line (follow_up)); hiranyo/follow_up/en (no "why you are getting this" line (follow_up)); indravi/follow_up/hi (no "why you are getting this" line (follow_up)); lokvesh/follow_up/hi (no "why you are getting this" line (follow_up)); mrinavi/follow_up/en (no "why you are getting this" line (follow_up)); omvara/follow_up/en (no "why you are getting this" line (follow_up))
- `length.subject` (3): navyarth/first_touch/en (subject 94 characters (limit 90)); navyarth/follow_up/en (subject 98 characters (limit 90)); omvara/follow_up/en (subject 94 characters (limit 90))
- `length.body` (1): navyarth/first_touch/en (body 253 words (limit 250))

The engine's own quality check failed 3 of these drafts: navyarth/first_touch/en (length.subject: the subject must be 1 to 90 characters; length.body: the body has 253 words; at most 250); navyarth/follow_up/en (length.subject: the subject must be 1 to 90 characters); omvara/follow_up/en (length.subject: the subject must be 1 to 90 characters).

## 2. QC sensitivity

**The engine's own set** (`eval:qc`, services/src/eval/qc.js): 360 clean drafts, 0 false positives; 7080 broken drafts over 20 fault types, 7080 caught (100.0%).

**This suite's mutations**, each applied to every clean draft from Eval 1 where it applies (1397 mutated drafts, 833 caught, 59.6%). "Caught by" is which QC check failed; a catch by facts.numbers for a phone or a date is a catch for the wrong reason, and would be missed if the digits happened to be in the pack.

| Mutation | Engine QC caught | Rate | Caught by | This suite's grader caught |
|---|---|---|---|---|
| date.shifted: a deadline one day off | 64/64 | 100.0% | facts.dates 64 | 64/64 |
| date.us_format_wrong: a wrong date written "Month D, YYYY" | 20/34 | 58.8% | facts.numbers 20 | 34/34 |
| date.swapped: two deadlines' dates swapped | 0/20 | 0.0% | — | 20/20 |
| section.invented: an invented section number | 68/68 | 100.0% | facts.numbers 68 | 68/68 |
| section.near_miss: a section one letter off (s.10A as s.10B) | 0/22 | 0.0% | — | 22/22 |
| form.truncated: a form code cut short (INC-20A as INC-20) | 0/35 | 0.0% | — | 35/35 |
| link.extra_https: an extra https link | 68/68 | 100.0% | links.no_others 68 | 68/68 |
| link.extra_bare_domain: an extra link written as a bare domain | 0/68 | 0.0% | — | 68/68 |
| link.no_unsubscribe: the unsubscribe link removed | 68/68 | 100.0% | links.unsubscribe_once 68 | 68/68 |
| subject.shouted: the subject in capitals | 68/68 | 100.0% | subject.not_shouted 68 | 68/68 |
| amount.invented: an invented scheme amount | 68/68 | 100.0% | facts.numbers 68 | 68/68 |
| amount.figure_from_a_date: an invented amount whose figure appears in a date of the pack | 0/64 | 0.0% | — | 64/64 |
| amount.misattributed: a scheme amount from the pack given to the wrong scheme | 1/2 | 50.0% | length.body 1 | 1/2 |
| phone.standard: a personal mobile, 98765 43210 | 68/68 | 100.0% | facts.numbers 68, privacy.no_contacts 68 | 68/68 |
| phone.plus91_dashes: a personal mobile, +91-98765-43210 | 68/68 | 100.0% | facts.numbers 68, privacy.no_contacts 68 | 68/68 |
| phone.grouped_4_3_3: a personal mobile, +91 9876 543 210 | 68/68 | 100.0% | facts.numbers 68 | 68/68 |
| phone.landline: a landline, 0522 4012345 | 68/68 | 100.0% | facts.numbers 68 | 68/68 |
| email.personal: a personal email address | 68/68 | 100.0% | privacy.no_contacts 68 | 68/68 |
| person.director_named: a director named | 0/68 | 0.0% | — | 68/68 |
| company.other_in_greeting: another company's name in the greeting | 0/68 | 0.0% | — | 68/68 |
| opt_out.words_removed: the opt-out sentence removed, the link kept | 68/68 | 100.0% | opt_out.words 68 | 68/68 |
| tone.penalty_paraphrase: a penalty threat in other words | 0/68 | 0.0% | — | 68/68 |
| tone.urgency_paraphrase: urgency in other words | 0/68 | 0.0% | — | 0/68 |
| tone.missed_paraphrase: a claim that a filing was not made, in other words | 0/68 | 0.0% | — | 0/68 |

The last column checks the checker: Eval 1's grader, run on the same mutated drafts, caught 1260/1397 (90.2%), so its clean bill for the templates' facts is not for want of looking. Where it misses too, it is because the mutation is outside what it grades (tone in other words is checked only by a phrase list here as well).

**Missed mutations (every draft):**

- `date.us_format_wrong` (14): aarvik/first_touch/en, falgun/first_touch/en, falgun/follow_up/en, garvisha/follow_up/en, garvisha/new_need/en, lavanyo/first_touch/en, lavanyo/follow_up/en, saanvra/first_touch/en, udbhav/follow_up/en, zorvana/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, hiranyo/first_touch/en, kalindo/first_touch/en
- `date.swapped` (20): aarvik/first_touch/en, bhuvira/first_touch/hi, chandral/first_touch/hi, garvisha/first_touch/en, hemkosh/first_touch/hi, ilavya/first_touch/hi, kaushvi/first_touch/hi, lavanyo/first_touch/en, madhurak/first_touch/en, saanvra/first_touch/en, tanmayo/first_touch/hi, udbhav/first_touch/en, yashvik/first_touch/hi, zorvana/first_touch/en, devansha/first_touch/en, eshvika/first_touch/hi, hiranyo/first_touch/en, indravi/first_touch/hi, kalindo/first_touch/en, lokvesh/first_touch/hi
- `section.near_miss` (22): aarvik/new_need/en, bhuvira/first_touch/hi, dhanvio/first_touch/en, ekansh/first_touch/hi, garvisha/new_need/en, ilavya/new_need/hi, jivantra/first_touch/en, ojasvik/first_touch/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, saanvra/new_need/en, vaidhra/first_touch/en, yashvik/new_need/hi, zorvana/first_touch/en, barkhaya/first_touch/en, chitrakh/first_touch/en, gaurangi/first_touch/hi, indravi/first_touch/hi, jagrit/first_touch/en, lokvesh/new_need/hi, mrinavi/first_touch/en, omvara/first_touch/en
- `form.truncated` (35): aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, garvisha/follow_up/en, garvisha/new_need/en, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/new_need/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/new_need/hi, zorvana/first_touch/en, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, eshvika/follow_up/hi, gaurangi/first_touch/hi, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en
- `link.extra_bare_domain` (68): aarvik/first_touch/en, aarvik/follow_up/en, aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, chandral/first_touch/hi, chandral/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, falgun/first_touch/en, falgun/follow_up/en, falgun/new_need/en, garvisha/first_touch/en, garvisha/follow_up/en, garvisha/new_need/en, hemkosh/first_touch/hi, hemkosh/follow_up/hi, ilavya/first_touch/hi, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, kaushvi/first_touch/hi, lavanyo/first_touch/en, lavanyo/follow_up/en, madhurak/first_touch/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, ojasvik/new_need/hi, prakriva/first_touch/hi, prakriva/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/first_touch/en, saanvra/new_need/en, tanmayo/first_touch/hi, udbhav/first_touch/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/first_touch/hi, yashvik/follow_up/hi, yashvik/new_need/hi, zorvana/first_touch/en, amritsa/first_touch/hi, amritsa/new_need/hi, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, eshvika/first_touch/hi, eshvika/follow_up/hi, gaurangi/first_touch/hi, hiranyo/first_touch/en, hiranyo/follow_up/en, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, jagrit/new_need/en, kalindo/first_touch/en, lokvesh/first_touch/hi, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en
- `amount.figure_from_a_date` (64): aarvik/first_touch/en, aarvik/follow_up/en, aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, chandral/first_touch/hi, chandral/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, falgun/first_touch/en, falgun/follow_up/en, garvisha/first_touch/en, garvisha/follow_up/en, garvisha/new_need/en, hemkosh/first_touch/hi, hemkosh/follow_up/hi, ilavya/first_touch/hi, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, kaushvi/first_touch/hi, lavanyo/first_touch/en, lavanyo/follow_up/en, madhurak/first_touch/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, prakriva/first_touch/hi, prakriva/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/first_touch/en, saanvra/new_need/en, tanmayo/first_touch/hi, udbhav/first_touch/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/first_touch/hi, yashvik/follow_up/hi, yashvik/new_need/hi, zorvana/first_touch/en, amritsa/first_touch/hi, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, eshvika/first_touch/hi, eshvika/follow_up/hi, gaurangi/first_touch/hi, hiranyo/first_touch/en, hiranyo/follow_up/en, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, kalindo/first_touch/en, lokvesh/first_touch/hi, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en
- `amount.misattributed` (1): vaidhra/first_touch/en
- `person.director_named` (68): aarvik/first_touch/en, aarvik/follow_up/en, aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, chandral/first_touch/hi, chandral/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, falgun/first_touch/en, falgun/follow_up/en, falgun/new_need/en, garvisha/first_touch/en, garvisha/follow_up/en, garvisha/new_need/en, hemkosh/first_touch/hi, hemkosh/follow_up/hi, ilavya/first_touch/hi, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, kaushvi/first_touch/hi, lavanyo/first_touch/en, lavanyo/follow_up/en, madhurak/first_touch/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, ojasvik/new_need/hi, prakriva/first_touch/hi, prakriva/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/first_touch/en, saanvra/new_need/en, tanmayo/first_touch/hi, udbhav/first_touch/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/first_touch/hi, yashvik/follow_up/hi, yashvik/new_need/hi, zorvana/first_touch/en, amritsa/first_touch/hi, amritsa/new_need/hi, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, eshvika/first_touch/hi, eshvika/follow_up/hi, gaurangi/first_touch/hi, hiranyo/first_touch/en, hiranyo/follow_up/en, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, jagrit/new_need/en, kalindo/first_touch/en, lokvesh/first_touch/hi, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en
- `company.other_in_greeting` (68): aarvik/first_touch/en, aarvik/follow_up/en, aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, chandral/first_touch/hi, chandral/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, falgun/first_touch/en, falgun/follow_up/en, falgun/new_need/en, garvisha/first_touch/en, garvisha/follow_up/en, garvisha/new_need/en, hemkosh/first_touch/hi, hemkosh/follow_up/hi, ilavya/first_touch/hi, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, kaushvi/first_touch/hi, lavanyo/first_touch/en, lavanyo/follow_up/en, madhurak/first_touch/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, ojasvik/new_need/hi, prakriva/first_touch/hi, prakriva/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/first_touch/en, saanvra/new_need/en, tanmayo/first_touch/hi, udbhav/first_touch/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/first_touch/hi, yashvik/follow_up/hi, yashvik/new_need/hi, zorvana/first_touch/en, amritsa/first_touch/hi, amritsa/new_need/hi, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, eshvika/first_touch/hi, eshvika/follow_up/hi, gaurangi/first_touch/hi, hiranyo/first_touch/en, hiranyo/follow_up/en, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, jagrit/new_need/en, kalindo/first_touch/en, lokvesh/first_touch/hi, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en
- `tone.penalty_paraphrase` (68): aarvik/first_touch/en, aarvik/follow_up/en, aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, chandral/first_touch/hi, chandral/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, falgun/first_touch/en, falgun/follow_up/en, falgun/new_need/en, garvisha/first_touch/en, garvisha/follow_up/en, garvisha/new_need/en, hemkosh/first_touch/hi, hemkosh/follow_up/hi, ilavya/first_touch/hi, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, kaushvi/first_touch/hi, lavanyo/first_touch/en, lavanyo/follow_up/en, madhurak/first_touch/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, ojasvik/new_need/hi, prakriva/first_touch/hi, prakriva/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/first_touch/en, saanvra/new_need/en, tanmayo/first_touch/hi, udbhav/first_touch/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/first_touch/hi, yashvik/follow_up/hi, yashvik/new_need/hi, zorvana/first_touch/en, amritsa/first_touch/hi, amritsa/new_need/hi, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, eshvika/first_touch/hi, eshvika/follow_up/hi, gaurangi/first_touch/hi, hiranyo/first_touch/en, hiranyo/follow_up/en, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, jagrit/new_need/en, kalindo/first_touch/en, lokvesh/first_touch/hi, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en
- `tone.urgency_paraphrase` (68): aarvik/first_touch/en, aarvik/follow_up/en, aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, chandral/first_touch/hi, chandral/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, falgun/first_touch/en, falgun/follow_up/en, falgun/new_need/en, garvisha/first_touch/en, garvisha/follow_up/en, garvisha/new_need/en, hemkosh/first_touch/hi, hemkosh/follow_up/hi, ilavya/first_touch/hi, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, kaushvi/first_touch/hi, lavanyo/first_touch/en, lavanyo/follow_up/en, madhurak/first_touch/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, ojasvik/new_need/hi, prakriva/first_touch/hi, prakriva/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/first_touch/en, saanvra/new_need/en, tanmayo/first_touch/hi, udbhav/first_touch/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/first_touch/hi, yashvik/follow_up/hi, yashvik/new_need/hi, zorvana/first_touch/en, amritsa/first_touch/hi, amritsa/new_need/hi, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, eshvika/first_touch/hi, eshvika/follow_up/hi, gaurangi/first_touch/hi, hiranyo/first_touch/en, hiranyo/follow_up/en, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, jagrit/new_need/en, kalindo/first_touch/en, lokvesh/first_touch/hi, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en
- `tone.missed_paraphrase` (68): aarvik/first_touch/en, aarvik/follow_up/en, aarvik/new_need/en, bhuvira/first_touch/hi, bhuvira/follow_up/hi, chandral/first_touch/hi, chandral/follow_up/hi, dhanvio/first_touch/en, dhanvio/follow_up/en, ekansh/first_touch/hi, ekansh/follow_up/hi, falgun/first_touch/en, falgun/follow_up/en, falgun/new_need/en, garvisha/first_touch/en, garvisha/follow_up/en, garvisha/new_need/en, hemkosh/first_touch/hi, hemkosh/follow_up/hi, ilavya/first_touch/hi, ilavya/new_need/hi, jivantra/first_touch/en, jivantra/follow_up/en, kaushvi/first_touch/hi, lavanyo/first_touch/en, lavanyo/follow_up/en, madhurak/first_touch/en, ojasvik/first_touch/hi, ojasvik/follow_up/hi, ojasvik/new_need/hi, prakriva/first_touch/hi, prakriva/follow_up/hi, quarvi/first_touch/en, rudhvik/first_touch/hi, rudhvik/follow_up/hi, saanvra/first_touch/en, saanvra/new_need/en, tanmayo/first_touch/hi, udbhav/first_touch/en, udbhav/follow_up/en, vaidhra/first_touch/en, yashvik/first_touch/hi, yashvik/follow_up/hi, yashvik/new_need/hi, zorvana/first_touch/en, amritsa/first_touch/hi, amritsa/new_need/hi, barkhaya/first_touch/en, barkhaya/follow_up/en, chitrakh/first_touch/en, devansha/first_touch/en, devansha/follow_up/en, eshvika/first_touch/hi, eshvika/follow_up/hi, gaurangi/first_touch/hi, hiranyo/first_touch/en, hiranyo/follow_up/en, indravi/first_touch/hi, indravi/follow_up/hi, jagrit/first_touch/en, jagrit/new_need/en, kalindo/first_touch/en, lokvesh/first_touch/hi, lokvesh/follow_up/hi, lokvesh/new_need/hi, mrinavi/first_touch/en, mrinavi/follow_up/en, omvara/first_touch/en

## 3. Compliance gate

Each case runs the engine's real path on a throwaway MongoDB: plan, draft (with the address check), a person's approval, then the send job and its gate, with a transport that keeps the email and sends nothing. Outcome: send (the transport was handed the email), wait, stop, or no_message (nothing reached the gate). 36/39 agree.

| Case | Expected | Outcome | Gate | Agrees |
|---|---|---|---|---|
| allow.baseline | send | send | send: ok | yes |
| allow.monday_window_opens | send | send | send: ok | yes |
| allow.personal_registered_email | send | send | send: ok | yes |
| allow.personal_address_never_to_verifier | send | send | send: ok | yes |
| allow.website_address_switch_on | send | send | send: ok | yes |
| allow.implicit_mx | send | send | send: ok | yes |
| allow.registered_dead_gives_way_to_website | send | send | send: ok | yes |
| stop.suppressed_address | stop or no_message | stop | stop: suppressed | yes |
| stop.suppressed_domain | stop or no_message | stop | stop: suppressed | yes |
| stop.opted_out | stop or no_message | stop | stop: opted_out | yes |
| stop.complained | stop or no_message | stop | stop: opted_out | yes |
| stop.replied | stop or no_message | stop | stop: replied | yes |
| stop.claimed_after_approval | stop | stop | stop: claimed | yes |
| stop.hard_bounced_before | stop or no_message | stop | stop: bounced | yes |
| stop.holdout | no_message or stop | no_message | — | yes |
| stop.holdout_after_approval | stop | stop | stop: holdout | yes |
| stop.ineligible | no_message or stop | no_message | — | yes |
| stop.non_up_company | no_message | no_message | — | yes |
| stop.cin_says_not_up | stop or no_message | send | send: ok | **NO** |
| stop.already_contacted | stop or no_message | stop | stop: already_sent | yes |
| stop.published_by_person | stop | stop | stop: no_legal_basis | yes |
| stop.consent_label_without_consent | stop | send | send: ok | **NO** |
| stop.website_address_switch_off | no_message | no_message | — | yes |
| stop.website_address_switch_turned_off | stop or wait | send | send: ok | **NO** |
| stop.disposable_domain | no_message | no_message | — | yes |
| stop.no_mx | no_message | no_message | — | yes |
| stop.accept_all_first_wave | no_message | no_message | — | yes |
| stop.text_changed_after_approval | stop | stop | stop: approval_stale | yes |
| stop.expired | stop | stop | stop: expired | yes |
| stop.stale_fact | stop | stop | stop: stale_facts | yes |
| wait.rules_unconfirmed | wait or stop or no_message | wait | wait: rules_unconfirmed | yes |
| wait.rules_withdrawn_after_approval | wait or stop | wait | wait: rules_unconfirmed | yes |
| wait.saturday | wait | wait | wait: window | yes |
| wait.before_window | wait | wait | wait: window | yes |
| wait.window_closed | wait | wait | wait: window | yes |
| wait.friday_night_utc_is_saturday_ist | wait | wait | wait: window | yes |
| wait.daily_cap_reached | wait | wait | wait: daily_cap | yes |
| wait.warmup | wait | wait | wait: warmup | yes |
| wait.mailbox_paused_bounces | wait | wait | wait: mailbox_paused | yes |

**Disagreements:**

- `stop.cin_says_not_up`: the record says state UP but its CIN was issued in Delhi (DL): a data error upstream. Expected stop or no_message, got **send** (gate: send, ok: first email). Trail: plan: shortlisted 1, first_touch_queued 1; draft: awaiting_approval
- `stop.consent_label_without_consent`: the recipient is labelled 'consent' but the consent ledger has nothing for it. Expected stop, got **send** (gate: send, ok: first email). Trail: plan: shortlisted 1, first_touch_queued 1; draft: awaiting_approval
- `stop.website_address_switch_turned_off`: drafted while the switch was on; the switch is turned off (the lawyer said no) before it is sent. Expected stop or wait, got **send** (gate: send, ok: first email). Trail: plan: shortlisted 1, first_touch_queued 1; draft: awaiting_approval

## 4. Privacy egress

Canary personal data (fixtures/canaries.json) planted in the company record, the vendor profile, the portal team and the founder's reply; every outside call captured.

| Path | Service | Calls | Canaries in the request |
|---|---|---|---|
| draft: the AI drafter, its review and the address check | llm:draft | 4 | nothing |
| draft: the AI drafter, its review and the address check | llm:quality_check | 2 | nothing |
| draft: the AI drafter, its review and the address check | email verification service | 1 | nothing |
| match_check: the AI check on an unsure match | llm:match_check | 1 | nothing |
| reply_classify: a signature without a "-- " line | llm:reply_classify | 1 | **director name** |
| reply_classify: a signature after a "-- " line | llm:reply_classify | 1 | nothing |
| reply_classify: numbers written other ways | llm:reply_classify | 1 | **mobile, number written "+91 9876 543 210", number written "0522 4012345"** |
| platform onboarding: a direct claim | platform /onboarding | 1 | nothing |
| platform onboarding: a campaign claim, before and after its email confirmation | platform /onboarding | 1 | nothing |

- Email verification service: called 1 time(s), for info@quillora.example; the director's own registered address got the free checks only.
- Campaign claim before its email confirmation: 0 outside call(s), 0 consent(s) recorded, 0 claim(s) recorded; the confirmation went only to rohan.tejpal@zephyraherbals.example. After confirmation: 1 onboarding call, claim recorded 1.
- What reached the platform's onboarding: only what the claimant typed (name/role/email/whatsapp; name/role/email/whatsapp), which is the point of claiming; none of the planted canaries.

## 5. Matching on hard name pairs, and websites

48 labelled pairs (34 same, 14 different), 47 startups against 68 companies (the pairs' own and invented distractors). Thresholds: automatic link at probability 0.98 with a 6-bit margin, review from 0.3 (kb-match-v2). Precision and recall are of automatic links; a pair sent to review is not a link.

| Run | Links | Wrong links | Precision | Recall | Same pairs linked or sent to review | Seconds |
|---|---|---|---|---|---|---|
| exact_and_splink | 16 | 0 | 100.0% | 47.1% | 29/34 | 1.2 |
| exact_only | 16 | 0 | 100.0% | 47.1% | 18/34 | 0 |

**Every miss (exact_and_splink):**

| Pair | Category | Label | Outcome | Name level | Why |
|---|---|---|---|---|---|
| spacing.joined_word | spacing and punctuation | same | review | same | probability below the automatic threshold |
| opc.dropped_by_founder | (OPC) | same | review | same | same name under another legal form; confirm it is the same business |
| spacing.split_word | spacing and punctuation | same | review | same | probability below the automatic threshold |
| spacing.joined_generic | spacing and punctuation | same | review | typo | probability below the automatic threshold |
| typo.distinctive_word | spelling slip | same | review | typo | probability below the automatic threshold |
| typo.generic_word | spelling slip | same | review | same | probability below the automatic threshold |
| typo.doubled_letter | spelling slip | same | review | typo | probability below the automatic threshold |
| translit.shri_shree | Hindi and English transliteration | same | not linked | different | best candidate too weak or contradicted |
| translit.laxmi_lakshmi | Hindi and English transliteration | same | not linked | different | no company with a similar name in the CIN universe we hold |
| translit.devanagari | Hindi and English transliteration | same | not linked | different | no company with a similar name in the CIN universe we hold |
| translit.krushi_krishi | Hindi and English transliteration | same | review | typo | probability below the automatic threshold |
| translit.compound_word | Hindi and English transliteration | same | not linked | different | no company with a similar name in the CIN universe we hold |
| translit.two_vowels | Hindi and English transliteration | same | not linked | different | no company with a similar name in the CIN universe we hold |
| plural.solar_solars | spacing and punctuation | same | review | typo | probability below the automatic threshold |
| plural.technologies | spacing and punctuation | same | review | same | probability below the automatic threshold |
| ignorable.the_company | spacing and punctuation | same | review | same | probability below the automatic threshold |
| plural.ventures | spacing and punctuation | same | review | same | probability below the automatic threshold |
| year.founder_year_far | same name, other facts disagree | same | review | same | the founder's year of establishment is more than a year from incorporation |

**Name level alone** (names.py and match.name_agreement, over the 40 pairs where the name is the question): precision 96.2%, recall 83.3%. Called the same but different: near.one_letter_names. Same but not recognised: translit.shri_shree, translit.laxmi_lakshmi, translit.devanagari, translit.compound_word, translit.two_vowels.

**Website confirmation** (enrich/websites.py's search step with a fake search API and fetcher): 27/30 right; directories, marketplaces, social networks and shared builders rejected 22/23; the company's own sites accepted 5/7.

| Case | URL | Expected | Got |
|---|---|---|---|
| own.exact_domain | https://tarovikagro.example/ | accept | accept |
| own.first_word_domain | https://www.tarovik.example/about | accept | accept |
| own.hyphen_domain | https://tarovik-foods.example/ | accept | accept |
| own.cin_on_page | https://shivomherbals.example/ | accept | accept |
| own.two_letter_initials | https://vnagro.example/ | accept | **reject** |
| own.honorific_dropped | https://ganeshagro.example/ | accept | **reject** |
| own.common_surname | https://sharmaagro.example/ | accept | accept |
| social.linkedin | https://www.linkedin.com/company/tarovik-agro-foods | reject | reject |
| social.linkedin_country | https://in.linkedin.com/company/tarovik | reject | reject |
| social.facebook | https://www.facebook.com/tarovikagrofoods | reject | reject |
| social.facebook_mobile | https://m.facebook.com/tarovikagro | reject | reject |
| social.instagram | https://www.instagram.com/tarovik.agro/ | reject | reject |
| social.youtube | https://www.youtube.com/@tarovikagro | reject | reject |
| directory.zaubacorp | https://www.zaubacorp.com/company/TAROVIK-AGRO-FOODS-PRIVATE-LIMITED/U01100UP2026PTC310001 | reject | reject |
| directory.tofler | https://www.tofler.in/tarovik-agro-foods-private-limited/company/U01100UP2026PTC310001 | reject | reject |
| directory.thecompanycheck | https://www.thecompanycheck.com/company/tarovik-agro-foods-private-limited/U01100UP2026PTC310001 | reject | reject |
| directory.crunchbase | https://www.crunchbase.com/organization/tarovik-agro-foods | reject | reject |
| directory.dnb | https://www.dnb.com/business-directory/company-profiles.tarovik_agro_foods_private_limited.html | reject | reject |
| marketplace.indiamart | https://www.indiamart.com/tarovik-agro-foods/ | reject | reject |
| marketplace.justdial | https://www.justdial.com/Lucknow/Tarovik-Agro-Foods/0522P1234 | reject | reject |
| marketplace.tradeindia | https://www.tradeindia.com/tarovik-agro-foods/ | reject | reject |
| builder.wixsite | https://tarovikagro.wixsite.com/home | reject | reject |
| builder.business_site | https://tarovik-agro-foods.business.site/ | reject | reject |
| builder.github_io | https://tarovik.github.io/ | reject | reject |
| builder.weebly | https://tarovikagrofoods.weebly.com/ | reject | **accept** |
| builder.blogspot | https://tarovikagro.blogspot.com/ | reject | reject |
| other.same_word_other_business | https://www.tarovikhospital.example/ | reject | reject |
| other.parked_domain | https://tarovikagro.example/ | reject | reject |
| other.generic_word_domain | https://herbals.example/ | reject | reject |
| other.surname_other_business | https://sharmasweets.example/ | reject | reject |

**Web search egress:** the query sent was `"ZEPHYRA HERBALS" Lucknow`; pages fetched: https://zephyraherbals.example/; canaries in them: none.

## 6. Docs agree with the code

- **CLI commands:** 57 distinct commands named in README.md, docs/HANDOVER.md and ops/ (against 39 Node commands and 12 ingest commands): all exist.
- **OpenAPI:** 17 paths (14 served by the engine): every engine path is served and every platform path has a client. Admin JSON routes not in the contract (informational): /api/review, /api/alerts, /api/companies, /api/approvals.
- **.env.example:** 77 variables documented, 69 read by the code. Read but not documented: CAPS_FILE (services/src/config.js:32), DKIM_SELECTOR (services/src/ops/preflight.js:172), SARVAM_API_BASE (services/src/voice/sarvam.js:90), <MAILBOX_n>_SMTP_USER (services/src/outreach/transport.js:30). Documented but never read by the code: EXPORT_S3_URI (read by ops/deploy scripts only).
- **Config files:** 13 referenced, 11 parsed: all exist and parse.
- **Test counts:** real 257 Node (static count of test( and it( calls in services/test/*.test.js) and 272 Python (pytest --collect-only (collects, runs nothing)). Quoted: README.md:13 node 258, python 272, total 530; docs/HANDOVER.md:155 node 258; docs/HANDOVER.md:156 python 272. All close.

## Limits of this run

- The drafts are the reviewed templates'. The AI drafter is not exercised (no model runs offline); Eval 2 measures what would stop its mistakes.
- The gate cases change the database directly where a real path would (a holdout flag, a message field) to reach the gate; each case says why.
- Matching runs on a universe of a few dozen companies; Splink's prior and u are fitted on it, so its probabilities, and the recall, are indicative of production rather than equal to it. Precision is the number that matters most, and the pairs were written to be hard.
- Network: nothing tried to leave the machine (the guard refused nothing).
