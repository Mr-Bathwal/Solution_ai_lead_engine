# Technical Architecture Patterns for a State-of-the-Art AI Lead Engine (India, as of 24 Oct 2026)

Scope: the engineering patterns behind a pipeline that discovers newly registered Indian companies, enriches them, resolves them into one record, scores need and intent, runs outreach by email, WhatsApp, notifications and AI voice, and attributes outcomes. It is written for SolutionAI's stack (React/TS, Node.js, MongoDB, MCP agents, an LLM gateway over Gemini, OpenAI and Claude, AWS).

Method note: all figures were checked on 24 Oct 2026. Primary sources (RFCs, Google, Yahoo, Microsoft and Meta docs, vendor pricing pages, papers) are preferred, and vendor or third-party blogs are flagged. The shared web-search budget ran out partway through. Later lookups were direct fetches of known primary URLs, so a few sub-topics are thinner and are listed under Gaps.

---

## 1. Data ingestion & crawling (incremental crawling, change detection, polite scraping, headless vs APIs, LLM extraction, cost per page)

### Takeaway
Treat discovery as two systems. The first is a **registry feed**: MCA incorporation lists and master data, keyed on CIN/LLPIN, polled on a schedule. The second is a **web-evidence layer**: company sites, news and jobs, fetched incrementally with change detection and only rendered in a headless browser when needed. Basic fetch-and-convert-to-markdown now costs about **$0.001 per page** on managed APIs. Cost grows roughly 5× once LLM JSON extraction is added, so the design goal is to run LLM extraction only on pages whose content changed.

