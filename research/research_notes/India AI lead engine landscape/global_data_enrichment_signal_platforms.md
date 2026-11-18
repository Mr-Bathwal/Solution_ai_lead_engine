# Global B2B data, enrichment and signal/intent platforms (as of 24 Oct 2026)

Scope: the data, enrichment and signal layer only (Clay, Apollo.io, ZoomInfo, Cognism, Lusha, Seamless.AI, Common Room, Unify, Warmly, 6sense, Demandbase, plus HubSpot/Clearbit, People Data Labs, Explorium, Crustdata, Harmonic, Persana and Ocean.io in brief). Outreach and CRM layers are out of scope.

Research note: the shared web-search budget ran out partway through this task. Coverage of Clearbit/Breeze, Harmonic, Ocean.io, Persana, Explorium and Crustdata funding, primary Reddit/HN/X threads, and 6sense/Demandbase 2025–26 financials is therefore thinner than for the first-tier products. Later facts come from direct fetches of vendor pages. Many pricing and review figures come from competitor-run blogs and are flagged as such.

---

## Q1. How does each product build its data and keep it fresh? What is known about pipelines and entity resolution?

### Takeaway
There are three ways to build the data. Incumbents (ZoomInfo, Apollo, Lusha) own a database that they feed through **contributory networks** (scanning users' email signatures and contacts), web crawling, licensed partner files and human researchers. They verify it with engagement feedback such as bounces and replies. Orchestrators (Clay, Persana, ZoomInfo's GTM Studio) own little data. Instead they run **waterfalls** across 100–150+ vendors and use **LLM web-research agents** (Claygent) to fill long-tail fields. Signal platforms (6sense, Demandbase, Common Room, Warmly, Unify) focus on **identity resolution to one canonical account or person record**. They join first-party website, CRM and product data to third-party intent (most commonly Bombora). None of the vendors publishes a detailed entity-resolution algorithm. The only public signals are "canonical account record", "patented ID resolution", "Person360" and "preventing false linkages".

### Cited Findings

