# Lead engine evals: report

Run 2026-11-18T20:14:43.398Z (IST 2026-11-19 01:44), 16.5 s, by `node evals/run.mjs`. What each eval measures and how to read it: `evals/README.md`. Machine-readable: `evals/report.json`.

## Scorecard

| Eval | Headline |
|---|---|
| 1. Draft factuality and lawfulness | 71 drafts from 37 companies: facts 100% from the pack; every check passed by 0/71 (71/71 if the signature's website link is allowed) |
| 2. QC sensitivity | eval:qc 7080/7080 (100.0%), 0 false positives; this suite's mutations 1354/1354 (100.0%); 0 of 24 mutation types never caught |
| 3. Compliance gate | 39/39 cases agree (100.0%); 0 disagreement(s), 0 harness error(s) |
| 4. Privacy egress | 13 outside calls over 6 services; no canary left the engine |
| 5. Matching and websites | 48 pairs: precision 100.0%, recall 47.1% (linked or sent to review 33/34); websites 30/30, directories and social networks rejected 23/23; web search egress clean |
| 6. Docs agree with the code | 243 items checked; 0 mismatch(es) |

## Findings

Most severe first. Each was observed in this run; the file:line points at the code responsible, as it reads today.

### 1. [Low] Every template email carries a third link (the sender's website in the signature)

- **Where:** services/src/outreach/templates.js:28, services/src/outreach/draft.js:34
- **Failing cases:** 71/71 drafts: other links: https://solutionai.in
- **Why it matters:** templates.js promises "one link to the company's page and one to unsubscribe", and the AI prompt says the page link is "the only link", yet the signature it must copy word for word holds https://solutionai.in. qc.js deliberately allows it. Harmless in itself, but the promise, the prompt and the code disagree; decide which is meant.

### 2. [Low] Transliteration variants of the same name are not even put in front of a reviewer

- **Where:** ingest/src/leadengine/names.py:73, ingest/src/leadengine/kb/match.py:376
- **Failing cases:** translit.devanagari: not linked (no company with a similar name in the CIN universe we hold)
- **Why it matters:** Laxmi/Lakshmi, Shri/Shree, a name typed in Devanagari: the founder's company is in the universe but no candidate reaches the review queue, so the startup stays unlinked and its facts never join the company record. Precision is unharmed; recall on Hindi-belt names is.

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
| why.matches_basis | 71/71 | 100.0% |
| opt_out.words | 71/71 | 100.0% |
| privacy.no_person | 71/71 | 100.0% |
| lawful.no_conditional_obligation | 71/71 | 100.0% |
| lawful.no_threat_or_urgency | 71/71 | 100.0% |
| length.subject | 71/71 | 100.0% |
| length.body | 71/71 | 100.0% |

**Every failing draft, by check:**

- `links.no_other_links` (71): aarvik/first_touch/en; aarvik/follow_up/en; aarvik/new_need/en; bhuvira/first_touch/hi; bhuvira/follow_up/hi; chandral/first_touch/hi; chandral/follow_up/hi; dhanvio/first_touch/en; dhanvio/follow_up/en; ekansh/first_touch/hi; ekansh/follow_up/hi; falgun/first_touch/en; falgun/follow_up/en; falgun/new_need/en; garvisha/first_touch/en; garvisha/follow_up/en; garvisha/new_need/en; hemkosh/first_touch/hi; hemkosh/follow_up/hi; ilavya/first_touch/hi; ilavya/new_need/hi; jivantra/first_touch/en; jivantra/follow_up/en; kaushvi/first_touch/hi; lavanyo/first_touch/en; lavanyo/follow_up/en; madhurak/first_touch/en; navyarth/first_touch/en; navyarth/follow_up/en; ojasvik/first_touch/hi; ojasvik/follow_up/hi; ojasvik/new_need/hi; prakriva/first_touch/hi; prakriva/follow_up/hi; quarvi/first_touch/en; rudhvik/first_touch/hi; rudhvik/follow_up/hi; saanvra/first_touch/en; saanvra/new_need/en; tanmayo/first_touch/hi; udbhav/first_touch/en; udbhav/follow_up/en; vaidhra/first_touch/en; yashvik/first_touch/hi; yashvik/follow_up/hi; yashvik/new_need/hi; zorvana/first_touch/en; amritsa/first_touch/hi; amritsa/new_need/hi; barkhaya/first_touch/en; barkhaya/follow_up/en; chitrakh/first_touch/en; devansha/first_touch/en; devansha/follow_up/en; eshvika/first_touch/hi; eshvika/follow_up/hi; gaurangi/first_touch/hi; hiranyo/first_touch/en; hiranyo/follow_up/en; indravi/first_touch/hi; indravi/follow_up/hi; jagrit/first_touch/en; jagrit/new_need/en; kalindo/first_touch/en; lokvesh/first_touch/hi; lokvesh/follow_up/hi; lokvesh/new_need/hi; mrinavi/first_touch/en; mrinavi/follow_up/en; omvara/first_touch/en; omvara/follow_up/en — each one: other links: https://solutionai.in

The engine's own quality check failed 5 of these drafts: bhuvira/first_touch/hi (facts.no_other_company: names another company: Private Limited); bhuvira/follow_up/hi (facts.no_other_company: names another company: Private Limited); tanmayo/first_touch/hi (facts.no_other_company: names another company: Private Limited); mrinavi/first_touch/en (facts.no_other_company: names another company: Private Limited); mrinavi/follow_up/en (facts.no_other_company: names another company: Private Limited).

## 2. QC sensitivity

**The engine's own set** (`eval:qc`, services/src/eval/qc.js): 360 clean drafts, 0 false positives; 7080 broken drafts over 20 fault types, 7080 caught (100.0%).

**This suite's mutations**, each applied to every clean draft from Eval 1 where it applies (1354 mutated drafts, 1354 caught, 100.0%). "Caught by" is which QC check failed; a catch by facts.numbers for a phone or a date is a catch for the wrong reason, and would be missed if the digits happened to be in the pack.

| Mutation | Engine QC caught | Rate | Caught by | This suite's grader caught |
|---|---|---|---|---|
| date.shifted: a deadline one day off | 62/62 | 100.0% | facts.dates 62, facts.dates_match_deadlines 62 | 62/62 |
| date.us_format_wrong: a wrong date written "Month D, YYYY" | 35/35 | 100.0% | facts.dates 35, facts.numbers 20 | 35/35 |
| date.swapped: two deadlines' dates swapped | 19/19 | 100.0% | facts.dates_match_deadlines 19 | 19/19 |
| section.invented: an invented section number | 66/66 | 100.0% | facts.sections 66, facts.numbers 66, length.body 4 | 66/66 |
| section.near_miss: a section one letter off (s.10A as s.10B) | 20/20 | 100.0% | facts.sections 20 | 20/20 |
| form.truncated: a form code cut short (INC-20A as INC-20) | 32/32 | 100.0% | facts.forms 32 | 32/32 |
| link.extra_https: an extra https link | 66/66 | 100.0% | links.no_others 66, length.body 1 | 66/66 |
| link.extra_bare_domain: an extra link written as a bare domain | 66/66 | 100.0% | links.no_others 66, length.body 1 | 66/66 |
| link.no_unsubscribe: the unsubscribe link removed | 66/66 | 100.0% | links.unsubscribe_once 66 | 66/66 |
| subject.shouted: the subject in capitals | 66/66 | 100.0% | subject.not_shouted 66 | 66/66 |
| amount.invented: an invented scheme amount | 66/66 | 100.0% | facts.amounts 66, facts.numbers 66, length.body 4 | 66/66 |
| amount.figure_from_a_date: an invented amount whose figure appears in a date of the pack | 62/62 | 100.0% | facts.amounts 62, length.body 4 | 62/62 |
| amount.misattributed: a scheme amount from the pack given to the wrong scheme | 2/2 | 100.0% | facts.amounts_match_schemes 2, length.body 1 | 1/2 |
| phone.standard: a personal mobile, 98765 43210 | 66/66 | 100.0% | facts.numbers 66, privacy.no_contacts 66, length.body 4 | 66/66 |
| phone.plus91_dashes: a personal mobile, +91-98765-43210 | 66/66 | 100.0% | facts.numbers 66, privacy.no_contacts 66, length.body 3 | 66/66 |
| phone.grouped_4_3_3: a personal mobile, +91 9876 543 210 | 66/66 | 100.0% | facts.numbers 66, privacy.no_contacts 66, length.body 4 | 66/66 |
| phone.landline: a landline, 0522 4012345 | 66/66 | 100.0% | facts.numbers 66, privacy.no_contacts 66, length.body 4 | 66/66 |
| email.personal: a personal email address | 66/66 | 100.0% | privacy.no_contacts 66, length.body 3 | 66/66 |
| person.director_named: a director named | 66/66 | 100.0% | privacy.no_person_named 66, length.body 4 | 66/66 |
| company.other_in_greeting: another company's name in the greeting | 66/66 | 100.0% | facts.no_other_company 66 | 66/66 |
| opt_out.words_removed: the opt-out sentence removed, the link kept | 66/66 | 100.0% | opt_out.words 66 | 66/66 |
| tone.penalty_paraphrase: a penalty threat in other words | 66/66 | 100.0% | tone.no_pressure 66, length.body 3 | 66/66 |
| tone.urgency_paraphrase: urgency in other words | 66/66 | 100.0% | tone.no_pressure 66, length.body 4 | 4/66 |
| tone.missed_paraphrase: a claim that a filing was not made, in other words | 66/66 | 100.0% | tone.no_missed_claim 66, length.body 4 | 4/66 |

The last column checks the checker: Eval 1's grader, run on the same mutated drafts, caught 1229/1354 (90.8%), so its clean bill for the templates' facts is not for want of looking. Where it misses too, it is because the mutation is outside what it grades (tone in other words is checked only by a phrase list here as well).

## 3. Compliance gate

Each case runs the engine's real path on a throwaway MongoDB: plan, draft (with the address check), a person's approval, then the send job and its gate, with a transport that keeps the email and sends nothing. Outcome: send (the transport was handed the email), wait, stop, or no_message (nothing reached the gate). 39/39 agree.

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
| stop.cin_says_not_up | stop or no_message | stop | stop: not_up | yes |
| stop.already_contacted | stop or no_message | stop | stop: already_sent | yes |
| stop.published_by_person | stop | stop | stop: no_legal_basis | yes |
| stop.consent_label_without_consent | stop | stop | stop: no_consent | yes |
| stop.website_address_switch_off | no_message | no_message | — | yes |
| stop.website_address_switch_turned_off | stop or wait | stop | stop: website_email_off | yes |
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

## 4. Privacy egress

Canary personal data (fixtures/canaries.json) planted in the company record, the vendor profile, the portal team and the founder's reply; every outside call captured.

| Path | Service | Calls | Canaries in the request |
|---|---|---|---|
| draft: the AI drafter, its review and the address check | llm:draft | 4 | nothing |
| draft: the AI drafter, its review and the address check | llm:quality_check | 2 | nothing |
| draft: the AI drafter, its review and the address check | email verification service | 1 | nothing |
| match_check: the AI check on an unsure match | llm:match_check | 1 | nothing |
| reply_classify: a signature without a "-- " line | llm:reply_classify | 1 | nothing |
| reply_classify: a signature after a "-- " line | llm:reply_classify | 1 | nothing |
| reply_classify: numbers written other ways | llm:reply_classify | 1 | nothing |
| platform onboarding: a direct claim | platform /onboarding | 1 | nothing |
| platform onboarding: a campaign claim, before and after its email confirmation | platform /onboarding | 1 | nothing |

- Email verification service: called 1 time(s), for info@quillora.example; the director's own registered address got the free checks only.
- Campaign claim before its email confirmation: 0 outside call(s), 0 consent(s) recorded, 0 claim(s) recorded; the confirmation went only to rohan.tejpal@zephyraherbals.example. After confirmation: 1 onboarding call, claim recorded 1.
- What reached the platform's onboarding: only what the claimant typed (name/role/email/whatsapp; name/role/email/whatsapp), which is the point of claiming; none of the planted canaries.

## 5. Matching on hard name pairs, and websites

48 labelled pairs (34 same, 14 different), 47 startups against 68 companies (the pairs' own and invented distractors). Thresholds: automatic link at probability 0.98 with a 6-bit margin, review from 0.3 (kb-match-v2). Precision and recall are of automatic links; a pair sent to review is not a link.

| Run | Links | Wrong links | Precision | Recall | Same pairs linked or sent to review | Seconds |
|---|---|---|---|---|---|---|
| exact_and_splink | 16 | 0 | 100.0% | 47.1% | 33/34 | 1.7 |
| exact_only | 16 | 0 | 100.0% | 47.1% | 23/34 | 0 |

**Every miss (exact_and_splink):**

| Pair | Category | Label | Outcome | Name level | Why |
|---|---|---|---|---|---|
| spacing.joined_word | spacing and punctuation | same | review | same | probability below the automatic threshold |
| opc.dropped_by_founder | (OPC) | same | review | same | same name under another legal form; confirm it is the same business |
| spacing.split_word | spacing and punctuation | same | review | same | probability below the automatic threshold |
| spacing.joined_generic | spacing and punctuation | same | review | typo | probability below the automatic threshold |
| typo.distinctive_word | spelling slip | same | review | typo | probability below the automatic threshold |
| typo.generic_word | spelling slip | same | review | same | probability below the automatic threshold |
| typo.doubled_letter | spelling slip | same | review | typo | the same name in another spelling (Shri and Shree, Lakshmi and Laxmi); confirm it is the same business |
| translit.shri_shree | Hindi and English transliteration | same | review | different | the same name in another spelling (Shri and Shree, Lakshmi and Laxmi); confirm it is the same business |
| translit.laxmi_lakshmi | Hindi and English transliteration | same | review | different | the same name in another spelling (Shri and Shree, Lakshmi and Laxmi); confirm it is the same business |
| translit.devanagari | Hindi and English transliteration | same | not linked | different | no company with a similar name in the CIN universe we hold |
| translit.krushi_krishi | Hindi and English transliteration | same | review | typo | probability below the automatic threshold |
| translit.compound_word | Hindi and English transliteration | same | review | different | the same name in another spelling (Shri and Shree, Lakshmi and Laxmi); confirm it is the same business |
| translit.two_vowels | Hindi and English transliteration | same | review | different | the same name in another spelling (Shri and Shree, Lakshmi and Laxmi); confirm it is the same business |
| plural.solar_solars | spacing and punctuation | same | review | typo | probability below the automatic threshold |
| plural.technologies | spacing and punctuation | same | review | same | probability below the automatic threshold |
| ignorable.the_company | spacing and punctuation | same | review | same | probability below the automatic threshold |
| plural.ventures | spacing and punctuation | same | review | same | probability below the automatic threshold |
| year.founder_year_far | same name, other facts disagree | same | review | same | the founder's year of establishment is more than a year from incorporation |

**Name level alone** (names.py and match.name_agreement, over the 40 pairs where the name is the question): precision 100.0%, recall 83.3%. Called the same but different: none. Same but not recognised: translit.shri_shree, translit.laxmi_lakshmi, translit.devanagari, translit.compound_word, translit.two_vowels.

**Website confirmation** (enrich/websites.py's search step with a fake search API and fetcher): 30/30 right; directories, marketplaces, social networks and shared builders rejected 23/23; the company's own sites accepted 7/7.

| Case | URL | Expected | Got |
|---|---|---|---|
| own.exact_domain | https://tarovikagro.example/ | accept | accept |
| own.first_word_domain | https://www.tarovik.example/about | accept | accept |
| own.hyphen_domain | https://tarovik-foods.example/ | accept | accept |
| own.cin_on_page | https://shivomherbals.example/ | accept | accept |
| own.two_letter_initials | https://vnagro.example/ | accept | accept |
| own.honorific_dropped | https://ganeshagro.example/ | accept | accept |
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
| builder.weebly | https://tarovikagrofoods.weebly.com/ | reject | reject |
| builder.blogspot | https://tarovikagro.blogspot.com/ | reject | reject |
| other.same_word_other_business | https://www.tarovikhospital.example/ | reject | reject |
| other.parked_domain | https://tarovikagro.example/ | reject | reject |
| other.generic_word_domain | https://herbals.example/ | reject | reject |
| other.surname_other_business | https://sharmasweets.example/ | reject | reject |

**Web search egress:** the query sent was `"ZEPHYRA HERBALS" Lucknow`; pages fetched: https://zephyraherbals.example/; canaries in them: none.

## 6. Docs agree with the code

- **CLI commands:** 57 distinct commands named in README.md, docs/HANDOVER.md and ops/ (against 39 Node commands and 12 ingest commands): all exist.
- **OpenAPI:** 21 paths (18 served by the engine): every engine path is served and every platform path has a client. Admin JSON routes not in the contract (informational): none.
- **.env.example:** 82 variables documented, 69 read by the code. Read but not documented: none. Documented but never read by the code: EXPORT_S3_URI (read by ops/deploy scripts only).
- **Config files:** 13 referenced, 11 parsed: all exist and parse.
- **Test counts:** real 261 Node (static count of test( and it( calls in services/test/*.test.js) and 275 Python (pytest --collect-only (collects, runs nothing)). Quoted: README.md:13 node 262, python 275, total 537; docs/HANDOVER.md:155 node 262; docs/HANDOVER.md:156 python 275. All close.

## Limits of this run

- The drafts are the reviewed templates'. The AI drafter is not exercised (no model runs offline); Eval 2 measures what would stop its mistakes.
- The gate cases change the database directly where a real path would (a holdout flag, a message field) to reach the gate; each case says why.
- Matching runs on a universe of a few dozen companies; Splink's prior and u are fitted on it, so its probabilities, and the recall, are indicative of production rather than equal to it. Precision is the number that matters most, and the pairs were written to be hard.
- Network: nothing tried to leave the machine (the guard refused nothing).