### Cited Findings
**Indian registry sources**
- MCA publishes **year-wise lists** of companies and LLPs registered in a given year, downloadable from the portal. Each list covers every entity registered that year whatever its current status, and current status comes from the entity's master data. MCA's Data & Reports section also has a "companies incorporated/closed during the month" report under Master Details. — [MCA Data & Reports](https://www.mca.gov.in/mca/html/mcav2_en/home/dataandreports/companystatistics/indianandforeigncompaniesllps/indianandforeigncompaniesllps.html)
- data.gov.in publishes MCA master data RoC-wise. Sources disagree on how often it refreshes. A 2015 Open Knowledge entry says annually ([OKFN 2015](https://2015.index.okfn.org/place/india/companies)), while a commercial scraper listing claims about monthly with filterable registration dates ([Apify actor](https://apify.com/nexgendata/mca-company-registry)). **Unresolved: check the live dataset.**
- The **CIN** is 21 characters: listing status (L/U), a 5-digit NIC industry code, a 2-letter state code, a 4-digit incorporation year, a 3-letter class (for example PTC), and a 6-digit ROC registration number. LLPs get an LLPIN instead. — [Bajaj Finserv explainer](https://www.bajajfinserv.in/what-is-cin) (secondary source)

**Polite crawling (standards)**
- **RFC 9309** (Robots Exclusion Protocol, Sept 2022):
  - Crawlers "SHOULD NOT use the cached version for more than 24 hours" unless robots.txt is unreachable.
  - The parse limit must be at least **500 KiB**.
  - A 4xx response on robots.txt means the crawler may access everything. A 5xx or unreachable response means **complete disallow**, possibly treated as unavailable after a long outage (the example given is 30 days).
  - **Crawl-delay is not standardized.**
  - The rules "are not a form of access authorization."
  - — [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html)

**Change detection (managed)**
- Firecrawl `changeTracking` compares each scrape with the previous snapshot of the same URL.
  - Statuses are `new`, `same`, `changed` and `removed`, plus a `visibility` field (linked vs hidden).
  - `git-diff` mode costs nothing beyond the scrape. `json` mode (schema-field diffs via an LLM) costs **5 credits per page**.
  - Snapshots persist and are team-scoped.
  - Matching is on exact URL + format + tag, so changing include/exclude tags breaks comparability. Whitespace and ordering changes are ignored.
  - Requests that track changes bypass the index cache.
  - The feature does not schedule anything itself.
  - — [Firecrawl docs](https://docs.firecrawl.dev/features/change-tracking)

**Cost per page and per search (official pricing pages, fetched Oct 2026)**
- **Firecrawl:**
  - Scrape or crawl costs 1 credit per page. Search costs 2 credits per 10 results. JSON mode adds 4 credits per page.
  - Plans: Free 1k credits (concurrency 2); Hobby $19/mo for 5k (5); Standard $99/mo for 100k (25); Growth $399/mo for 500k (50); Scale $749/mo for 1M (100). Annual billing is cheaper (Standard $83/mo).
  - — [Firecrawl pricing](https://www.firecrawl.dev/pricing)
  - Credits don't roll over and there is no pay-as-you-go. Top-ups cost more, for example $0.0025 per credit against about $0.00099 on Standard. — [eesel.ai review](https://www.eesel.ai/blog/firecrawl-pricing) (third-party)
  - Sources conflict on stealth/enhanced proxy: older reviews say 5 credits per page, while Firecrawl's current billing docs reportedly show no extra charge. — [TinyFish blog](https://www.tinyfish.ai/blog/firecrawl-pricing) (third-party)
- **Exa search:**
  - Per 1,000 requests (up to 10 results): $4 (lite/instant), $7 (auto/fast), $12 (deep), $15 (deep-reasoning, legacy).
  - Contents cost $1 per 1k pages per content type. Answer costs $5 per 1k. Monitors cost $15 per 1k.
  - The free tier is $10 a month in credits.
  - — [Exa pricing](https://exa.ai/pricing)
- **Tavily:**
  - A basic search costs 1 credit and an advanced search 2.
  - Pay-as-you-go is $0.008 per credit. Plans run $0.005–0.0075. There are 1,000 free credits a month.
  - Reportedly acquired by Nebius in 2026 and still operating under its own brand.
  - — [You.com comparison, Jul 2026](https://you.com/resources/tavily-vs-exa) (competitor-authored, so verify)
- **Browserbase (headless browsers):**
  - Free: 1 browser-hour, concurrency 3.
  - Developer: $20/mo for 100 h, concurrency 25, overage $0.12/h, proxy $12/GB.
  - Startup: $99/mo for 500 h, concurrency 100, overage $0.10/h, proxy $10/GB.
  - Billing is per minute with a **1-minute and 1-MB minimum per session**.
  - — [Browserbase plans](https://docs.browserbase.com/account/billing/plans.md)
- **Crawl4AI** is an open-source Python async crawler with CSS/XPath and LLM extraction strategies. It works with local models through Ollama (no API key needed) or with OpenAI. Its cloud API was in closed beta. — [Crawl4AI docs](https://docs.crawl4ai.com/), [quickstart](https://docs.crawl4ai.com/core/quickstart/)

**News firehose**
- GDELT updates its Event database "every 15 minutes".
  - It covers 100+ languages, 300+ event categories and about 60 attributes per event.
  - Its Knowledge Graph covers people, organizations and companies, and updates daily.
  - It is "100% free and open", via BigQuery or CSV.
  - — [GDELT](https://www.gdeltproject.org/)

### Inferences
- **Unit economics (Oct 2026 list prices):**
  - Plain markdown fetch: about $0.0008–0.001 per page (Firecrawl Standard/annual).
  - LLM JSON extraction through Firecrawl: about 5× that (~$0.004–0.005 per page).
  - Self-hosted Crawl4AI with your own LLM gateway moves the cost to tokens. A ~3k-token page on a small model is cheap, but you take on proxy, anti-bot and ops work.
  - Browserbase at $0.10/h costs about $0.0003 per page if a session renders ~6 pages a minute. Because of the per-session minimum, **reuse sessions** rather than opening one per URL.
- **Recommended ingestion pattern:**
  - (a) A scheduled MCA pull, diffed on CIN to find new incorporations, status changes and director changes.
  - (b) Discovery of the company's domain via a search API (Exa/Tavily) or your own matching.
  - (c) A conditional fetch of the homepage, about, careers and contact pages, with change tracking.
  - (d) LLM extraction only when the status is `changed` or `new`.
  - (e) Raw HTML/markdown stored in S3 keyed by URL + content hash, so you can re-extract when prompts change without re-crawling.
- Because a 5xx on robots.txt means full disallow, the crawler needs a robots.txt cache per host, with a TTL of 24 hours or less and a per-host token bucket. Don't depend on Crawl-delay.
- Newly registered Indian companies often have **no website yet**. For the first weeks, the registry record (CIN, NIC code, state, ROC, authorised/paid-up capital, directors) *is* the lead. Web enrichment should be retried on a back-off schedule, for example at day 7, 30 and 90, not once.

### Gaps
- The exact refresh cadence and field list of MCA monthly incorporation data and data.gov.in, and whether MCA V3 exposes an official bulk or API feed. Not verified in this pass.
- No public benchmark of extraction accuracy, Firecrawl vs Crawl4AI vs Browserbase+LLM, on Indian SME sites.
- Perplexity Sonar API pricing was not checked, because the search budget was exhausted.

---

## 2. Waterfall enrichment (Clay-style waterfalls, provider ordering, confidence, caching, cost control)

### Takeaway
A waterfall is a sequential fallback chain for each field: try provider A, validate, and move to B only if the result is missing or invalid. It stops at the first validated hit. Clay's billing model shows the design: you **pay only for steps that return data**, validation steps are billed too, and bring-your-own provider keys shift cost off the platform. Whether to order cheapest-first or coverage-first is a real trade-off, and Clay's own materials disagree on it.

### Cited Findings
- **Clay's official FAQ:**
  - "Each step of the waterfall that returns data will consume Data Credits (unless using API keys) and an Action."
  - "Each validation step of the waterfall will consume Data Credits... and an Action."
  - "Once validated data has been returned, no additional Data Credits or Actions will be consumed."
  - If the whole waterfall returns nothing, nothing is charged.
  - Using your own API keys consumes an Action but no Data Credits.
  - Rules are user-configurable per waterfall.
  - — [Clay FAQ](https://www.clay.com/faq/do-unsuccessful-searches-consume-data-credits-what-about-actions)
- **Ordering is contested.**
  - Clay University says waterfalls start "with the most cost-effective provider". — [Clay University course](https://university.clay.com/fr/lessons/enrich-people-waterfalls-clay-101)
  - A Clay staff community answer says the method maximizes "coverage and quality" rather than prioritizing the cheapest source. — [Clay community](https://community.clay.com/x/support/9qmuixh648rm/understanding-clay-enrichment-and-the-waterfall-me)
- **Per-provider cost examples (community posts, not official pricing):**
  - Email lookups cost about 2 credits via Prospeo, DropContact, Datagma or Hunter, and 5 via People Data Labs.
  - Mobile numbers can cost up to 25 credits.
  - Hunter is an exception that charges per attempt even when nothing is found.
  - — [Clay community thread](https://community.clay.com/x/support/zh4jt79va9um/email-enrichment-providers-with-no-cost-result-pol)
- **Email verification is the gate at the end of an email waterfall.** Catch-all (accept-all) domains can't be resolved per mailbox by SMTP probing. Mainstream tools return "risky/catch-all" rather than "deliverable." — [LeadMagic guide](https://leadmagic.io/blog/catch-all-email-verification-guide), [Bouncer](https://www.usebouncer.com/?p=961844) (vendors)
  - MillionVerifier claims to resolve 30–40% of catch-alls to "safe". — [MillionVerifier](https://www.millionverifier.com/catch-all-email-verifier/) (vendor claim, unverified)
- **Bounce targets vary by source:** a total bounce rate under 2% is common guidance, and ZeroBounce suggests hard bounces under 0.5%. — [Suped](https://suped.com/email-deliverability/answers/what-are-typical-bounce-rates-after-email-validation) (third-party)
  - The only ZeroBounce vs NeverBounce accuracy comparison found is one practitioner's single 10k-list test: ZeroBounce 98.1%, NeverBounce 97.3%. — [PuzzleInbox community](https://puzzleinbox.com/community/why-i-use-zerobounce-over-neverbounce-for-cold-email-lists) (anecdotal)

### Inferences
- **Pattern for SolutionAI**, a field-level waterfall service:
  - Schema per field: `field → [provider steps] → validator → confidence`.
  - Persist **every provider response with provenance**: provider, timestamp, raw payload hash, cost and the validator verdict.
  - Cache by `(provider, normalized input key)` with a TTL per field. Firmographics change slowly, maybe 90 days. Emails and phones need about 30 days or re-verification before each send.
- **Ordering heuristic:** sort by expected cost per *validated* hit, which is price ÷ (hit rate × validity rate), measured on your own Indian sample. List price alone is the wrong measure. Indian SME coverage at US-centric providers (Apollo, PDL, Hunter) will be lower than their global averages. India-specific sources are likely to sit near the top: MCA director data, GST public search, Udyam, and your own crawls.
- **Confidence scoring:**
  - Combine provider prior accuracy (measured), cross-source agreement (two independent sources agreeing beats one), recency, and validator status.
  - Store it as a calibrated probability per field, not a label, so downstream scoring and outreach gating can set thresholds such as "send email only if p(valid) ≥ 0.9 and not catch-all."
- **Cost control:**
  - Enrich lazily, only after the scoring stage has cleared a lead for outreach.
  - Set per-tenant and per-campaign budgets.
  - Cache negative results too ("not found" with a shorter TTL), so failed lookups aren't repeated.

### Gaps
- No engineering-blog-level description of Clay's internal implementation (queueing, caching, provider SLAs) was found.
- No published India-specific coverage or hit-rate data for global enrichment providers.
- Apollo's and ZoomInfo's enrichment architectures were not covered, because the search budget ran out.

---

## 3. Entity resolution / record linkage (Fellegi–Sunter, Splink, Dedupe, Zingg, LLM matching, golden record, Indian identifiers)

### Takeaway
Use a **tiered matcher**. First, deterministic joins on hard government keys (CIN/LLPIN, GSTIN, PAN, Udyam). Next, probabilistic Fellegi–Sunter scoring (Splink) on names, addresses, directors and domains, with term-frequency adjustment and blocking. An LLM adjudicates only the grey-zone pairs. Splink is the most production-proven open-source option and runs on DuckDB or Spark. LLM matchers now match or beat fine-tuned models with few or no labels, and are more robust to unseen entity types, but they cost much more per pair.

### Cited Findings
**Probabilistic ER tooling**
- **Splink:**
  - Based on the Fellegi–Sunter model "with various customizations".
  - Can be trained **unsupervised** and supports **term-frequency adjustments** and custom fuzzy logic.
  - Claims to link "a million records on a laptop in approximately one minute" and to handle **100M+ records** on Spark.
  - Backends include DuckDB, Spark and PostgreSQL.
  - Ships diagnostic tooling: match weights, m/u parameters, waterfall charts, threshold selection and a cluster studio.
  - Field example: Homes England linked about **30M address records in under 5 hours** on Databricks.
  - Reported users include ONS, NHS England, the Australian Bureau of Statistics and Destatis.
  - — [Splink docs](https://moj-analytical-services.github.io/splink/index.html)
  - Splink 3 is in maintenance mode and development has moved to Splink 4. — [PyPI](https://pypi.org/project/splink/3.9.3)
  - Independent head-to-head accuracy comparisons are rare in the literature. — [UK Gov data-linking review](https://www.gov.uk/government/publications/joined-up-data-in-government-the-future-of-data-linking-methods/splink-mojs-open-source-library-for-probabilistic-record-linkage-at-scale)
- **Zingg:**
  - Active-learning labelling ("frugally small training samples").
  - Learns a blocking model, so typical comparisons are "0.05-1% of the possible problem space."
  - Spark-based, scaling to "millions of records."
  - **AGPL v3** licence, with an alternative licence available on request.
  - — [Zingg GitHub](https://github.com/zinggAI/zingg)
- **Dedupe:**
  - A single-machine Python library with interactive active learning. About 10 matches and 10 non-matches are said to be enough to train.
  - No native Spark support. Dedupe.io is a commercial web app.
  - — [DataChef review](https://blog.datachef.co/identity-resolution/) (secondary)
  - A 2025 enterprise ER paper automated Dedupe's labelling from ground truth and used Splink as a baseline. — [arXiv 2508.03767](https://arxiv.org/pdf/2508.03767)

**LLM-assisted matching**
- Peeters, Steiner & Bizer, "Entity Matching using LLMs" (arXiv 2310.11244, v4 Oct 2024, EDBT 2025):
  - The best LLMs need "no or only a few training examples" to perform comparably to BERT/RoBERTa fine-tuned on thousands of examples.
  - LLM matchers are **more robust to unseen entities**.
  - There is **no single best prompt**, so tuning is needed per model and dataset.
  - GPT-4 can produce structured explanations of match decisions.
  - — [arXiv](https://arxiv.org/abs/2310.11244)
- An earlier ADBIS 2023 paper reported ChatGPT zero-shot F1 of 82.35% on a hard benchmark. In-context demos added up to +7.85 F1, with similar gains from matching rules. — [summary](https://sotaverified.org/papers/using-chatgpt-for-entity-matching) (secondary)
- The 2026 "OpenSanctions Pairs" preprint reports LLM F1 up to **98.95% (GPT-4o)** against **91.33%** for a rule-based matcher on sanctions entity data, which includes organizations and transliterated names. — [arXiv 2603.11051](https://arxiv.org/pdf/2603.11051)

**Indian identifier keys**
- **GSTIN (15 characters):**
  - 2-digit state code (for example 09 = UP, 29 = Karnataka).
  - Characters 3–12 are the entity's **PAN**.
  - Character 13 is the registration count under that PAN in the state.
  - Character 14 is always "Z".
  - Character 15 is a checksum (reportedly mod-36).
  - — [TaxGuru](https://taxguru.in/goods-and-service-tax/gstin-goods-and-service-tax-identification-number-structure.html), [Tally](https://tallysolutions.com/glossary/gstin/)
- **Udyam:**
  - Format `UDYAM-XX-00-0000000`, where XX is the state code. The official portal calls it a "19 digit Udyam Registration Number."
  - A secondary source calling it 16 digits conflicts with this.
  - — [Udyam portal](https://www.udyamregistration.gov.in/Udyam_Login.aspx), [Housing.com](https://housing.com/news/udyam-udyog-aadhaar)
- **CIN:** encodes state, year and class (see §1). LLPs get a separate LLPIN. — [Bajaj Finserv](https://www.bajajfinserv.in/what-is-cin)

### Inferences
- **Key graph:**
  - **PAN is the hub.** It is embedded in every GSTIN, so all of a company's state GST registrations can be grouped deterministically by PAN substring.
  - CIN/LLPIN is the legal-entity anchor.
  - Udyam is a separate MSME key that links to PAN/GSTIN at registration.
  - Golden-record design: `legal_entity` keyed by CIN/LLPIN. Child `tax_registrations` (GSTIN[], derived PAN). Child `msme_registration` (Udyam). `web_presence` (domains, social handles). `people` (directors via DIN, contacts). Each attribute carries survivorship metadata: source, confidence, observed_at.
- **Name normalization for Indian companies** (rules to implement and test, not sourced standards):
  - Canonicalize suffixes: Private Limited / Pvt. Ltd. / Pvt Ltd / P. Ltd / (P) Ltd → `PVT_LTD`; Limited / Ltd; LLP / Limited Liability Partnership; OPC (One Person Company).
  - Strip punctuation and "M/s". Normalize "&" vs "and".
  - Keep a transliteration-aware phonetic key, since Hindi/regional names are romanized inconsistently (for example Shri/Sri/Shree, -nath/-nadh).
  - Name changes are common in MCA history, so keep `former_names[]`.
  - Splink's term-frequency adjustment is the right tool to stop common tokens ("Solutions", "Technologies", "Enterprises", "India") from inflating match weights.
- **Blocking keys:** state code (from CIN/GSTIN), pincode, first token of the normalized name, director DIN, and domain. Most false merges in Indian SME data are likely to come from generic names in the same city, so require at least one non-name agreement such as a director, address or domain before auto-merging.
- **LLM adjudication:**
  - Send only pairs in the Splink match-probability grey zone (for example 0.3–0.9) to the LLM gateway, with a structured-output prompt and few-shot examples of Indian edge cases.
  - Log the LLM's explanation as audit evidence.
  - Re-calibrate thresholds on a hand-labelled sample. Peeters et al. found prompts are model- and dataset-specific.
- **Licensing:** Zingg's AGPL v3 matters if it is embedded in a SaaS offered to third parties. Splink is the lower-risk default.

### Gaps
- MCA's own name-similarity rules (Companies (Incorporation) Rules, 2014, Rule 8) could not be fetched, because mca.gov.in returned 403. The normalization list above is engineering inference.
- No public benchmark of ER on Indian company data, and none on transliteration specifically.
- Whether PAN is publicly obtainable for a given CIN through official channels was not verified.

---

## 4. Signal & intent detection (event extraction, knowledge graphs, embeddings, real-time vs batch)

### Takeaway
Intent systems are **event pipelines**. Raw observations (filings, news, job posts, website changes, first-party engagement) are normalized into typed events (`funding_raised`, `hiring_role`, `capital_increase`, `director_added`, `new_gst_state`, `website_launched`, and so on). These attach to the resolved entity and decay over time. For newly registered Indian companies, registry deltas and first-party engagement will dominate. News and job signals matter mainly for older, larger firms.

### Cited Findings
- GDELT provides a free, 15-minute-latency global news event stream: 300+ event categories, entity and theme extraction (GKG, daily), and 100+ languages with real-time translation of 65 languages. — [GDELT](https://www.gdeltproject.org/)
- Common Room describes its approach this way:
  - A JS snippet captures website activity, and an "AI-powered identity resolution and enrichment engine" matches it.
  - "Person360" merges product usage, CRM, social and community activity into a single profile per contact.
  - The ABM page claims **50+ native signal types**. Visitor-identification match rates are claimed to reach about 50% at the person level.
  - — [Common Room blog](https://www.commonroom.io/blog/website-visitor-identification/), [About](https://www.commonroom.io/about), [ABM](https://www.commonroom.io/solutions/abm/) (vendor marketing; no engineering detail published)
- Firecrawl change tracking with `json` mode can turn a site into a field-level event stream, returning `previous` vs `current` for schema fields such as "pricing page exists" or "careers openings". It costs 5 credits per page. — [Firecrawl docs](https://docs.firecrawl.dev/features/change-tracking)
- MongoDB Vector Search:
  - Supports embeddings up to **8,192 dimensions**, HNSW ANN plus exact search, pre-filtering on indexed fields, and hybrid vector + full-text search.
  - An `autoEmbed` index type generates embeddings with Voyage AI models at index and query time.
  - Self-managed and local deployments are possible via the Atlas CLI.
  - — [MongoDB docs](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/)

### Inferences
- **Signal taxonomy for India:**
  - Registry: new incorporation; capital increase; new director or KMP; registered-office change; charge created (a borrowing signal); LLP→company conversion. Detect these by diffing MCA master data snapshots.
  - Tax/MSME: a new GSTIN in another state (expansion); a new Udyam registration.
  - Web: site launch, new careers page, tech-stack change.
  - News: funding, awards, government tenders.
  - First-party: visits to SolutionAI pages, email or WhatsApp replies, webinar attendance.
- **Real-time vs batch:**
  - Registry and news run in batch: daily to hourly, and GDELT at 15 minutes.
  - First-party engagement must be real-time, within minutes. A reply or pricing-page visit should re-score and route at once.
  - Architecturally, run one event bus (EventBridge or Kafka/Kinesis on AWS) carrying both, with a stream processor that updates feature values.
- **Embeddings:**
  - Use them to (a) map free-text company descriptions and NIC codes to SolutionAI's ICP or need categories via nearest-neighbour search over labelled "need archetypes", and (b) deduplicate news events about the same happening.
  - Keep embeddings co-located in MongoDB (Atlas Vector Search) unless volume justifies a separate store.
- **Knowledge graph:**
  - A lightweight property graph (company–director–address–domain) is valuable for ER and for "warm path" discovery, such as a director who also runs a company that is already a customer.
  - This can live as adjacency collections in MongoDB, or in Neptune if graph queries become central.

### Gaps
- No engineering-level public write-ups were found from Unify, Common Room, 6sense or ZoomInfo on intent-pipeline internals. The search budget was exhausted before further searching.
- No source quantified how predictive registry-delta signals are for Indian SME purchase intent.
- Indian job-board APIs and terms (Naukri, LinkedIn) were not researched.

---

## 5. Lead scoring (rules vs ML, gradient boosting, uplift, cold start, LLM-as-scorer calibration, feedback loops)

### Takeaway
Start with **transparent rules plus an LLM "fit/need" rubric**, log everything, and switch to a supervised propensity model (logistic regression or gradient-boosted trees) once there are a few hundred labelled outcomes. Treat LLM-produced scores as *features* that must be calibrated against outcomes. They are not probabilities, because verbalized LLM confidence is known to be overconfident. Optimize outreach on **uplift** (who responds *because* they were contacted), not raw propensity, once randomized holdouts exist.

### Cited Findings
- A systematic review (PMC) screened 44 studies and found 14 metrics for lead-scoring impact. **Classification** was the dominant approach, and **decision trees and logistic regression** were the most applied algorithms. — [PMC9890437](https://pmc.ncbi.nlm.nih.gov/articles/PMC9890437/)
- A University of Ottawa dissertation, combining a systematic literature review with an empirical B2B inside-sales model, reports that adding lead-profile insights to predictive models can significantly improve sales performance. — [uOttawa](https://ruor.uottawa.ca/items/5aa770f0-0469-4a07-a44e-c449228dd6f2)
- Claims that gradient boosting (XGBoost/LightGBM) dominates B2B lead scoring come mainly from vendor blogs. — [Sales-Mind blog](https://sales-mind.ai/blog/ai-algorithms-lead-scoring) (vendor; unsourced)
- **LLM calibration:**
  - Verbalized confidence is poorly calibrated and weak at predicting failures, improving with model capacity. — [arXiv 2306.13063](https://arxiv.org/pdf/2306.13063)
  - RLHF-trained models tend to verbalize overconfidence, partly because of biased reward models. — [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/file/29fb6e1456b3d8b57ede5c45aa2c6537-Paper-Conference.pdf)
  - An Apr 2026 preprint localizes inflated confidence to specific mid-to-late-layer components. — [arXiv 2604.01457](https://www.alphaxiv.org/abs/2604.01457.md)
- **Uplift modelling:**
  - Directly models "the incremental impact of a treatment".
  - Defines four segments: Persuadables, Sure Things, Lost Causes, and **Sleeping Dogs**, who respond *less* when contacted.
  - Requires a randomized control group.
  - — [Wikipedia](https://en.wikipedia.org/wiki/Uplift_modelling)
  - CausalML (Uber, open source) provides uplift and CATE methods using ML on experimental or observational data. — [CausalML docs](https://causalml.readthedocs.io/en/latest/about.html)

### Inferences
- **Cold-start plan:**
  1. Rules from ICP (NIC code, state, capital band, age, has-website, hiring) plus an LLM rubric scored on 3–5 *binary* criteria ("mentions manual processes," "is in a regulated sector needing compliance tooling"). Binary criteria are easier to audit and later calibrate.
  2. Log the feature vector, the score and the decision at send time (point-in-time features) to avoid leakage later.
  3. Once there are ≥300–500 outcomes (reply, meeting, conversion), fit logistic regression or LightGBM on those features, including the LLM criteria as features, and **calibrate** with isotonic or Platt scaling on a held-out set.
  4. Hold out 5–10% of eligible leads at random as a no-contact control from day one. This is the only way to later estimate uplift, and to detect "sleeping dogs" whom aggressive WhatsApp or voice outreach annoys.
- **Labels for B2B outreach:** use a staged outcome ladder (delivered → opened [unreliable] → replied → positive reply → meeting → paid). Model the earliest reliable stage (positive reply) for volume, and use a second model for conversion given reply.
- **LLM-as-scorer:** never threshold directly on an LLM's "85/100". Bin LLM scores and map them to empirical reply rates (a reliability diagram) each month. Pin model versions in the gateway, because scores drift when the provider model changes.
- **Feedback loop risk:** a model trained only on contacted leads learns the old policy's biases. The randomized holdout plus a small exploration budget (an epsilon-greedy share of sends to lower-scored leads) keeps the data unbiased.

### Gaps
- No peer-reviewed study was found on LLM-based B2B lead scoring accuracy or calibration specifically. The calibration evidence is from general QA.
- No India-specific lead-scoring benchmarks.
- Qini/AUUC evaluation details were not confirmed from a primary source in this pass.

---

## 6. Agentic orchestration (LangGraph, multi-agent, Temporal / Inngest / Trigger.dev, HITL approvals, guardrails, evals, cost)

### Takeaway
Separate **durable business workflows** (multi-day sequences, retries, rate limits, waiting for replies) from **agent reasoning** (research, drafting, classifying replies). Run the first on a durable-execution engine. For a Node/TS team the options are Temporal (most mature, with replay and audit, and the strictest determinism), Trigger.dev, or Inngest (TS-first, simpler). The second runs as short, bounded LangGraph/LLM calls inside activities or steps. Human approval should be a durable "wait for signal/event" step backed by an approval queue UI. Agent copy quality is governed by an LLM judge aligned to a human expert with binary pass/fail criteria.

### Cited Findings
- **Temporal limits:**
  - Event history has a hard limit of **51,200 events or 50 MB**, with a warning at **10,240 events or 10 MB**.
  - Default caps are **2,000** pending activities, child workflows, signals and cancel requests each.
  - — [Temporal docs](https://docs.temporal.io/workflow-execution/limits)
- **Comparisons (mostly vendor or affiliate content):**
  - Temporal: polyglot, the most established option, replays from history (giving a full audit trail), and has a steeper learning curve and heavier workers.
  - Trigger.dev: checkpoint-resume with no determinism rules, at the cost of no replayable history.
  - Inngest: TS-first and event-driven. Long agent loops can generate many billable executions, since each model call, tool call or wait becomes its own line item.
  - — [Noqta comparison](https://noqta.tn/blog/durable-execution-ai-agents-inngest-trigger-temporal-2026), [ZenML review](https://www.zenml.io/blog/inngest-alternatives), [Trigger.dev vs Temporal](https://trigger.dev/vs/temporal) (vendor)
- **Inngest throttling:**
  - `limit` run starts per `period` (1 s–7 d), plus `burst`.
  - An optional **`key`** expression gives each entity its own throttle, for example `event.data.user_id`.
  - Excess runs queue FIFO, unlike rate limiting, which drops them.
  - Concurrency limits running steps rather than run starts.
  - — [Inngest docs](https://www.inngest.com/docs/guides/throttling)
- **LangGraph durable execution:**
  - Requires a checkpointer plus a `thread_id`.
  - Durability modes are `exit`, `async` and `sync`. `sync` writes every checkpoint before continuing. `exit` can't recover from mid-run crashes.
  - Wrap side effects in tasks and keep workflows deterministic and idempotent.
  - — [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution), [checkpointers](https://docs.langchain.com/oss/langgraph/checkpointers)
- **LangGraph JS `interrupt()`:**
  - Pauses execution indefinitely, persists state, and resumes via `new Command({ resume })` on the same `thread_id`.
  - Supported patterns: approve/reject, edit state, and approval inside tools.
  - Caveats:
    - **On resume the node restarts from the beginning**, so side effects before `interrupt()` must be idempotent.
    - Don't swallow interrupts in try/catch.
    - Interrupt matching is index-based, so the order must be deterministic.
    - Static breakpoints are for debugging, not HITL.
  - — [LangGraph JS interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- **LLM-as-judge for outbound copy (Hamel Husain):**
  - Use one principal domain expert.
  - Make **binary pass/fail** judgments with written critiques, not 1–5 scales.
  - Start with about 30 examples and grow until no new failure modes appear.
  - Iterate the judge prompt until it agrees with the expert. One example reached over 90% agreement in 3 iterations.
  - Report **TPR and TNR separately**, use a train/dev/test split, and run the frozen judge on test once.
  - Aim for about **100 labelled examples per failure mode**. Below about 60, confidence intervals are too wide.
  - — [Hamel.dev](https://hamel.dev/blog/posts/llm-judge/)
  - A survey of judge work lists agreement metrics: percentage agreement, Cohen's κ and Spearman. — [arXiv 2411.15594](https://arxiv.org/pdf/2411.15594)
  - An ACL 2026 paper finds that human-vs-AI authorship labels bias both human and LLM judges. — [ACL 2026](https://aclanthology.org/2026.acl-long.1495/)

### Inferences
- **Recommended split for SolutionAI:**
  - **Temporal (TypeScript SDK)** runs each lead's outreach *sequence* as a workflow: wait-until-send-window, send email, wait 3 days *or* a reply signal, branch, and so on. Activities make the provider calls.
  - **LangGraph (JS)** or plain gateway calls handle "research this company", "draft message", "classify reply", "decide next step".
  - **MCP tools** are exposed to agents only through a policy layer.
  - Temporal's 51,200-event history limit means long-lived per-lead workflows should use Continue-As-New per sequence step, or one workflow per sequence.
  - If the team prefers less operational load, Trigger.dev or Inngest work. Inngest's keyed throttling maps naturally to **per-inbox and per-WhatsApp-number send pacing**.
- **HITL approval queue:**
  - The workflow emits `approval_requested` with the draft, evidence and judge verdict, then waits on a signal.
  - The React dashboard shows the queue. Approve, edit or reject sends the signal.
  - Default to **mandatory human approval for first-touch messages on new channels and segments**. Relax to sampling (for example 10%) once judge TPR/TNR on that segment is stable.
- **Guardrails, layered:**
  - (1) Deterministic checks: suppression list, consent state, quiet hours, frequency caps per person and company and channel, link and domain allowlists, PII redaction.
  - (2) LLM judge: factual grounding against the evidence pack, tone, no false claims, and language.
  - (3) Rate limits from §7 and §8.
  - Deterministic checks must run *after* the LLM stage and immediately before send, as part of the same activity.
- **Cost control:**
  - Route by task through the gateway: small or cheap models for classification and extraction, larger models only for drafting first touches.
  - Cache research outputs per company with a TTL.
  - Set per-lead token budgets enforced in the workflow.
  - Record `gen_ai.usage.*` on every span (see §10) so that cost per lead and cost per meeting are queryable.

### Gaps
- Temporal Cloud, Inngest and Trigger.dev pricing were not fetched in this pass.
- Head-to-head reliability data comes only from vendor or affiliate pages.
- No public post-mortems from AI SDR companies on agent failure modes were found in this pass.

---

## 7. Email deliverability engineering (domains, warm-up, SPF/DKIM/DMARC, Gmail/Yahoo/Microsoft rules, RFC 8058, spam thresholds, rotation, verification)

### Takeaway
Mailbox-provider rules are now hard gates, not best practice:
- **Gmail** (Feb 2024, with enforcement ramping since **Nov 2025**) and **Yahoo** (Feb 2024) require SPF + DKIM + DMARC (p=none minimum, aligned) for bulk senders, one-click unsubscribe (RFC 8058) for marketing mail, and spam rates below 0.3% (Gmail target below 0.1%).
- **Microsoft** consumer mail (Outlook.com, Hotmail, Live) enforced SPF + DKIM + DMARC for 5,000+/day senders from **5 May 2025**, rejecting with `550 5.7.515`.

Cold outbound at scale is engineered as many low-volume, warmed mailboxes on secondary domains. Per-inbox caps and warm-up schedules are vendor folklore, so they need to be measured.

### Cited Findings
**Gmail**
- From **1 Feb 2024**, senders of 5,000+ messages a day to Gmail must:
  - Set up SPF and DKIM, plus DMARC (policy may be `none`), with the From: domain aligned to SPF or DKIM.
  - Use a DKIM key of at least **1024 bits** (2048 recommended).
  - Support **one-click unsubscribe** for marketing and subscribed mail (headers `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and `List-Unsubscribe`), plus a visible body link.
  - Keep the Postmaster spam rate **below 0.30%**, ideally **below 0.10%**.
  - Have valid forward and reverse DNS (PTR) and use **TLS** (added Dec 2023).
  - Send RFC 5322-compliant messages.
  - — [Google sender guidelines](https://support.google.com/a/answer/81126)
- Gmail timeline:
  - One-click unsubscribe was required from **1 Jun 2024**. Senders above 0.3% spam became ineligible for mitigation from **June 2024**.
  - Mitigation eligibility returns after **7 consecutive days below 0.3%**.
  - "Starting November 2025, Gmail is ramping up its enforcement": temporary (4.7.x) and permanent (5.7.x) rejections, "gradual and progressive". New domains face an accelerated timetable.
  - Unsubscribe requests should be honoured within **48 hours** (a recommendation).
  - — [Google sender FAQ](https://support.google.com/a/answer/14229414)
- Bulk-sender status is permanent once reached. — [Red Sift](https://redsift.com/resources/blog/gmails-enforcement-ramps-up-what-bulk-senders-need-to-know) (third-party)

**Yahoo**
- Enforcement began **Feb 2024**.
- All senders need SPF *or* DKIM and a spam rate **below 0.3%**.
- Bulk senders need:
  - Both SPF and DKIM.
  - DMARC of at least `p=none` that passes (relaxed alignment is fine).
  - Working List-Unsubscribe with one-click (RFC 8058 POST "highly recommended", mailto acceptable).
  - A visible body link.
  - To **honour unsubscribes within 2 days**.
- The spam rate is computed on inbox-delivered mail.
- — [Yahoo Sender Hub](https://senders.yahooinc.com/best-practices/)

**Microsoft (consumer Outlook.com, Hotmail, Live)**
- Applies to senders of 5,000+ messages to Microsoft consumer services from the same 5322.From domain.
- SPF and DKIM must pass. A DMARC record is required (`p=none` is acceptable) and must align with SPF or DKIM.
- Non-compliant mail is rejected with **"550 5.7.515 Access denied, sending domain … does not meet the required authentication level."**
- — [Microsoft support](https://support.microsoft.com/en-gb/outlook/fix-ndr-error-550-5-7-515-in-outlook-com)
- Microsoft announced the rule on 2 Apr 2025 and enforced it from **5 May 2025**. Initially mail went to Junk, with rejections then phased in, and the article is inconsistent on timing. Unlike Gmail and Yahoo, Microsoft hasn't explicitly required RFC 8058. — [Mailgun, 1 May 2025](https://www.mailgun.com/blog/deliverability/microsoft-sender-requirements/)

**Cold-email operations (vendor sources, conflicting)**
- Per-inbox caps run from about 20–30 to 30–50 emails a day. One vendor notes that "Neither Gmail nor Outlook publishes a specific 'safe' cold outbound number." — [Unify](https://www.unifygtm.com/explore/cold-email-daily-sending-limits-deliverability), [Smartlead](https://www.smartlead.ai/blog/how-many-cold-emails-per-day), [LeadHaste](https://leadhaste.com/blog/inbox-rotation-cold-email-guide)
- Use dedicated look-alike outbound domains with about 2–3 mailboxes each. Warm up for **≥3 weeks**, starting at 5–10 emails a day per inbox. Capacity ≈ per-inbox cap × inbox count. — [Unify multiple inboxes](https://www.unifygtm.com/explore/cold-email-multiple-inboxes), [LeadHaste](https://leadhaste.com/blog/inbox-rotation-cold-email-guide)
- **Verification:** catch-all addresses can't be confirmed per mailbox (see §2). Common guidance keeps the total bounce rate under 2%. — [Suped](https://www.suped.com/knowledge/email-deliverability/sender-reputation/what-is-an-acceptable-bounce-rate-threshold-and-how-does-it-affect-sender-reputation)

### Inferences
- **Sending architecture for SolutionAI:**
  - Never send cold mail from `solutionai.*` primary domains.
  - Run a pool of N outbound domains, each with full SPF/DKIM (2048-bit)/DMARC (p=none, then quarantine once clean), a custom tracking domain or none, and 2–3 Google Workspace or M365 mailboxes per domain.
  - Treat each mailbox as a rate-limited resource: Inngest/Temporal keyed throttle on `mailbox_id`, daily cap, and send windows in IST business hours.
  - Rotation picks the healthiest mailbox with remaining capacity and pins replies to the same thread and mailbox.
- **Even below 5,000/day**, adopt the bulk-sender rules (one-click unsubscribe, DMARC alignment, a 2-day unsubscribe SLA). Thresholds are per From-domain and permanent once crossed, and enforcement has tightened since Nov 2025.
- **Health telemetry per domain and mailbox:**
  - Hard bounces (stop the mailbox at >2% daily).
  - Spam complaints (Google Postmaster Tools only reports above a volume floor, so also track reply-sentiment proxies).
  - 4xx deferral rate and 5.7.x rejections.
  - Reply rate.
  - Auto-pause on threshold breach.
- **Verification policy:** verify at enrichment and again within 7–14 days before send. Exclude or segment catch-alls into a low-volume, high-score-only lane.
- **Indian B2B nuance:** many targets are on Google Workspace or M365 business tenants, not consumer gmail.com or outlook.com. Gmail's and Microsoft's numeric thresholds are framed around personal/consumer mailboxes, but spam filtering and reputation still apply. Note that many very small Indian businesses also use personal @gmail.com addresses.

### Gaps
- Whether Gmail's 5,000/day counting applies only to personal Gmail and not Workspace recipients was not confirmed from the fetched text, which mentions "personal Gmail accounts" only for the DKIM requirement.
- Microsoft's official Tech Community post body couldn't be retrieved. Enforcement nuance (junk vs reject timing) relies on Mailgun.
- No primary data on warm-up efficacy (warm-up networks are controversial). No India-specific inbox-placement data.

---

## 8. WhatsApp Business Platform technical rules (templates, opt-in, quality, limits, pricing incl. India INR, per-user caps, Cloud API vs BSP)

### Takeaway
WhatsApp is the highest-reach channel in India and the most tightly governed:
- **Per-message pricing** since 1 Jul 2025, charged on delivery.
- **India marketing is about ₹0.86 per message** (raised 1 Jan 2026). Utility and authentication are about ₹0.115.
- **INR billing is mandatory for eligible Indian customers by 31 Dec 2026.**
- New charges since **1 Oct 2026**: utility inside the service window, and service messages beyond 1,000 a month per number.
- Delivery is gated by a portfolio-level unique-recipient limit (250 → 2K → 10K → 100K → unlimited), template quality (pause 3h → 6h → disable), and an opaque **per-user cross-business marketing cap** (error 131049).

Cold marketing templates to scraped numbers are therefore both a policy breach (opt-in required) and a quality-rating risk. Use WhatsApp after opt-in, or for click-to-WhatsApp inbound.

### Cited Findings
**Pricing (Meta developer docs)**
- Per-message pricing started **1 Jul 2025** and replaced conversation pricing. Charges apply on delivery, and user-to-business messages are free.
- Template categories are marketing, utility and authentication. Authentication-international is a separate *rate*. Service is non-template.
- **Volume tiers** apply to utility and authentication only. They aggregate across the business portfolio and reset monthly. A `VOLUME_BASED_PRICING_TIER_UPDATE` webhook has fired since 1 Oct 2025.
- **Free entry point:** a reply to a Click-to-WhatsApp ad (mobile only) opens a **7-day** window in which all categories are free.
- — [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- **1 Oct 2026 changes:**
  - Utility messages in an open customer-service window became **charged**, where they had been free since 1 Jul 2025. The webhook pricing type changes from `free_customer_service` to `regular`.
  - **Service messages beyond 1,000 free per phone number per month are charged**. They had been free since 1 Nov 2024. Without a payment method, messages past the free tier aren't delivered.
  - Forty rates changed across 16 markets.
  - — [Meta pricing updates](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing), [Meta pricing .md](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md)
- **India-specific:**
  - The marketing rate **increased 1 Jan 2026**.
  - The authentication-international rate **increased 1 Apr 2026**.
  - **INR billing** launched 1 Jan 2026. Eligible accounts must migrate by **31 Dec 2026**, and from **1 Jan 2027** Meta stops delivering from non-INR accounts of eligible customers.
  - A Currency Migration API has existed since 1 Jun 2026.
  - — [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing), [updates](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing)
- **India INR amounts (third-party; Meta's rate-card files couldn't be fetched):**
  - Marketing went from **₹0.7846 to ₹0.8631** per message (excluding GST).
  - Utility is **₹0.115** and authentication **₹0.115**, unchanged in 2026.
  - — [MyOperator, updated 25 Sep 2026](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026); corroborated by the [Monty Mobile summary](https://montymobile.com/blogs/whatsapp-business-api-pricing-in-india-inr-rates-gst-and-the-2026-currency-migration-deadline) (page later 404'd; figures seen in search snippet)
  - Baat.ai (updated 7 Oct 2026) says India list rates did not change on 1 Oct 2026 and that marketing gets no volume discounts. — [Baat.ai](https://baat.ai/blog/whatsapp-api-pricing-india)

**Messaging limits & quality**
- Limits apply **per business portfolio**, shared across its numbers, and count unique recipients per rolling 24 h outside service windows: **250 → 2,000 → 10,000 → 100,000 → Unlimited**.
  - Reach 2,000 by business verification, or by sending 2,000 delivered messages outside service windows to unique users in 30 days with high-quality templates.
  - Above that, scaling is automatic when quality is high *and* at least half the current limit was used in the last 7 days. The step-up comes within 6 hours.
  - — [Meta messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits)
- **Template pausing:**
  - At "Active – Low quality" (RED), the first instance pauses the template for **3 h**, the second for **6 h**, and the third **disables** it.
  - Paused-template sends aren't charged and don't count against limits, but the API rejects them.
  - Templates paused by Pacing must be unpaused manually through `/unpause`.
  - — [Meta template pausing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing)
- **Pacing** has applied to marketing and utility templates since **30 Apr 2024**. — [Meta template guidelines](https://developers.secure.facebook.com/docs/whatsapp/message-templates/guidelines)
  - Delivery is held after an undisclosed threshold while feedback is evaluated, over roughly a 30-minute window. — [Infobip](https://www.infobip.com/docs/whatsapp/compliance/template-compliance), [Qontak](https://help-center.qontak.com/hc/en-us/articles/23381251489689) (BSP docs)

**Per-user marketing caps**
- WhatsApp may limit how many marketing templates a user receives **from all businesses**. The limit is based on the user's recent marketing read rate and inbox activity, and no numeric value is published.
- Each delivered marketing template counts. Marketing sent inside a 24-h window opened by a user reply doesn't count.
- Failures return **error 131049**. Wait **≥24 h** before retrying, because repeated retries can block delivery to that user for up to 24 h.
- Marketing templates aren't delivered to **US** numbers.
- — [Meta per-user limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits.md)
- A third-party claim of about 2 marketing messages per day per user across brands is unconfirmed. — [Chatarmin](https://chatarmin.com/blog/whatsapp-messaging-limits) (unverified)

**Opt-in & platform**
- Opt-in must state that the person is opting in to receive messages from the **named business**. It "can be general and not specifically for WhatsApp". It can be collected by SMS, web, IVR or paper, and must comply with applicable law.
- Low quality sustained over time can lead to rate limiting.
- — [Meta opt-in](https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in)
- The **On-Premises API was sunset 23 Oct 2025**, so Cloud API is the only option. Cloud API offers "up to 1,000 messages per second". — [Meta on-prem sunset](https://developers.facebook.com/docs/whatsapp/on-premises/sunset)
  - A Spanish guide lists 500 mps standard, scalable to 1,000. — [Cliengo](https://guiawabusiness.cliengo.com/cloud-vs-onprem) (unverified)

### Inferences
- **Cloud API direct vs BSP:**
  - Since everything runs on Cloud API, a BSP adds tooling, support, INR invoicing and template ops on top, plus a markup or subscription.
  - Going direct with Meta (as a Tech Provider) gives the lowest per-message cost and full webhook control, at the cost of building template management, quality monitoring and billing reconciliation in-house.
  - For a platform reselling to many SME tenants, the **Tech Provider / Solution Partner route with embedded signup** (each tenant has its own WABA and portfolio) isolates quality ratings and limits per tenant. A shared WABA would let one tenant's bad campaign throttle everyone.
- **Budget example (inference, excluding GST and BSP fees):**
  - 10,000 India marketing templates ≈ ₹8,631.
  - Utility follow-ups ≈ ₹1,150 per 10k.
  - Since 1 Oct 2026, high-volume support replies above 1,000 a month per number also cost money.
- **Engineering requirements:**
  - A consent ledger (source, timestamp, wording and proof per phone number per business).
  - Template registry with category, quality score and status, synced from `message_template_status_update` webhooks.
  - Send-side gating:
    - Portfolio unique-recipient budget.
    - Per-user 24-h retry back-off on 131049.
    - Auto-halt of campaigns when a template is paused.
    - Per-recipient marketing frequency cap set *below* Meta's (for example ≤1 marketing message per 7 days).
  - Pricing webhooks reconciled into the cost ledger.
- **Channel strategy:** use WhatsApp for (a) follow-up after an email reply or web form opt-in, (b) Click-to-WhatsApp ads (7-day free window), and (c) utility notifications to opted-in users. Avoid cold marketing templates to enriched numbers.

### Gaps
- The official INR rate-card values couldn't be fetched (Meta serves them as linked files). The ₹ figures come from two third-party BSP blogs that agree with each other.
- Whether India gained new authentication-international eligibility on 1 Oct 2026 is not stated.
- The official throughput defaults for Cloud API are not confirmed (500 vs 1,000 mps).
- The GST rate on Meta's fees was not checked.

---

## 9. Data model & storage (CRM model, event sourcing, warehouse, vector store, MongoDB fit, multi-touch attribution)

### Takeaway
Use MongoDB as the **operational store** for entities and the golden record, with documents and embedded provenance. Use an **append-only event log** (immutable `activity` and `signal` events) as the source of truth for lifecycle and attribution. Feed both via CDC into a columnar warehouse (ClickHouse, BigQuery or Redshift) for funnel analytics, cohorting, model training and attribution. Rule-based multi-touch attribution is being abandoned by major platforms in favour of counterfactual or data-driven methods. For a young B2B funnel, the honest approach is **randomized holdouts plus simple position-based reporting**.

### Cited Findings
- **Google Analytics** removed the first-click, linear, time-decay and position-based attribution models "as of November 2023". Its data-driven attribution uses converting **and** non-converting paths with a **counterfactual** approach, comparing exposed users against a similar holdback group, informed by RCT data, and assigns fractional credit. Conversions can be re-attributed for up to 7 days. — [GA4 help](https://support.google.com/analytics/answer/10596866)
- **MongoDB Vector Search:** up to 8,192 dimensions, HNSW, pre-filters on indexed fields, hybrid vector + full-text search, and `autoEmbed` (Voyage AI). Separate search nodes are recommended for workload isolation. — [MongoDB docs](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/)
- Splink can run against **PostgreSQL** and **DuckDB** as well as Spark, so ER batch jobs can run on a warehouse or analytic copy rather than the OLTP store. — [Splink docs](https://moj-analytical-services.github.io/splink/index.html)
- **DPDP Rules 2025** were notified **13 Nov 2025**:
  - Board-related rules took effect immediately.
  - **Consent-manager** provisions follow one year later (13 Nov 2026).
  - Most obligations, including notices, consent, data-principal rights, security safeguards and children's data, apply **18 months** after notification (13 May 2027).
  - Sources differ on Rule 4 timing.
  - — [S.S. Rana](https://ssrana.in/articles/meity-notifies-final-digital-personal-data-protection-rules-2025/), [Mondaq](https://www.mondaq.com/india/privacy-protection/1708830/dpdp-act-compliance-mandate), [PIB PDF](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)

### Inferences
- **Core entities** (MongoDB collections):
  - `organizations` (golden record, keyed by CIN/LLPIN, with `identifiers{cin, llpin, pan, gstins[], udyam}`, `attributes{value, source, confidence, observed_at}[]`, `former_names[]`).
  - `people` (DIN when a director, with `contact_points[]`, each having verification state and consent state per channel).
  - `source_records` (raw per-provider and per-crawl records, immutable, linked to `organizations` via ER cluster IDs). This lets you re-run ER without data loss.
  - `leads` (an org/person × SolutionAI offering × campaign context, with current stage and score snapshot).
  - `opportunities`.
  - `activities` (append-only: sent, delivered, opened, replied, bounced, call outcome, meeting, payment, each with channel, template or prompt version, and model versions).
  - `consents` (append-only ledger).
  - `suppressions`.
- **Event sourcing, lite:** make `activities` and `signals` immutable, idempotent by `(provider_message_id, event_type)`, and derive lead stage via projections. Full CQRS isn't needed, but this gives replayable funnels and attribution.
- **Warehouse choice:**
  - ClickHouse (self-managed or Cloud on AWS) suits high-volume append-only events and sub-second funnel queries.
  - BigQuery is simpler if you're willing to go cross-cloud.
  - Postgres plus DuckDB is enough below about 100M events.
  - Use MongoDB change streams or Atlas Stream Processing → S3/Kafka → warehouse.
- **MongoDB fit:**
  - Good for flexible enrichment payloads, golden records with nested provenance, and vector search co-located with entities.
  - Weak for heavy analytical joins and window functions over large activity volumes. Keep those in the warehouse.
- **Attribution:**
  - Record every touch with `campaign_id`, `channel`, `variant_id`, `agent_run_id` and `holdout_flag`.
  - Report first-touch, last-touch and position-based views for operations.
  - Make **incrementality via randomized holdouts** (per channel and per sequence) the decision metric, mirroring the counterfactual logic of data-driven attribution.
  - Markov or Shapley models become meaningful only with thousands of conversions.
- **DPDP implications for the data model:**
  - Purpose-tagged consent records.
  - Per-person erasure that cascades to `source_records` and caches.
  - Retention TTLs on enrichment data.
  - Design these now, since the main obligations land 13 May 2027.

### Gaps
- No public engineering write-ups from Apollo, ZoomInfo or HubSpot on their CRM and event-store internals were retrieved, because the search budget was exhausted.
- No primary source comparing ClickHouse vs BigQuery for this workload was fetched.
- Markov/Shapley attribution literature was not fetched.

---

## 10. Observability & evaluation for the whole funnel

### Takeaway
Instrument the funnel as **one trace per lead journey**, with OpenTelemetry spans for each pipeline stage and each LLM call (`gen_ai.*` semantic conventions). Send them to an LLM-observability backend such as Langfuse (OTLP-native) and to standard APM. Evaluate at three levels:
1. **Component**: extraction accuracy, ER precision/recall, enrichment validity, judge TPR/TNR.
2. **Channel health**: bounce, complaint and deferral rates, WhatsApp quality and 131049 rates, call outcomes.
3. **Business**: reply, meeting and conversion rates, plus incrementality against holdouts.

### Cited Findings
- OpenTelemetry's GenAI semantic conventions define spans for model and agent operations, metrics and events. They use a `gen_ai.*` namespace covering operation, provider, model, tokens, cost, finish reasons, tool calls and embeddings. — [RubinLake radar](https://rubinlake.com/en/technology-radar/developer-ai-and-delivery/opentelemetry-genai-observability), [FutureAGI glossary](https://futureagi.com/glossary/open-telemetry/) (secondary)
- Langfuse:
  - Ingests OTLP at `/api/public/otel`. OTel-instrumented libraries (OpenLLMetry, OpenLIT) appear in the same traces.
  - The GenAI conventions "are still evolving", so Langfuse maps attributes to its own model.
  - OTel support for agent frameworks (CrewAI, AutoGen, Pydantic AI and others) was added in Feb 2025.
  - — [Langfuse OTel docs](https://langfuse.com/docs/opentelemetry/get-started), [changelog 2025-02-14](https://langfuse.com/changelog/2025-02-14-opentelemetry-tracing.md)
- **Judge evaluation discipline:** binary criteria, TPR/TNR, about 100 labels per failure mode, re-run when models change. — [Hamel.dev](https://hamel.dev/blog/posts/llm-judge/)
- **Channel health signals with hard thresholds:**
  - Gmail spam rate below 0.1%, never 0.3%, with mitigation only after 7 days below 0.3%. — [Google FAQ](https://support.google.com/a/answer/14229414)
  - Yahoo below 0.3% and unsubscribes within 2 days. — [Yahoo](https://senders.yahooinc.com/best-practices/)
  - Microsoft 550 5.7.515 rejections. — [Microsoft](https://support.microsoft.com/en-gb/outlook/fix-ndr-error-550-5-7-515-in-outlook-com)
  - WhatsApp template pause events and 131049 failures. — [Meta pausing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing), [Meta per-user limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits.md)
- Splink ships threshold-selection and accuracy charts driven by labels, plus cluster-quality metrics, for ER evaluation. — [Splink docs](https://moj-analytical-services.github.io/splink/index.html)

### Inferences
- **Trace design:**
  - `trace_id` = lead-journey ID, propagated through Temporal/Inngest workflow metadata.
  - Spans: `ingest.mca_diff`, `crawl.fetch`, `extract.llm`, `er.match`, `enrich.waterfall[provider]`, `score.compute`, `agent.draft`, `judge.eval`, `approval.wait`, `send.email|whatsapp|voice`, `webhook.delivery|reply`.
  - Attach `gen_ai.usage.input_tokens/output_tokens`, a cost attribute, model and version, and prompt-template version.
- **Golden datasets, refreshed quarterly:**
  - 300–500 hand-labelled Indian company pairs for ER.
  - 200 pages with expected JSON for extraction.
  - 100+ labelled outbound drafts per failure mode for the judge.
  - 200 reply transcripts for reply-intent classification.
  - Run these as CI evals in the gateway on every model or prompt change.
- **Funnel SLOs and alerts:**
  - MCA-to-lead latency.
  - Enrichment hit rate and cost per validated contact.
  - Bounce rate per mailbox (>2% pauses it).
  - Complaint proxies.
  - WhatsApp quality drops to YELLOW/RED.
  - Approval-queue age.
  - Cost per positive reply.
  - Incremental reply-rate lift against the holdout.
- **Drift:** monitor score-distribution shift and calibration (expected calibration error, ECE) monthly. LLM provider updates are a top drift source, so pin model versions in the gateway.

### Gaps
- The OTel GenAI semconv registry page itself wasn't fetched, so attribute names should be confirmed against the current spec.
- No public funnel-level eval frameworks from AI SDR vendors were found.

---

## 11. Synthesis — reference architecture sketch & key engineering decisions (derived from §§1–10)

### Takeaway
A layered, event-driven design fits SolutionAI's stack:
- Node/TS services on AWS.
- MongoDB as the operational store, holding the golden record, with an immutable activity and consent ledger.
- A durable workflow engine for sequences and approvals.
- LangGraph/LLM-gateway agents for research, drafting and reply handling.
- A columnar warehouse for analytics and model training.
- OTel/Langfuse for end-to-end traces.

The architecture is not the hard part. The hard parts are Indian-specific **entity resolution**, **channel compliance as code** (Gmail/Yahoo/Microsoft, WhatsApp limits and opt-in, TRAI number series for voice, DPDP consent), and **measuring incrementality** with holdouts from day one.

### Cited Findings
- **Voice outreach constraints (India):**
  - TRAI designates the **140-series** for promotional calls and the **1600-series** for service/transactional calls (BFSI and government-to-citizen). — [TRAI PR No. 111 of 2026](https://www.trai.gov.in/sites/default/files/2026-08/PR_No111of2026.pdf)
  - The Feb 2025 TCCCPR amendment barred telemarketing from regular 10-digit numbers. Penalties escalate from a 15-day outgoing bar to 1-year disconnection and blacklisting. Explicit consent for a commercial transaction is valid for 7 days. — [Bar & Bench](https://www.barandbench.com/view-point/trais-crackdown-on-spam-calls-and-ai-driven-telemarketing), [FoneArena](https://www.fonearena.com/blog/446114/trai-tcccpr-2025-tougher-rules-spam-calls-sms.html)
  - A vendor page claims a TCCCPR Third Amendment (18 Sep 2026) treats AI voice calls as automated calls that must be declared to the operator. **Unverified** against TRAI. — [Ringg.ai](https://www.ringg.ai/voice-ai-compliance-india)
- Durable-engine and agent primitives are cited in §6 ([Temporal limits](https://docs.temporal.io/workflow-execution/limits), [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [Inngest throttling](https://www.inngest.com/docs/guides/throttling)). Channel rules are cited in §§7–8, and storage/vector in §9 ([MongoDB](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/)).

### Inferences

**Reference architecture (sketch)**
```
                ┌──────────────── Sources ───────────────────────────────────────────┐
                │ MCA lists/master data · data.gov.in · GST search · Udyam · company  │
                │ websites · news (GDELT/RSS) · jobs · search APIs (Exa/Tavily)       │
                │ first-party: web visits, forms, replies, CTWA ads                    │
                └───────────────┬─────────────────────────────────────────────────────┘
                                │ scheduled pulls / webhooks
 [1] INGEST  ── registry differ (CIN-keyed snapshots) ── crawler (robots cache, per-host
                token bucket, Firecrawl/Crawl4AI, Browserbase only if JS) ── raw store S3
                (url+content-hash) ── change detector → LLM extraction only on new/changed
                                │  events: org.discovered, page.changed, signal.*
                                ▼
 [2] EVENT BUS (EventBridge/Kinesis or Kafka) ── idempotent consumers
                                │
 [3] RESOLVE  ── deterministic keys (CIN/LLPIN, GSTIN→PAN, Udyam, domain)
                ── Splink (DuckDB/Spark batch; TF-adjusted names, blocking on state/pincode)
                ── LLM adjudicator for grey-zone pairs (gateway, structured output, logged)
                ── golden record in MongoDB `organizations` + immutable `source_records`
                                │
 [4] ENRICH   ── field-level waterfalls (cost/valid-hit ordering, validator, confidence,
                TTL cache incl. negative cache, per-tenant budgets) → contact points with
                verification + consent state
                                │
 [5] SIGNALS & SCORE ── feature store (point-in-time) ← signals (registry deltas, web,
                news, first-party) ── rules + LLM binary rubric (cold start) → calibrated
                GBM/LogReg → uplift once holdouts exist; random holdout + exploration
                                │ lead.qualified
 [6] ORCHESTRATE (Temporal TS / Trigger.dev / Inngest)
                per-lead sequence workflow:
                  research agent (LangGraph, MCP tools via policy layer)
                  → draft agent → LLM judge (aligned, binary criteria)
                  → HITL approval queue (signal/wait) → compliance gate (consent,
                    suppression, quiet hours, freq caps) → channel adapter
                  → wait for reply/timeout → reply classifier → next step / handoff
                                │
 [7] CHANNELS ── Email: outbound domain pool, mailbox-keyed throttles, RFC 8058, bounce/
                complaint auto-pause · WhatsApp Cloud API (per-tenant WABA, template
                registry, portfolio limit budget, 131049 back-off, pause auto-halt)
                · In-app/push notifications · AI voice (140/1600 series via licensed
                telco/CPaaS, DLT/consent checks)
                                │ delivery/reply/call webhooks → activities (append-only)
 [8] DATA     ── MongoDB (operational, vector search) ── CDC → warehouse (ClickHouse/
                BigQuery) ── attribution (touch logs + holdout incrementality)
 [9] DASHBOARD (React/TS) ── lead lifecycle, approval queue, channel health, cost/lead
 [10] OBSERVE ── OTel traces (gen_ai.*) → Langfuse + APM; golden-set CI evals; drift &
                calibration monitors; per-lead cost ledger
```

**Key engineering decisions SolutionAI will face**
1. **Durable engine:**
   - Temporal (TS SDK): most robust, with auditable replay, but determinism constraints, worker ops, and a 51,200-event history cap that needs Continue-As-New design.
   - Trigger.dev or Inngest: faster TS developer experience, checkpoint model, and per-key throttles. Check billing behaviour for long agent loops.
   - Decide before writing sequence logic, because migration later is costly.
2. **Build vs buy crawling:** Firecrawl (~$0.001/page, +4 credits for JSON) vs self-hosted Crawl4AI with your gateway's LLMs vs Browserbase for JS-heavy sites. A likely answer is a hybrid: plain HTTP first, a managed API for hard sites, and LLM extraction only on changed pages.
3. **ER stack and thresholds:**
   - Splink (DuckDB/Spark; check its licence) vs Zingg (AGPL v3, Spark) vs a custom solution.
   - Where the auto-merge vs LLM-adjudicate vs human-review bands sit.
   - Whether golden records are rebuilt in batch (simpler, reproducible) or merged incrementally (fresher, more complex).
4. **Enrichment provider mix and ordering:** which India-relevant sources go first, how BYO keys versus an aggregator affect margin, and the cache TTLs per field.
5. **Scoring maturity path:** when to move from rules plus LLM rubric to a calibrated ML model, how large the holdout and exploration budget are, and which outcome label to optimize.
6. **Autonomy level per channel:**
   - Approval is mandatory for first touch on new segments, voice and WhatsApp marketing.
   - Sampling-based approval applies once judge TPR/TNR is proven.
   - Fully autonomous only for utility or transactional follow-ups.
7. **Email sending model:**
   - Self-managed Workspace/M365 mailbox pools with your own rotation, or a sending platform (Instantly/Smartlead-style).
   - Domain-pool size versus target volume.
   - Strict adoption of the bulk-sender rules regardless of volume.
8. **WhatsApp tenancy:** a per-tenant WABA via embedded signup (isolated quality and limits) vs a shared WABA; direct Cloud API Tech Provider vs BSP; INR billing migration before 31 Dec 2026; budgeting for the 1 Oct 2026 service and utility charges.
9. **AI voice compliance:** 140/1600 numbering via licensed providers, consent capture, call-time windows, and disclosure policy. Monitor the reported Sep 2026 TCCCPR amendment on AI calls.
10. **Data platform:** MongoDB-only vs MongoDB plus warehouse (recommended), the CDC tooling, and event schema versioning.
11. **Consent and DPDP readiness:** purpose-bound consent ledger, erasure cascade, retention TTLs, and consent-manager integration (Rule 4 timeline). Build these into the schema now, ahead of 13 May 2027.
12. **LLM gateway policy:** model routing per task, version pinning, fallback across Gemini, OpenAI and Claude, per-lead budgets, and prompt and template versioning tied into traces and attribution.

### Gaps
- No public, engineering-grade reference architectures from AI SDR vendors (11x, Artisan, Unify, Clay) were retrievable in this pass, so the sketch above is synthesized from primitives, not copied from a known production system.
- The TRAI 2026 AI-voice amendment is unverified, and DLT/consent-template mechanics for voice weren't researched here.
- Cost totals per lead (end-to-end) couldn't be benchmarked from public data. They should be modelled from the unit prices above plus measured hit rates.