#### Clay (orchestrator / waterfall + AI agent)
- Clay uses spreadsheet-style tables in which each row is a company or person and each column holds data, a formula or an AI step. Data comes in by CSV, Google Sheets sync, API or pasted LinkedIn URLs. Clay draws on "150+ data vendors and AI providers". Users can bring their own provider keys (ZoomInfo, Clearbit, Apollo and others). Results sync to HubSpot/Salesforce, webhooks/Zapier or CSV — [Sacra](https://sacra.com/c/clay/)
- **How the waterfall works:** the user sets a priority sequence of providers. Clay queries the first; if it finds no match, Clay moves to the next and stops at the first hit. Practitioners put higher-quality providers first and cheaper ones as gap-fillers — [Vantaige explainer](https://vantaige.io/blog/how-clay-works-waterfall-enrichment-2026). Billing descriptions differ across third-party sources. Clay's own pricing page (Oct 2026) says: "If an enrichment returns no result, no credits or actions are charged." Multi-provider waterfalls are included on every plan, including Free — [Clay pricing](https://www.clay.com/pricing)
- **Claygent** is an AI agent that takes an instruction plus row inputs and returns structured output. It has web access for real-time research, such as analysing competitor homepages. Every decision comes with a reasoning trace ("Glass box, not black box"). "Account Agents" run across every account in a segment (beta). The page showed a live counter of **5,060,235,046 Claygent runs**. It names no underlying models beyond "advanced reasoning models" and Clay's own models — [Clay Claygent page](https://www.clay.com/claygent)
- The pricing page says token-heavy models (it names GPT-5.1 and Claude 4.6 Sonnet) are passed through at actual token cost, and about 80% of models cost a flat number of credits per task. Clay's own API keys run AI "twice as fast" as customer keys because of negotiated rate limits — [Clay pricing](https://www.clay.com/pricing)
- Strategy: the Sept 2026 Series D post says Clay unifies CRM data, product usage, campaign engagement, calls and emails, and adds external signals (funding, hiring, job changes) into "a live view of the total addressable market". Users can describe a goal in plain language and Clay turns it into an inspectable workflow. Clay calls this a "self-learning revenue engine" — [Clay blog, 9 Sep 2026](https://www.clay.com/blog/series-d)
- An internal Clay memo, as reported, describes the aim as commoditising the data layer to win the orchestration layer: "we'd rather expand access and bet on our customers succeeding" — [Metronome, 6 May 2026](https://metronome.com/blog/pricing-model-spotlight-why-clay-cut-data-prices-by-50-to-win-the-long-game)

#### Apollo.io (own database + contributory network)
- Apollo's help centre lists four sources:
  - a contributor network of **2M+ data contributors** who share business-contact data while using Apollo;
  - engagement tracking (email replies and bounces used to verify emails);
  - web crawlers that "regularly crawl the web at scale" to build a web-wide person/company index;
  - **200M+ records processed monthly** from vetted third-party providers.
  Apollo says it verifies new data against multiple sources before adding it — [Apollo Data Overview](https://knowledge.apollo.io/hc/en-us/articles/19331318468621); [Apollo contributor network](https://knowledge.apollo.io/hc/en-us/articles/20727684184589). These help-centre pages returned 403 to a direct fetch, so the facts come from search-result extracts. An older analyst report described "500K users" contributing via email signatures and CRMs — [Contrary Research](https://research.contrary.com/company/apollo.io)
- Database size, May 2025: **210M+ contacts and 35M+ companies** — [Apollo press release, 14 May 2025](https://www.prnewswire.com/news-releases/apolloios-ai-platform-is-rewriting-the-sales-playbook-with-500-percent-growth-in-12-months-302454754.html). Third-party listings cite 275M contacts and 65+ filters, but this is not company-stated — [Bardeen](https://www.bardeen.ai/answers/where-does-apollo-io-get-its-data)

#### ZoomInfo (largest incumbent; contributory network + researchers)
- Company-stated scale (page dated Oct 2026): **500M contacts, 100M companies**, 135M+ verified phones, 120M+ direct dials, 200M+ verified business emails, and 1.5B+ data points processed daily.
- Sources: public web and company sites, SEC/regulatory filings, job postings, a contributory network, "AI-assisted deduplication and gap-filling", and **300+ human researchers**. It also mentions an IP-to-company graph covering **6B+ IP addresses** — [ZoomInfo "What is ZoomInfo"](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
- The contributory network (ZoomInfo Lite, formerly Community Edition): users connect a business email, and ZoomInfo's ML extracts signature-block fields from contacts and emails. ZoomInfo's FAQ says the network verifies about **20M email signatures a month** and updates about **4M people and 1M companies daily** — [ZoomInfo FAQ](https://atlas.zoominfo.com/faqs/data/how-does-zoominfo-get-my-info) (search extract; a direct fetch failed); [ZoomInfo Lite](https://www.zoominfo.com/ce). The privacy policy says ZoomInfo extracts specified fields automatically, does not read email bodies, and collects metadata such as IP and send dates — [ZoomInfo privacy policy](https://www.zoominfo.com/privacy-policy). The original Community Edition was an Outlook plug-in that read address books and signature lines — [InformationWeek](https://www.informationweek.com/it-sectors/zoominfo-plug-in-siphons-contacts-from-outlook)
- **GTM Studio** is ZoomInfo's "data control plane" for list building and **waterfall enrichment, included at no extra cost**. Refreshing enriched records within the one-year retention window consumes no extra credits — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)

#### Lusha (contributory + partners + pattern completion)
- **Community Program:** members share "email headers and signature blocks" from business email, and affiliates supply contacts. When users grant compose access, Lusha gets data through Google/Microsoft APIs.
- **Other inputs:** licensed directories from partners (who use ML on public records and directories), a proprietary public-source scanner, and ML auto-completion. Email addresses, for example, are filled using corporate email patterns.
- **Refresh:** profiles update "each time a user runs a search" by cross-checking multiple sources. Lusha gives no fixed cadence.
- Lusha Systems Inc. is registered in the California Data Broker Registry — [Lusha data sources](https://www.lusha.com/data-sources/)

#### Cognism
- Cognism markets "Diamond Data®", phone-verified mobile numbers, launched in 2021. A July 2026 review says mobiles are verified by a human. No independently verified accuracy figure was found — [SalesRobot Cognism review](https://www.salesrobot.co/blogs/cognism-review)
- CRM-enrichment credits are re-used only when key details change, such as a job move. Viewing previously revealed contacts is free. Cognism pitches "European B2B data" — [Cognism pricing](https://www.cognism.com/pricing)

#### Seamless.AI (on-demand "real-time search engine")
- Seamless.AI positions itself as "a real-time search engine" rather than a static database. It says it searches the web in real time to find and verify contacts, claims **1.8B+ verified emails and 414M+ phone numbers**, and offers automatic credit-back for invalid emails — [Seamless.AI homepage](https://seamless.ai)

#### People Data Labs (raw data supplier to builders)
- **Sources:**
  - proprietary data licensed from suppliers in HR tech, real-estate tech, identity/anti-fraud and martech (some one-time files, some refreshed each build);
  - open datasets and government public records;
  - job postings **sourced exclusively from company career pages**.
- **Supplier checks:** suppliers are vetted for collection method, permissions, geography and privacy-request support. PDL says it takes "extensive measures to prevent false linkages", which means it treats over-merging as the key entity-resolution risk.
- **Change feed:** deltas between builds, including deletions and opt-outs, are exposed via a **Person Changelog API** — [PDL data sources docs](https://docs.peopledatalabs.com/docs/data-sources)
- Job posting data is "refreshed and delivered daily". Clay appears among PDL's customer logos — [PDL homepage](https://www.peopledatalabs.com)

#### HubSpot (Clearbit → Breeze Intelligence / native enrichment)
- HubSpot enrichment is "powered by HubSpot's commercial dataset, third-party providers, and publicly available information". Contacts are keyed on first name, last name and work email; companies are keyed on **domain**.
- Enriched values are scored against sources and reviewed by a human QA team. Existing values are not overwritten by default, and continuous auto-enrichment is off by default.
- "Data enrichment does not consume HubSpot Credits"; only smart properties do (page updated 10 Jul 2026) — [HubSpot KB](https://knowledge.hubspot.com/records/get-started-with-data-enrichment). The page no longer uses the Clearbit or Breeze Intelligence names.

#### Newer API-first and agent-first data suppliers
- **Crustdata** says it "indexes every web page on the internet" into one live graph. Its site cites **1B+ people** and 60M+ (elsewhere 200M+) companies. It sells Search/Enrichment, Jobs, Posts and **Watcher (webhook) APIs** plus an MCP server, and claims $10M ARR, up from $600k in 1.5 years (self-reported) — [Crustdata](https://crustdata.com)
- **Explorium** claims 146M+ business entities, 767M+ professional profiles, 4,000+ signals and 100+ sources, plus a Bombora partnership. Its "AgentSource" API and hosted MCP server are "built for AI agents" with clean IDs. Customers shown include Outreach, Artisan (AI SDR "Ava"), Lemlist and Salesforge — [Explorium](https://www.explorium.ai)
- **Harmonic** calls itself the "source of truth for startups", with 30M+ companies and 190M+ people. Its "Scout" agent runs stealth-founder triage, hiring tracking, funding sweeps and leadership-change watches. The API exposes headcount, engineering headcount change and web-traffic change. It mainly serves VCs. A testimonial from an unnamed Tier-1 VC says they "found 4 out of our last 9 deals on Harmonic" — [Harmonic](https://www.harmonic.ai)
- **Persana AI** is a Clay-style orchestrator with "100+ data sources", email and phone waterfalls, an AI research agent and autopilot agents. In October 2026 its pricing page carried a banner about "joining forces with Rox" — [Persana pricing](https://persana.ai/pricing). Its seed round was $2.3M (Oct 2024, YC) — [Sacra](https://sacra.com/c/clay/)

#### Signal/ABM platforms: identity resolution
- **Demandbase** describes a unified data platform that matches firmographic, intent, technographic, account-identification and first-party data to a **canonical account record** — [Diginomica, 5 Mar 2025](https://diginomica.com/how-demandbase-aims-redefine-gtm-connected-ai-powered-agents)
- **6sense** cites "patented ID resolution", website de-anonymisation, buying-group-level identity resolution and a "Company Graph" (a 13-year structural map of B2B) — [6sense](https://6sense.com)
- **Common Room** unifies "fragmented signals and partial identities into complete, person-level buyer intelligence" — [Zoom blog, Jul 2026](https://www.zoom.com/en/blog/zoom-to-acquire-common-room/). Its product is branded Person360™ — [Common Room pricing](https://www.commonroom.io/pricing/)
- **Warmly** identifies visitors by combining "first-party pixel data, IP intelligence, and identity graph matching" — [Warmly](https://warmly.ai/p/solutions/use-cases/website-visitor-identification). It cites 220M+ people profiles, 40M+ company profiles, "10M+ entities refreshed monthly" and an "Entity Resolution" product — [Warmly pricing](https://www.warmly.ai/p/pricing)

### Inferences
- The incumbents' durable moat is the **contributory email-signature network**: ZoomInfo's ~20M signatures/month, Apollo's 2M contributors and Lusha's Community. It refreshes job titles and phones at near-zero marginal cost. Crawling and licensed data are commoditised; Clay's 150+-vendor marketplace shows how easy they are to buy.
- **Engagement-outcome feedback** is the cheapest verification signal. Apollo uses bounces and replies; Seamless and Apollo refund credits for bounced emails. An engine that runs its own outreach (email, WhatsApp, voice) automatically produces this verification data.
- Keys are **domain-centric** (HubSpot companies keyed on domain; Clay rows on domain or LinkedIn URL), and discovery depends on a web and LinkedIn footprint. This structurally disadvantages very new companies without a domain or website.
- The industry stresses avoiding **false linkages** (PDL) and **canonical records** (Demandbase). Over-merging is treated as worse than under-merging: wrong identities poison outreach and create privacy exposure.

### Gaps
- No vendor publishes its entity-resolution algorithm (blocking keys, match thresholds, graph approach). No engineering-blog detail was found for Clay, Apollo or ZoomInfo pipelines; the search budget ran out before engineering blogs could be checked.
- PDL's current record counts and build cadence were not on the pages fetched.
- Ocean.io's site returned 403. Its lookalike-company data model was not verified.
- Seamless.AI's "real-time" method (live crawl versus cached DB plus verification) is marketing language only.

---

## Q2. What signals and intent data do they use, and how are they detected?

### Takeaway
Signals fall into three families, and every platform now sells some mix of them:
- **first-party** behaviour: website visits de-anonymised via IP graphs and pixels, product usage, CRM fields;
- **"public event"** signals: job changes, new hires, job postings, funding, leadership changes, news, tech-stack changes, social posts;
- **third-party research intent**: Bombora Company Surge co-op topics, or proprietary keyword intent at 6sense.

Bombora is the shared intent supplier behind Cognism, Common Room, Warmly and Explorium. 6sense and ZoomInfo claim proprietary intent graphs.

### Cited Findings
- **6sense:** "Signalverse" captures "one trillion signals every day" across intent, company and contact data, with "13 years" of proprietary intent data at **keyword level** rather than broad topics. It adds first-party CRM, MAP, web and product data plus third-party job changes and funding — [6sense](https://6sense.com). It launched AI Email (agentic outreach) in Aug 2025 — [Latka 6sense profile](https://getlatka.com/companies/6sense) (search extract)
- **ZoomInfo:** intent covers research activity, hiring trends, technology adoption, executive moves, **person-level website visits**, competitive research and intent spikes. Visitor tracking runs on a 6B+ IP-to-company graph. "Agent Teams" (Oct 2026, built on the **DoubleO.ai** acquisition) offers 50+ prebuilt agents that run GTM plays within approval limits — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
- **Common Room:** website activity (240k–960k/yr by tier), de-anonymisation (1k/mo on Essential, unlimited on Enterprise), Bombora Company Surge (6/12/25 topics), custom signals, job-change tracking, aggregated signals, social and community engagement, and product signals (add-on). RoomieAI "Capture" turns arbitrary signals into custom signals — [Common Room pricing](https://www.commonroom.io/pricing/); [Common Room vs Demandbase](https://www.commonroom.io/solutions/compete/demandbase)
- **Warmly** sorts its signals into three tiers:
  - 1st-party: web visits, in-app visits, CRM fields, lead scoring;
  - 2nd-party: social monitoring;
  - 3rd-party: Bombora research intent, competitor keyword monitoring, job changes, new-hire tracking, job postings, funding announcements, technographic and leadership changes.
  It claims 33M+ intent signals per year — [Warmly pricing](https://www.warmly.ai/p/pricing). The claim that it identifies "more than half" of visitors at person level is vendor-reported, via a competitor comparison — [Artisan](https://www.artisan.co/blog/rb2b-vs-warmly-which-should-you-choose-in-2026)
- **Unify:** "Unify Intent" (2025) combines multiple providers into **25+ buyer-intent indicators**. A trigger such as a pricing-page visit starts a "Play" in which agents research the account, find contacts, write messages and launch sequences — [Sacra Unify](https://sacra.com/c/unify/). Listed signal types include person-level website visitor ID, G2 review activity, funding, new hires and job postings — [Landbase (competitor)](https://www.landbase.com/blog/unify-pricing)
- **Clay:** job-change, company-news and social-listening signals start at the Launch plan. **Web-intent signals** and "webhook automation for any signal" start at Growth — [Clay pricing](https://www.clay.com/pricing)
- **Cognism:** intent is Bombora Company Surge on the Pro plan only; admins pick up to 12 topics from 11,000+ — [Cognism pricing](https://www.cognism.com/pricing)
- **Apollo:** search summaries say intent data is unlocked from the Professional plan — [Apollo pricing summary, 11x](https://www.11x.ai/guides/apollo-io-pricing) (third-party, unverified)
- **Seamless.AI** markets Buyer Intent, Job Changes, and Inbound/Outbound Agents that turn signals into campaigns — [Seamless.AI](https://seamless.ai)
- **Demandbase:** Agentbase (Mar 2025) offers connected agents on AWS trained on GTM data. The released Campaign Outcomes Agent optimises DSP bidding; the vendor claims 40% higher CTR — [Diginomica](https://diginomica.com/how-demandbase-aims-redefine-gtm-connected-ai-powered-agents)
- **Harmonic** focuses on startup "momentum" signals: hiring, fundraising, product launches, leadership changes, stealth founders, and headcount and web-traffic deltas — [Harmonic](https://www.harmonic.ai)
- **Crustdata** offers a Watcher API that pushes webhooks on company events (hiring, funding, leadership changes) — [Crustdata](https://crustdata.com)
- **Explorium** offers "business event signals" and lets agents create custom signals — [Explorium](https://www.explorium.ai)

### Inferences
- Detection mechanics fall into two groups:
  - **Diff-based:** snapshot a profile, job posting set or headcount on a schedule and emit an event on change. This covers job changes, hiring and headcount.
  - **Stream/IP-based:** pixels plus IP-to-company or identity-graph lookups produce website intent; Bombora's publisher co-op produces research intent.
  Both depend on a large, dense footprint (LinkedIn, corporate websites, B2B publisher traffic) that is US- and EU-centric.
- For an India engine, the highest-value "birth" signals (new incorporation, GST registration, startup recognition, MSME registration) are not in any of these vendors' signal catalogues. A new entrant would have to build them from Indian registries. This inference is based on the absence of India or registry signals on every vendor page reviewed above.

### Gaps
- None of the vendors documents its signal-detection latency (for example, how many days after a job change the signal fires).
- Bombora's co-op coverage of Indian publishers and of Indian company IP ranges was not researched.

---

## Q3. Pricing models and price points; funding, valuation and ARR (dated)

### Takeaway
Pricing has split into three models:
1. **Usage/credit SaaS with low entry prices**: Clay $185/mo, Apollo $49–119/user/mo, Lusha $49.90–399.90/mo, PDL $98/mo, Explorium credit packs.
2. **Annual enterprise contracts**: ZoomInfo median of about $31–34k/yr; Common Room $30k/yr+; Warmly $10–30k/yr; Unify about $8–21k/yr.
3. A shift toward **consumption credits plus agents**: ZoomInfo "free to start", Clay's 2026 Data Credits plus Actions.

On growth, Clay ($7.1B, ~$200M run-rate) and Apollo (~$200M+ ARR) are the momentum leaders. ZoomInfo is large (~$1.2B revenue) but flat, with 89% NRR. 2025–26 brought consolidation: Zoom bought Common Room, ZoomInfo bought DoubleO.ai, and Persana joined Rox.

### Cited Findings

#### Clay
- **Valuation and funding:**
  - Series D: **$115M at $7.1B** (9 Sep 2026), led by Wellington, with Sequoia, StepStone, a16z Perennial, Meritech, DST, CapitalG and others.
  - Customers: 17k+, including 80% of the Forbes AI50 (Anthropic, Google, OpenAI, Stripe and others).
  - Revenue grew 4x in 2025 — [Clay blog](https://www.clay.com/blog/series-d); [The Next Web](https://thenextweb.com/news/clay-raises-115m-series-d-7-1bn-valuation-wellington)
- **Earlier marks:**
  - Seed $2.5M (2021, First Round)
  - Series A $13.5M (2023, Sequoia)
  - Series B $46M at $500M (Jun 2024, Meritech)
  - $40M pre-emptive at $1.25B
  - Tender at $1.5B (May 2025)
  - **Series C $100M at $3.1B** (Aug 2025, CapitalG)
  - Employee tender $55M at **$5B** (Jan 2026, DST) — [Sacra](https://sacra.com/c/clay/)
- **Revenue:**
  - 2024 revenue about $30M — [Sacra](https://sacra.com/c/clay/)
  - Company-reported **~$100M ARR** at end-2025 — [ARR Club](https://www.arr.club/clay) (aggregator)
  - Sacra estimate of about $150M (May 2026) and **$200M ARR (Sep 2026)** — [Sacra](https://sacra.com/c/clay/)
  - A summary of NYT reporting says annualised revenue was "on course for about $200M" per CEO Kareem Amin — [Autobound summary](https://www.autobound.ai/companies/clay/news/clay-raises-115m-at-a-7-1b-valuation-78496d06). This is company-stated and unaudited.
- **Pricing (Oct 2026):**

  | Plan | Monthly | Annual billing (per month) | Actions/mo | Data credits/mo |
  |---|---|---|---|---|
  | Free | $0 | $0 | 500 | 100 |
  | Launch | $185 | $167 | 15K | 2.5K |
  | Growth | $495 | $446 | 40K | 6K |
  | Enterprise | Custom | Custom | Custom | Custom |

  - All plans have unlimited seats.
  - Data credits start at about $0.05 and get cheaper with volume.
  - Actions start below $0.01 each.
  - Top-ups carry a 30% premium — [Clay pricing](https://www.clay.com/pricing)
- **The March 2026 repricing:**
  - Starter ($149) and Explorer ($349) were replaced by Launch and Growth. The effective date is reported as 11 Mar 2026 — [Bitscale (competitor)](https://bitscale.ai/blogs/clay-pricing-changes-15k-action-limits-higher-costs-and-agency-risk)
  - Marketplace data costs were cut by 50–90%.
  - CRM sync, HTTP API and webhooks moved down from the $800 Pro tier to Growth.
  - BYOK *data-provider* calls now consume Actions; BYOK *AI-model* keys do not.
  - Clay projected that about 90% of customers never hit the Action ceiling — [Metronome](https://metronome.com/blog/pricing-model-spotlight-why-clay-cut-data-prices-by-50-to-win-the-long-game)
- **Margins:** gross margins have historically been closer to data-heavy SaaS than 80%+ software margins, because COGS include pass-through data licensing and model usage — [Sacra](https://sacra.com/c/clay/)

#### Apollo.io
- **Funding:** last priced round was a **$100M Series D at $1.6B** (2023, Bain Capital Ventures).
- **Traction:** ARR "over **$145M**" (14 May 2025), 500k+ companies, 50k+ weekly active users of its AI features, and AI usage up 500% YoY — [Apollo press release](https://www.prnewswire.com/news-releases/apolloios-ai-platform-is-rewriting-the-sales-playbook-with-500-percent-growth-in-12-months-302454754.html)
- **2026 reporting:** Axios (3 Feb 2026) reported a **CEO change** and said the company was "nearing $200 million" ARR and considering acquisitions — [Axios Pro](https://www.axios.com/pro/enterprise-software-deals/2026/02/03/sales-engagement-apollo-io-ceo-change) (paywalled; search extract). Sacra estimates $194M at end-2025 and **$265M in Sep 2026**, but its page is internally inconsistent — [Sacra Apollo](https://sacra.com/c/apollo/)
- **Pricing (2026, per user per month):**

  | Plan | Annual | Monthly |
  |---|---|---|
  | Free | $0 | $0 |
  | Basic | $49 | $59 |
  | Professional | $79 | $99 |
  | Organization | $119 (3-seat minimum) | $149 |

  - Overage is $0.20 per credit (250-credit minimum).
  - A mobile number costs 8 credits.
  - Credits expire each cycle.
  - Heavy teams are said to spend $150–400/user/mo after overages — [MailReach (competitor), Jul 2026](https://www.mailreach.co/blog/apollo-io-review)
  - Free-plan credits were reportedly cut from 100 to 75/mo in early 2026 — [Valley](https://www.joinvalley.co/blog/apollo-pricing-and-credits-explained-2026) (third-party)

#### ZoomInfo (Nasdaq: GTM)
- **Rebrand:** the ticker changed from ZI to **GTM** on 13 May 2025, alongside the GTM Studio launch — [ZoomInfo IR](https://ir.zoominfo.com/news-releases/news-release-details/zoominfo-cements-go-market-leadership-new-nasdaq-trading-symbol/)
- **Product evolution:** Copilot, which a ZoomInfo exec claimed reached $100M ACV within six months — [GTMnow podcast](https://gtmnow.com/gtm-159-scaling-zoominfo-1b-arr-copilot-launch-upmarket-strategy/), was folded into **GTM Workspace** (Oct 2025). Agent Teams followed in Oct 2026 — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
- **Q2 2026 results:**
  - Revenue **$310.4M (+1.2% YoY)**, adjusted operating margin 35%
  - **NRR 89%**
  - 1,891 customers at $100k+ ACV
  - Upmarket is 76% of ACV and grew 3%; **downmarket ACV fell 12%** as the segment moves to product-led sales
  - **$650.5M goodwill impairment** — [ZoomInfo Q2 2026 release](https://www.businesswire.com/news/home/20260805496533/en/) (search extract; direct fetch was blocked)
  - Management cut FY2026 revenue guidance in May 2026 — [Simply Wall St](https://simplywall.st/stocks/us/media/nasdaq-gtm/zoominfo-technologies)
- **Pricing:**
  - ZoomInfo now markets "free to start, consumption-based credits" plus the free **ZoomInfo Lite** — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
  - Third-party trackers put entry contracts at about $14,995/yr and the median at about $31,875/yr (Vendr, 1,300+ deals) to $33,500/yr — [Gojiberry](https://blog.gojiberry.ai/blog/zoominfo-pricing); [Bitscale](https://bitscale.ai/blogs/zoominfo-pricing-plans-hidden-fees-cheaper-alternatives-2026) (competitor blogs)

#### Cognism
- **Funding:** the last confirmed large round is **$87.5M led by Viking Global (2022)**, following 100% ARR growth in FY2021. This comes from a search extract of Cognism's release; an earlier round was a $10M Series B (2019) — [Cognism news](https://cognism.com/news/cognism-raises-10m-in-series-b-funding). 2025–26 ARR claims of $86–112M appear only on low-quality template sites and conflict with each other — [Multiples.vc](https://multiples.vc/private-comps/cognism)
- **Pricing:** quote-only. Standard and Pro packages include 5 seats, one credit per revealed contact, free re-views and add-on CRM enrichment. Intent is Pro-only. Cognism cites 4,000+ customers — [Cognism pricing](https://www.cognism.com/pricing)

#### Lusha
- **Funding:** **$205M Series B at $1.5B** (Nov 2021, PSG) — [Crunchbase News](https://news.crunchbase.com/briefing/briefing-11-10-21). It cut about 10% of staff in 2022 — [Calcalist](https://www.calcalistech.com/ctechnews/article/rjqkrgx3q)
- **ARR:** one 2026 blog estimates about $64M — [ValueAdd VC](https://valueaddvc.com/blog/apollo-vs-lusha-which-sales-intelligence-tool-actually-wins-in-2026) (low-quality estimate)
- **Pricing (page modified 11 Oct 2026):**

  | Plan | Monthly | Annual billing (per month) | Credits/mo |
  |---|---|---|---|
  | Free | $0 | n/a | 40 |
  | Starter | $49.90 | $37.45 | 400 |
  | Pro | $69.90 | $52.45 | 600 |
  | Premium | $399.90 | $299.95 | 3,400 |
  | Scale | Custom | Custom | Custom |

  - An email reveal costs 1 credit; a phone reveal costs 5.
  - One credit pool covers the web app, extension, API and **MCP**.
  - Lusha says 280k+ revenue teams use it — [Lusha pricing](https://www.lusha.com/pricing/); [Lusha data sources](https://www.lusha.com/data-sources/)

#### Seamless.AI
- **Pricing:** a free tier of 50 credits; paid prices are not published — [Seamless.AI](https://seamless.ai). Third-party estimates put Basic at about $147/mo and Pro at about $79–299/user/mo — [MarketBetter](https://marketbetter.ai/blog/seamless-ai-pricing-breakdown-2026/) (competitor)
- **Funding/ARR:** no reliable figures were found.

#### Common Room
- **Pricing:** Essential is **$2,500/mo billed annually**: 5 seats, 100k contacts, 5k RoomieAI research credits and 2.5k Prospector credits. Advanced and Enterprise are custom — [Common Room pricing](https://www.commonroom.io/pricing/). The median actual contract is reported at about $30,750/yr across 67 transactions — [Salesmotion](https://salesmotion.io/blog/common-room-pricing) (third-party)
- **Acquisition:** Common Room raised about $52M — [Let's Data Science](https://letsdatascience.com/news/zoom-acquires-common-room-to-add-buyer-intelligence-60a0a32e). **Zoom announced its acquisition on 2 Jul 2026 and closed it in July 2026**, to feed Zoom Revenue Accelerator. Terms were undisclosed — [Zoom blog](https://www.zoom.com/en/blog/zoom-to-acquire-common-room/)

#### Unify
- **Funding:**
  - Seed $6.6M (Jan 2024)
  - Series A $12M (Oct 2024)
  - **Series B $40M (Jul 2025, Battery Ventures) at about $260M valuation** (Sacra estimate); the OpenAI Startup Fund participated — [Sacra Unify](https://sacra.com/c/unify/); [BusinessWire](https://businesswire.com/news/home/20250714813159/en/Unify-Raises-$40-Million-Series-B-to-Transform-Go-To-Market-with-AI)
- **Traction:** about **$5.6M annualised revenue (Jun 2025)** across 200+ customers (Cursor, Perplexity and others) — [Sacra](https://sacra.com/c/unify/)
- **Pricing:** about $700/mo entry (Sacra), versus "$1,740/mo Growth, annual" — [Landbase (competitor)](https://www.landbase.com/blog/unify-pricing). The sources conflict.

#### Warmly
- **Pricing:**

  | Plan | Annual | Quarterly |
  |---|---|---|
  | AI Web-Deanonymization | **$10,000/yr** | $4,875 |
  | Inbound Chat | $20,000/yr | $6,500 |
  | AI Inbound Autopilot | $30,000/yr | $9,750 |

  - The GTM Signals add-on (intent, hiring, funding, competitive intel) costs $10k/yr.
  - Each plan lists "from 10K credits/mo" — [Warmly pricing](https://www.warmly.ai/p/pricing)
- **Funding:** not found (search budget exhausted).

#### 6sense
- **Revenue:** company-stated **>$200M ARR** for the fiscal year ending 31 Jan 2024, with 40% growth — [BusinessWire](https://www.businesswire.com/news/home/20240327571865/en/6sense-Surpasses-200M-ARR-Driven-by-Sales-Intelligence-Innovation-and-Market-Share-Expansion). No 2025–26 ARR was found.
- **Leadership:** the CEO is listed as **Chris Ball** (Oct 2025), succeeding Jason Zintak — [Latka](https://getlatka.com/companies/6sense) (search extract)
- **Pricing:** enterprise quote; sales intelligence advertises "Get started for free" — [6sense](https://6sense.com)

#### Demandbase
- **Funding:** an aggregator reports a $150M Series F, but its date and valuation could not be verified — [Salestools](https://salestools.io/es/report/demandbase-150m-series-f). The 2021 acquisitions of InsideView (contact data) and DemandMatrix (technographics) come from a search extract — [Demand Gen Report](https://www.demandgenreport.com/?p=3339)
- **ARR:** no 2025–26 ARR was found.

#### Others
- **People Data Labs:** Free plan with 100 credits; **Pro from $98/mo for 350 credits** (about $0.28 per credit, computed); Enterprise custom; 20% off for annual — [PDL pricing](https://www.peopledatalabs.com/pricing)
- **Explorium credit packs:**

  | Pack | Price | Credits |
  |---|---|---|
  | Lite | $29.99 | 500 |
  | Starter | $99.99 | 2,500 |
  | Growth | $749.99 | 25k |
  | Scale | $7,499.99 | 500k |

  Credits are valid for 12 months — [Explorium](https://www.explorium.ai)

### Inferences
- ZoomInfo is in decline:
  - revenue growth of +1.2%, NRR of 89% and downmarket ACV down 12%;
  - repeated rebrands (ZI→GTM, Copilot→Workspace→Agent Teams) and a move to "free to start" credits.
  
  Clay is gaining fast (4x revenue growth in 2025, $7.1B). Together these show value moving from **owning a static database** to **orchestration plus agents on top of commoditised data**.
- Clay's March 2026 repricing (data 50–90% cheaper, platform "Actions" metered) is an explicit bet that data margins shrink while workflow margins hold. Our engine should expect raw contact data to be a low-margin input.
- Enterprise signal tools (Common Room, Warmly, Unify, 6sense) cost at least $10–30k per year, far above Indian MSME budgets. An India-priced signal product is an open gap.

### Gaps
- Funding data was not found for Warmly, Seamless.AI, Harmonic, Crustdata, Explorium (latest), Ocean.io or PDL (latest). Recent valuations were not found for 6sense or Demandbase. The search budget ran out.
- Apollo's new CEO's identity was not confirmed (Axios is paywalled).
- Cognism's current ARR is unknown; only unreliable estimates exist.
- Primary sources for the Lusha and Seamless revenue figures were not found.

---

## Q4. What do users praise and complain about?

### Takeaway
The complaints repeat across vendors:
- **Bounce rates and stale titles** (Apollo, Seamless), especially outside North America;
- **Unpredictable credit economics** (Apollo credit rationing, Clay's Actions-plus-Credits double meter);
- **Contract and renewal traps** (Seamless auto-renew with 60–90-day notice; ZoomInfo annual contracts).

Praise centres on all-in-one convenience and price (Apollo), and on flexibility and coverage through waterfalls (Clay). Primary Reddit, HN and X threads could not be retrieved because the search budget ran out. Most sentiment below comes via review aggregators and competitor blogs.

### Cited Findings
- **Apollo, praise:** G2 rating is **4.7/5 across 9,500+ reviews**. Users praise the all-in-one stack (database, sequencer, dialer, deals), 65+ filters, value for US SMBs, and HubSpot/Salesforce sync — [MailReach](https://www.mailreach.co/blog/apollo-io-review)
- **Apollo, complaints:**
  - "Bounce rates of 15–25% on large exported lists are a recurring complaint on r/coldemail and G2"
  - Outdated titles and "left company" replies
  - Stale direct dials
  - SDRs "rationing credits mid-month"
  - Trustpilot ratings far below G2's, driven by billing and support complaints — [MailReach (competitor), Jul 2026](https://www.mailreach.co/blog/apollo-io-review)
  
  Other reviews put Trustpilot at about 2.9–3.1/5 and real-world bounces at 15–35% — [Salesgear](https://www.salesgear.io/blog/apollo-io-review/); [Cleverly, Apr 2026](https://cleverly.co/blog/apollo-io-review). Apollo refunds credits for emails that bounce within 30 days, but not for phone numbers — same sources. A Reddit user quoted on a ZoomInfo competitor page said Apollo-"verified" emails keep bouncing — [ZoomInfo pipeline (competitor)](https://pipeline.zoominfo.com/sales/apollo-io-review)
- **Clay, complaints:** critics say BYOK workflows lost their savings when every step became metered. The same workflow is "charged twice" (Actions plus Data Credits), and costs became variable, which hurts agencies — [Bitscale (competitor)](https://bitscale.ai/blogs/clay-pricing-changes-15k-action-limits-higher-costs-and-agency-risk); [Databar](https://databar.ai/blog/article/clay-pricing-2026)
- **Clay, praise and counterpoint:** users who buy heavily from the marketplace pay less after the change — [Valley](https://www.joinvalley.co/blog/clay-pricing-and-credits-explained-2026). Clay's Series D post cites adoption by 80% of the Forbes AI50 — [Clay blog](https://www.clay.com/blog/series-d)
- **Seamless.AI:**
  - Trustpilot reviews from May–Jul 2026 describe a required **60-day written notice**, auto-renewal and collections pressure. Trustpilot is reportedly about 1.4/5 — [Trustpilot](https://www.trustpilot.com/review/seamless.ai?page=1); [Emelia](https://emelia.io/hub/seamless-ai-preise)
  - G2 is about 4.4/5 across 5,000+ reviews, but one analysis counts "inaccurate data" in 410 reviews and "outdated contacts" in 295.
  - The widely repeated "20–30% bounce" figure traces to a single G2 review — [Salesgear (competitor)](https://www.salesgear.io/blog/seamless-ai-competitors/)
- **ZoomInfo:** cost is the main barrier, with a median contract of about $31–34k/yr and negotiated, unpublished credit overages — [Gojiberry](https://blog.gojiberry.ai/blog/zoominfo-pricing). Privacy lawsuits are covered under Q6.
- **Warmly:** G2 reviewers reportedly praise identification accuracy for mid-market and enterprise companies. The free tier is company-level only — [SyncGTM review](https://syncgtm.com/blog/warmly-review) (third-party)
- **Unify:** about 1+ week of onboarding before signals start firing — [Factors.ai blog (competitor)](https://www.factors.ai/blog?b727cd09_page=10)

### Inferences
- Vendors advertise about 95–98% accuracy, but practitioners report 15–35% bounces. This gap is the core trust problem in this category. An engine that **verifies at send time** and shows confidence and freshness per field would differentiate.
- Credit opacity and renewal traps cause disproportionate churn and Trustpilot damage. Transparent, pay-on-success pricing is a cheap differentiator, and Clay and Apollo already partially adopt it ("no charge on no result"; bounce refunds).

### Gaps
- Primary Reddit (r/sales, r/coldemail, r/SaaS, r/startups), Hacker News, X, LinkedIn, YouTube and Product Hunt threads were **not retrieved** because the search budget ran out. Sentiment above is second-hand, and competitor blogs dominate.
- No sentiment data was gathered for Lusha, Cognism, Common Room, 6sense or Demandbase.
- No independent, reproducible accuracy benchmark across vendors was found.

---

## Q5. How well do these products cover India, especially newly registered Indian companies?

### Takeaway
None of the vendor pages reviewed mentions India coverage. Several signal Western focus explicitly: Cognism sells "European B2B data", Unify's roadmap lists "expanded EMEA/APAC coverage", and Apollo's accuracy reportedly drops to 60–73% outside North America. Their discovery mechanics (LinkedIn/web crawl, email-signature networks, Bombora publisher co-op, IP-to-company graphs, career-page job feeds) all need a company to have a **digital footprint**. A newly incorporated Indian private limited company or LLP typically lacks one for weeks or months. Fresh Indian incorporations are therefore effectively invisible to these global tools at birth. Finding them requires Indian registry data, which no global vendor advertises.

### Cited Findings
- Apollo data accuracy is said to average **88% in the US and 60–73% internationally**. The source gives no India-specific figure — [MailReach (competitor), Jul 2026](https://www.mailreach.co/blog/apollo-io-review)
- Cognism pitches "European B2B data" and lists no APAC or India coverage on its pricing page — [Cognism pricing](https://www.cognism.com/pricing)
- Unify's roadmap includes "expanded EMEA/APAC coverage", which implies current coverage is US-centric — [Sacra Unify](https://sacra.com/c/unify/)
- PDL, Crustdata, Harmonic and Explorium pages mention no India coverage or country breakdown — [PDL](https://www.peopledatalabs.com); [Crustdata](https://crustdata.com); [Harmonic](https://www.harmonic.ai); [Explorium](https://www.explorium.ai)
- HubSpot enrichment keys companies on **domain**, and contacts on name plus *work email* — [HubSpot KB](https://knowledge.hubspot.com/records/get-started-with-data-enrichment)
- PDL's job postings come only from company career pages — [PDL docs](https://docs.peopledatalabs.com/docs/data-sources)
- ZoomInfo's sources are public web, SEC/regulatory filings, job postings, its contributory network and researchers. Its regulatory sources are US-centric (SEC), and it does not mention Indian registries — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
- Clay's free tier excludes phone enrichment, and its 150+ providers are chosen per task. Clay mentions no India-specific providers — [Clay pricing](https://www.clay.com/pricing)

### Inferences
- **Newly registered Indian companies:** every global platform here is keyed on a domain, a LinkedIn URL or a work email. A company incorporated last week usually has none of these, only an incorporation ID, a registered address and director names. So:
  - (a) global vendors cannot discover it;
  - (b) they cannot enrich it until a domain exists;
  - (c) their "new company" or "funding" signals will lag by months for bootstrapped MSMEs that never raise or post jobs.
  
  This is an inference from the vendors' stated keys and sources; no vendor states it.
- Contributory-network density follows the vendor's user base. ZoomInfo, Apollo and Lusha users are mostly US and EU sellers, so Indian SMB director phones and emails are probably sparse. WhatsApp-first Indian SMBs leave few email-signature traces.
- IP-based de-anonymisation (Warmly, 6sense, ZoomInfo WebSights-style graphs) works poorly where small businesses share ISP or mobile IPs, which is typical in India. This is an inference; no source was found on Indian IP-graph accuracy.
- These platforms are still useful **after** a company gets a domain or LinkedIn page, for decision-maker emails, tech stack and hiring. The right design is to use them as downstream enrichment providers in a waterfall, not as the discovery layer.

### Gaps
- No vendor-published India coverage statistics (record counts, accuracy, phone coverage) were found for any product.
- India-focused data vendors (registry-based providers, startup databases) are out of scope here and presumably covered by another researcher.
- No measured study of global-vendor bounce rates on Indian domains was found.

---

## Q6. What architecture lessons transfer to our engine? (Including privacy and legal lessons)

### Takeaway
The best-in-class pattern for 2026 has six parts:
1. a **provider-agnostic waterfall orchestrator**, charged only on hits, with BYOK;
2. an **AI research agent with reasoning traces** for long-tail fields;
3. a **canonical, provenance-tracked golden record** that guards against false merges;
4. a **change-feed/event store** that turns diffs into signals;
5. **closed-loop verification** from engagement outcomes;
6. **agent-native access** through APIs and MCP.

Legal history (the ZoomInfo publicity suits, LinkedIn suing scrapers) argues against scraping LinkedIn and against using people's names in marketing previews.

### Cited Findings
- **Waterfall economics:** Clay charges nothing for empty results, includes waterfalls on all tiers, passes LLM token costs through without markup, and separates data costs (Data Credits) from compute costs (Actions) — [Clay pricing](https://www.clay.com/pricing). ZoomInfo includes waterfall enrichment free in GTM Studio and does not re-charge refreshes within a year — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
- **Agents with traceability:** Claygent returns structured output with a reasoning trace for every decision and has passed about 5B runs — [Clay Claygent](https://www.clay.com/claygent)
- **Golden record:** Demandbase maps all data types to a "canonical account record". Its CEO argues agents must share one data foundation to avoid conflicting outreach — [Diginomica](https://diginomica.com/how-demandbase-aims-redefine-gtm-connected-ai-powered-agents). PDL emphasises preventing false linkages and vets every source's provenance and permissions — [PDL docs](https://docs.peopledatalabs.com/docs/data-sources)
- **Change feeds:** PDL exposes a Person Changelog API that includes deletions and opt-outs — [PDL docs](https://docs.peopledatalabs.com/docs/data-sources). Crustdata exposes a Watcher API (webhooks on company events) — [Crustdata](https://crustdata.com). Cognism re-uses enrichment credits only when key fields change — [Cognism pricing](https://www.cognism.com/pricing)
- **Closed-loop verification:** Apollo uses email replies and bounces from its own sequences to validate emails — [Apollo Data Overview](https://knowledge.apollo.io/hc/en-us/articles/19331318468621). Seamless and Apollo refund credits for invalid or bounced emails — [Seamless.AI](https://seamless.ai); [MailReach](https://www.mailreach.co/blog/apollo-io-review)
- **Human QA plus scoring:** HubSpot scores enriched values against sources and uses a human QA team. It never overwrites existing values by default — [HubSpot KB](https://knowledge.hubspot.com/records/get-started-with-data-enrichment). ZoomInfo pairs ML with 300+ researchers — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
- **Agent-native distribution:** MCP servers or MCP access are offered by Crustdata, Explorium, Harmonic, 6sense, Common Room and Lusha — [Crustdata](https://crustdata.com); [Explorium](https://www.explorium.ai); [Harmonic](https://www.harmonic.ai); [6sense](https://6sense.com); [Common Room pricing](https://www.commonroom.io/pricing/); [Lusha pricing](https://www.lusha.com/pricing/)
- **Privacy and legal (ZoomInfo):**
  - Its subsidiary Datanyze was sued for using residents' names in free-trial previews under right-of-publicity laws: Illinois (Feb 2023), Ohio (Mar 2023; dismissed, affirmed by the 6th Circuit Jan 2025) and California (Oct 2024).
  - Datanyze settled the remaining classes for an "immaterial amount", with final approval on 23 Jul 2025.
  - Further suits include a Washington Personality Rights Act case (Sep 2024) and a Quebec privacy class action (17 Mar 2025) — [ZoomInfo 10-Q, Q2 2025](https://www.sec.gov/Archives/edgar/data/1794515/000179451525000167/zi-20250630.htm); [Settlement notice](https://docs.simpluris.com/websites/26b52c57-f72d-42c3-8027-b7a7f00950cc/documents/db00104a-1411-4efd-be3f-8de8223c136a/Notice%20of%20Class%20Action%20Settlement.pdf)
- **Scraping risk (LinkedIn):**
  - LinkedIn sued Proxycurl (Jan 2025) over fake accounts scraping millions of profiles; **Proxycurl shut down in July 2025** rather than fight the suit.
  - LinkedIn sued ProAPIs (Oct 2025) over a fake-account scraping network sold at up to $15k/month — [Security Affairs](https://securityaffairs.com/183001/security/linkedin-sues-proapis-for-15k-month-linkedin-data-scraping-scheme.html); [Bloomberg Law](https://news.bloomberglaw.com/artificial-intelligence/linkedins-war-against-bot-scrapers-ramps-up-as-ai-gets-smarter)
  - No Seamless.AI-specific lawsuit was found.
- **Data-broker registration:** Lusha is registered in the California Data Broker Registry — [Lusha](https://www.lusha.com/data-sources/)
- **Consolidation:**
  - Zoom bought Common Room (Jul 2026) — [Zoom](https://www.zoom.com/en/blog/zoom-to-acquire-common-room/)
  - ZoomInfo built Agent Teams on its DoubleO.ai acquisition — [ZoomInfo](https://pipeline.zoominfo.com/sales/what-is-zoominfo)
  - Persana is "joining forces with Rox" — [Persana](https://persana.ai/pricing)

### Inferences (lessons for SolutionAI's India lead engine)
1. **Discovery must be registry-first, not web-first.** Make the Indian incorporation ID (CIN or LLPIN) the primary key at birth. Attach GSTIN, Udyam and DPIIT IDs, then domain, LinkedIn and phone as they appear. Global tools key on domain or email (HubSpot, Clay), which is exactly what new Indian companies lack. *This is the main architectural divergence from every product above.*
2. **Build a Clay-style waterfall orchestrator, but India-aware.** Each field (director mobile, email, domain, GSTIN status, website) gets its own ordered provider list with cost, coverage and accuracy priors per provider. Charge or record cost only on hits, cache results, and support BYOK. Global vendors (Apollo, Lusha, PDL, Crustdata) slot in as later steps once a domain exists.
3. **Use an AI research agent ("Claygent for India") with reasoning traces** for sparse, unstructured facts: whether the website is live, what the business does, which grants it is eligible for. Store the trace for auditability and for disputes from data subjects.
4. **Build an entity-resolution golden record** with per-field provenance, timestamps and confidence. Bias it against false merges, since Indian name collisions are common and directors sit on multiple companies. Model it as a **company–director–address graph**, not flat rows.
5. **Use an event-sourced change log** (as PDL's changelog and Crustdata's watchers do). Every diff becomes a typed signal for need and intent scoring: new incorporation, GST registration, director added, domain registered, first job post, funding news, and so on.
6. **Close the verification loop.** Outcomes from email bounces, WhatsApp delivery and read receipts, voice-call connects and wrong-number flags should write back to field confidence. This mirrors Apollo's engagement-based verification and becomes our proprietary refresh source.
7. **Our contributory network is the CA/CS marketplace and platform users.** The equivalent of ZoomInfo's or Lusha's signature networks is the consented data flowing through compliance filings, grant applications and partner CAs. This would be a defensible India-specific moat, but it needs explicit consent design (see 9).
8. **Price transparently.** Charge per verified result, refund bounces, and avoid auto-renew traps. Credit opacity and renewal practices are the top complaints about Apollo and Seamless.
9. **Be careful about privacy and publicity.** Do not use real individuals' names in marketing previews or free trials (the ZoomInfo/Datanyze suits). Do not scrape LinkedIn through fake accounts (Proxycurl and ProAPIs). Keep a supplier-provenance register like PDL's, and provide deletion and opt-out propagation through the change feed. India's own data-protection obligations need separate legal research; they are not covered in these notes.
10. **Expose the data layer through an API and MCP from day one.** Every 2025–26 entrant ships MCP, and outreach agents (email, WhatsApp, voice) will consume the data layer as tools.
11. **Expect data to commoditise and margins to sit in orchestration.** Clay cut data prices 50–90% and still reached a $7.1B valuation. ZoomInfo's static-database model is stalling (+1.2% growth, 89% NRR). The defensible assets are India-specific: registry-native discovery, director-level contactability and an outcome-labelled scoring loop.

### Gaps
- No engineering-blog-level detail was found on any vendor's ER pipeline, storage or refresh scheduler, so the lessons above are inferred from product behaviour and docs.
- The current status of ZoomInfo's Washington and Quebec suits, and any 2026 privacy actions, was not confirmed.
- India-specific legal constraints (data-protection rules, telemarketing and DND rules for WhatsApp and voice) were not researched in this note.
