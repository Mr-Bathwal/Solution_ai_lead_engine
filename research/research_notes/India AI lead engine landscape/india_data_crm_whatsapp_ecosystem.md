# India company-data, startup-data, CRM and WhatsApp-engagement ecosystem, and public data sources for new Indian companies

Research date: 24 Oct 2026. All figures are dated inline. "(older)" marks information from before 2025. Some evidence comes from SolutionAI's own UP pipeline (local files under `C:\Users\goura\Downloads\up-startup-intel\` and the MCA file downloaded 5 Oct 2026). Those findings are first-hand observations and are cited as `file:///` links.

**Method note.** The shared web-search budget ran out partway through, at 200 searches per turn across all agents. After that, only direct fetches of known URLs were possible. Several government portals did not respond to fetches:
- mca.gov.in, data.gov.in, meity.gov.in, privatecircle.co, zaubacorp.com and moneylife.in returned 403.
- EPFO refused the connection.
- The ipindia.gov.in journal pages returned 404 or a certificate error.

So some fields are listed under **Gaps** rather than guessed. Reddit threads could not be found or fetched.

---

## Q1. Indian company/startup data players: what they charge, how they build data, and what they are worth

### Takeaway
The Indian company-data market splits into three groups:
- **Investor-intelligence platforms** (Tracxn, Venture Intelligence, PrivateCircle, TheKredible, Inc42 DataLabs). These are subscription products, mostly with hidden prices. Tracxn, the only listed one, is small and flat: FY25 operating revenue was ₹84.5 Cr and it made a net loss.
- **MCA-filings repackagers** (Tofler, InstaFinancials, Zauba, Probe42, Finanvo). These charge per credit or per company report, and Tofler starts at ₹15,000 a year.
- **KYB/verification API vendors** (Karza/Perfios, Surepass, Sandbox, Attestr, IDfy, Infyner, SignalX). These charge per API call, roughly ₹0.10–₹8 per call where prices are published.

Almost all of them build on MCA filings and other public registries, plus curation; none discloses a licensed MCA feed. InstaFinancials stands out: it openly sells a **daily list of newly incorporated companies with directors' email IDs and mobile numbers**, at a ₹60,000 + GST per month list price.

### Cited Findings

**Tracxn (listed on NSE as TRACXN, BSE code 543638)**
- **FY25 (year to March 2025):** operating revenue was ₹84.5 Cr, up 2% from ₹83 Cr in FY24, with total income of ₹90.36 Cr. Entrackr reports a FY25 net loss of ₹9.5 Cr, and a Q4 FY25 loss of ₹8 Cr against a ₹1.42 Cr profit a year earlier. Market cap was ₹674 Cr at a ₹63 share price (26 May 2025). — [Entrackr, 26 May 2025](https://entrackr.com/snippets/tracxn-slips-into-losses-in-q4-fy25-amid-flat-revenue-9307883)
- Inc42 put the Q4 FY25 loss at ₹7.6 Cr. — [Inc42](https://inc42.com/buzz/tracxn-slips-into-the-red-in-q4-posts-inr-7-6-cr-loss/)
- An earnings-call summary gave a different FY25 figure: PAT of ₹4.9 Cr (5.8% margin) and adjusted PAT of ₹10.8 Cr. This conflicts with the ₹9.5 Cr loss above and may reflect a different adjustment. — [Quartr Q4 FY25 summary, via search snippet](https://quartr.com/events/tracxn-technologies-tracxn-q4-24-25_FPEzpilT)
- The same summary says India revenue grew 18% year on year to about 40% of revenue, while international revenue fell about 6%. — [Quartr, via search snippet](https://quartr.com/events/tracxn-technologies-tracxn-q4-24-25_FPEzpilT)
- **Pricing:** the "Lite" plan is free with capped usage. "Premium" is priced by sales. APIs and data dumps are add-ons to Premium, sold as internal-use packs (full or limited access) and commercial-redistribution packs (priced by unique companies accessed or by dataset). There is no INR or India-specific tier. The pricing page claims 8.4M+ companies globally. — [Tracxn pricing](https://tracxn.com/pricing)
- Screener describes Tracxn as a subscription platform that "tracks and curates data of startups", with 4.0M+ entities. This figure is older than the pricing-page claim. — [Screener](https://www.screener.in/company/TRACXN/consolidated/)

**Venture Intelligence (Chennai, since 2002)**
- Its private-equity deal database covers investments from 1998 and exits from 2004. Records include investee, sector, investors, amount and date, with advisors, valuation multiples and financials for a subset. There are sub-databases for angel, incubator, impact and cleantech deals. — [Venture Intelligence](https://ventureintelligence.com/pelogin.php)
- No public pricing; quotes come through bizdev@ventureintelligence.com. — [VI LP Directory page](https://v1.ventureintelligence.com/lpdirectory.htm)

**Tofler (Gurgaon). Prices from the live pricing page, Oct 2026**
- **Pro:** ₹15,000 + GST a year, with 40 credits and MCA filings for 1 year.
- **Growth:** ₹28,000 + GST a year, with 100 credits, 5 years of filings, Finder, and Excel/PDF export.
- **Extra credits:** ₹349 + GST each.
- **Enterprise:** from ₹1.5 lakh + GST, adding an API, a Salesforce integration and team logins.
- No director contact data is advertised. — [Tofler price & plans](https://www.tofler.in/price-and-plans)
- Credit model (older, 2021): one credit unlocks one company's Company360 profile for a year. — [CFA Society India offer PDF, 2021](https://cfasocietyindia.org/wp-content/uploads/2021/06/Membership-Offer-Tofler.pdf)

**InstaFinancials. The most direct "new-company lead list" seller found**
- **CompanyFresh / WarmLeads** is a subscription giving "daily updates on newly registered Indian companies, including verified director contact details". It is sold All-India or by state, for 1, 3, 6 or 12 months, and is marketed to "sales teams, marketing agencies, financial institutions, SaaS providers". No data source is named, and there is no DND or consent language. — [InstaFinancials CompanyFresh](https://www.instafinancials.com/insta-tools/CompanyFresh.html); [WarmLeads page](https://instafinancials.com/products/New-Companies-In-India-List-of-Warm-Leads.aspx)
- **Diwali 2025 offer (older, expired 25 Oct 2025):** list price ₹60,000 + GST, offered at ₹15,000 + GST, for one user for one month, All-India. It covers OPC, LLP, private and public limited companies and includes **"director names, email IDs, and mobile numbers"**. Lists are emailed every working day before 10:30 AM, and buyers can also buy a full past month (Jan–Sep 2025). — [InstaFinancials offer page](https://contact.instafinancials.com/offers/companyfresh-diwali-25-offer)
- **DirectorConnect** returns "the mobile number associated with a DIN" for "any of the 30+ Lakh directors in India", priced per lookup, with bulk pricing on inquiry. It is described as for "legitimate B2B, compliance-aligned" use, but no source is named. — [InstaFinancials DirectorConnect (testing subdomain)](https://testing.instafinancials.com/insta-tools/Products/DirectorConnect.html)
- **InstaDocs** bundles "all the public documents from MCA" for a company, from incorporation to the latest filing. This shows the business is built on buying and reselling MCA public documents. — [InstaFinancials support](https://support.instafinancials.com/portal/kb/articles/how-to-download-instadocs)
- Per-company reports: InstaBasic ₹15 per company; InstaDetailed ₹599 per company (the second via search snippet). — [WarmLeads page](https://instafinancials.com/products/New-Companies-In-India-List-of-Warm-Leads.aspx)

**Zauba Corp**
- The site returned 403, so its terms and products could not be read.
- Third-party scraper tools (Chrome extensions, CodeCanyon) advertise exporting ZaubaCorp records: CIN/LLPIN, name, date of incorporation, address, **email address, phone number**, website, capital, and director names and DINs. This is unverified marketing copy. — [ZaubaCorp Scraper Pro (Chrome Web Store)](https://chromewebstore.google.com/detail/ikcifjddojhekaegbjokknfnjmnjffap); [CodeCanyon extractor](https://codecanyon.net/item/extrax-companies-data-extractor/40041383)

**Probe42**
- Draws on "743 validated public domain sources", cleaned through a 5-step process by "200+ data curators". Claims "17L active unlisted companies". Products are Probe42 Business, Probe42 Banking and an API. Prices are not public. — [Probe42](https://probe42.in/pricing)
- A February 2026 job posting claims 500+ data points on 2.5M companies from 760 sources. The posting is hosted on Accel's portfolio jobs board, which suggests Accel backing (an inference). — [Accel jobs board](https://jobs.accel.com/companies/probe42/jobs/66879183-pre-sales-executive)
- Directory listings give a starting price of ₹499. GetApp calls it usage-based and Software Advice calls it one-time, which conflict. — [Capterra](https://www.capterra.com/p/236540/Probe42/); [Software Advice](https://www.softwareadvice.com/product/499023-Probe42)

**SignalX (SignalX.ai, Hyderabad)**
- Seed round of ₹6 Cr led by 3Lines VC with Hyderabad Angels. PTI reported US$750K in Sep 2020 (older). Aggregator totals vary: Preqin says ₹52.3M, CB Insights $1.56M. — [Entrepreneur India](https://india.entrepreneur.com/finance/funding-alert-signalx-raises-inr-6-crore-in-seed-round/360215); [CB Insights](https://www.cbinsights.com/company/signalx)
- FY25 revenue of ₹2.8 Cr, per Inc42 (via search snippet). — [Inc42 company page](https://inc42.com/company/signalx/)
- Products: Risk Master, Risk Terminal, Risk360 reports and RiskGPT. APIs cover MSME/Udyam, GST, struck-off checks, litigation, financials and AML/KYB. Free GST-search and Udyam-check tools are offered. It claims "2 million+ entities assessed" and 400+ customers. Prices are not public. — [SignalX](https://signalx.ai/)

**Inc42 DataLabs**
- Core is free, with 5 AI queries a day and no exports. Pro is ₹1,499 a month + GST, with 50 export credits a month and a 7-day trial. Coverage claimed: 25,000+ funding rounds, 75,000+ companies and 3,500+ investors. — [Inc42 DataLabs pricing](https://inc42.com/datalabs/pricing/)
- Inc42 Plus is a separate media membership. Prices conflict across pages: one shows ₹3,499 for 1 year (promotional), another ₹4,999. — [Inc42 Plus](https://inc42.com/plus)

**PrivateCircle (Bengaluru, founded 2015)**
- Total raised is $16.5M, from investors including Blume Ventures, Auxano, KG Global Platform Fund and Nandan Nilekani. This is aggregator data with no dated primary source. — [CB Insights compare](https://www.cbinsights.com/compare/privatecircle-vs-tracxn); [Wellfound](https://wellfound.com/company/privatecircle)
- Claims data on 1.7M companies. The pricing page returned 403. — [WebCatalog description](https://webcatalog.io/uk/apps/privatecircle)

**TheKredible**
- Launched in Sep 2023 with a ~$500K seed round. It is built on Fintrackr, Entrackr's data-journalism arm that analyses MCA financial filings. Coverage includes funding, valuations, financials and cap tables. It sells annual subscriptions and custom data; no prices are published. (2023 info, older) — [Entrackr, Sep 2023](https://entrackr.com/2023/09/launching-startup-intelligence-platform-thekredible-closes-500k-seed-round)

**Karza (Perfios)**
- Perfios bought Karza in 2022 for about ₹597 Cr (~$80M). (older) — [The Paypers](https://thepaypers.com/fintech/news/india-perfios-acquires-karza-for-usd-80-mln)
- Perfios FY25: profit ₹104 Cr (+46%) and revenue above ₹700 Cr. It serves 1,000+ financial institutions with 75+ products and 500+ APIs, and has raised close to $440M in total. In 2025 it bought Clari5 (February), CreditNirvana (March) and IHX (April). — [Inc42 Perfios FY25](https://inc42.com/buzz/perfios-fy25-profit-soars-46-to-₹104-cr-revenue-crosses-₹700-cr/)
- Perfios became a unicorn in 2024 after raising $80M from Teachers' Venture Growth at a valuation above $1B. Valuation reports from 2022 conflict: Inc42 corrected its own "$2B+" figure to $400M. — [Inc42](https://inc42.com/buzz/exclusive-perfios-becomes-unicorn-with-70-mn-funding)

**Verification/KYB API vendors**
- **Surepass** publishes no prices on its pricing page, only "Contact Sales". Its business product pulls "filed documents on MCA for Due Diligence", and it also offers a Udyam check API. — [Surepass pricing](https://surepass.io/pricing/); [Surepass Udyam API](https://surepass.io/udyam-registration-check-api/)
- Surepass says the MCA V3 portal integrates "View Public Document" services, allowing users to buy and download filed documents. — [Surepass FAQ, via search snippet](https://surepass.io/faq/how-to-find-mca-master-data)
- **Sandbox.co.in** has no per-API prices on its pricing page, only a cost calculator, enterprise sales and a free trial. — [Sandbox pricing](https://www.sandbox.co.in/pricing)
- **Attestr:** the pricing page returned 404, so its prices are a gap. — [attestr.com/pricing](https://attestr.com/pricing)
- **IDfy** claims 70M+ verifications a month, 500+ clients and operations in 7 countries. Its homepage does not name MCA/GST/Udyam KYB products, and funding was not found. — [IDfy](https://www.idfy.com/)
- **Finanvo** describes "verified corporate information on over 2.4 million companies". Prices were not found. — [Finanvo deck on Scribd](https://www.scribd.com/document/628461342/CompData)
- **Infyner** is the one vendor found that publishes per-call INR prices. The table below uses its Starter pack rate of ₹1 per credit; larger packs bring this down to ₹0.60 per credit. — [Infyner API pricing](https://www.infyner.com/api-pricing)

| Infyner API call | Price per call |
|---|---|
| Company lookup by CIN or name | ₹0.10 (free up to 500 a day) |
| Full company master profile | ₹5 |
| Company directors | ₹2 |
| Director lookup by DIN | ₹1 |
| GSTIN lookup (Infyner's own data) | ₹1 |
| GSTIN official verification | ₹3 |
| One year of financials | ₹8 |
| **Credit packs** | ₹10,000 for 10k credits; ₹40,000 for 50k; ₹60,000 for 100k |

- **Qorpiq** exposes two MCA endpoints:
  - company/LLP master data by CIN, LLPIN or FCRN, with optional charges, principals, filings, annual returns and balance sheets;
  - director master data by DIN, with appointments across companies.
  
  — [Qorpiq API docs](https://developers.qorpiq.com/docs/api/mca)
- **Decentro**'s CIN API returns status, ROC, capital, incorporation date, and directors with DIN/PAN, appointment dates and disqualification status. Prices are not public. — [Decentro](https://decentro.tech/api-hub/cin-verification-api)
- An **Apify actor** resells the data.gov.in MCA master data at "$50 per 1,000 records". Director, DIN and charges data are "not currently published on OGD". — [Apify nexgendata](https://apify.com/nexgendata/india-mca-companies-director-filings-ogd)

### Inferences
- **Data is built, not licensed.** Every player whose method is visible builds on MCA public filings and other public registries, which it buys, downloads or scrapes, then curates and enriches with manual curation:
  - InstaFinancials resells MCA public documents (InstaDocs).
  - Probe42 uses 743 public sources plus 200 curators.
  - TheKredible builds on Fintrackr's analysis of MCA filings.
  - Tofler is organised around "MCA filings: 1 year / 5 years".

  No vendor claims an official MCA bulk licence, and none was found to exist (see Q5).
- **Contacts are sold commercially despite public-data limits.** InstaFinancials sells director mobile numbers even though MCA reportedly says its public Master Data Service carries no phone numbers (Q6). Phones are therefore probably harvested from purchased public documents (for example DIR-2 attachments), or from other routes. The most likely origins of the daily "new company + director phone" lists sold in India are document-level extraction or leakage.
- **Cost of building in-house.** For SolutionAI, per-call KYB APIs at ₹0.10–₹5 per company are cheap enough to enrich roughly 2,500 UP companies a month. Even 25,000 all-India companies at ₹5 cost about ₹1.25 lakh a month. That is far cheaper than investor-intel subscriptions, which add little for brand-new companies.

### Gaps
- Crunchbase and PitchBook India coverage and pricing were not researched (search budget exhausted).
- Venture Intelligence, PrivateCircle, Zauba, Karza API, Surepass, Sandbox, Attestr and Finanvo prices are not public.
- Tracxn's FY26 results and current market cap were not retrieved; Screener showed blank fields.
- No funding data was found for Probe42, Surepass, Sandbox, Attestr, IDfy or Finanvo.
- The exact InstaFinancials 2026 list price is unknown; only the expired Oct 2025 offer is documented.

---

## Q2. CRM and lead-management players in India

### Takeaway
LeadSquared is the Indian-built leader. It is a 2022 unicorn whose FY25 revenue was ₹326 Cr (+17%), and it cut losses 45% to ₹89 Cr. It sells high-ticket annual accounts of about ₹0.9–1.5 lakh a year.

For SMBs, the low-cost options are:
- Zoho CRM, with a free tier for 3 users;
- Bigin, at about US$7–18 per user a month;
- Kylas, with a free 10k-record tier, unlimited users, and IndiaMART/Justdial lead capture.

None of them supplies data on new companies. They are the system of record and outreach layer that SolutionAI's engine would feed, or replace.

### Cited Findings
- **LeadSquared FY25 financials** (Entrackr, 14 Oct 2025):
  - Revenue from operations ₹326 Cr, up from ₹279 Cr in FY24 (+17%).
  - Loss ₹89 Cr, down from ₹162 Cr (−45%).
  - Expenses: employee costs ₹280 Cr; data-centre costs ₹82 Cr; advertising ₹18 Cr (+38.5%).
  - Total raised: $205M, per TheKredible.
  
  — [Entrackr, 14 Oct 2025](https://entrackr.com/fintrackr/leadsquared-trims-losses-by-45-in-fy25-growth-remains-modest-10561373)
- Inc42 lists LeadSquared's FY25 revenue as ₹311.2 Cr, which conflicts with Entrackr's ₹326 Cr. — [Inc42 company page, via search snippet](https://inc42.com/company/leadsquared/people/)
- **LeadSquared valuation (2022, older):** a $153M Series C led by WestBridge at $1B post-money. No newer priced round was found. Dealroom's "$1–2.5B (2026)" is an unsourced range. — [Techloy, 2022](https://www.techloy.com/saas-platform-leadsquared-raises-153-million-becomes-the-latest-unicorn-in-india/); [Dealroom](https://dealroom.co/companies/leadsquared/)
- **LeadSquared pricing:**
  - Marketing Pro: ₹90,000 per account a year (2 users), with 100k emails a month and 1,000 chatbot sessions.
  - Marketing Super: ₹1,49,000 a year, with 250k emails a month and AI email parser.
  - Both include lead scoring, lead distribution and bulk import. Sales-CRM per-user prices go through sales.
  
  — [LeadSquared pricing](https://www.leadsquared.com/pricing/)
- **Zoho CRM:** free for 3 users, with 5,000 API calls a day. Paid editions run Standard → Ultimate; CRM Plus starts at $20 per user a month. INR prices were not rendered in the fetched page. — [Zoho CRM pricing](https://www.zoho.com/crm/zohocrm-pricing.html)
- **Bigin (Zoho)**, per user a month: Free (1 user, 500 records, 1 pipeline); Express $7 a year-billed / $9 monthly; Premier $12/$15; Bigin 360 $18/$21. WhatsApp Business integration starts at Express. — [Bigin pricing](https://www.bigin.com/pricing.html)
- **Kylas (Pune):** Embark is free forever with 10,000 records and unlimited users. Elevate is a flat monthly fee with 100,000 records. Exceed is a custom quote. WhatsApp and IVR telephony start at Elevate. Lead capture from IndiaMART and Justdial is included. It claims 5,000+ businesses, 4.7 on G2 and 4.8 on Capterra. — [Kylas pricing](https://kylas.io/pricing)
- **Salesforce and HubSpot integrations** appear as premium tiers across Indian tools. WATI's Pro tier integrates HubSpot and its Business tier integrates Salesforce. Tofler Enterprise includes a Salesforce integration. — [WATI pricing](https://www.wati.io/pricing/); [Tofler](https://www.tofler.in/price-and-plans)

### Inferences
- A CRM that natively ingests MCA, DPIIT and state-portal leads and scores them is not offered by any Indian CRM found. LeadSquared and Kylas capture inbound leads from portals such as IndiaMART and Justdial; they do not discover registry-sourced leads.
- That gap is SolutionAI's opening. SolutionAI can still export to Zoho or Bigin/Kylas for sales teams already on them.

### Gaps
- Kylas funding and pricing for its paid plans.
- Zoho CRM and Bigin INR prices.
- Salesforce and HubSpot India customer counts and usage share: no sourced data was retrieved.
- LeadSquared's current valuation and FY26 numbers.

---

## Q3. WhatsApp engagement BSPs (business solution providers)

### Takeaway
Since 1 Jul 2025, Meta charges per delivered message. India's marketing rate rose to ₹0.8631 on 1 Jan 2026. From 1 Oct 2026, utility messages inside the service window, and service messages beyond 1,000 free a month, are also charged.

Indian BSPs add a subscription of about ₹2,400–17,000 a month and a markup. Delivered marketing prices land around ₹0.95–₹1.09 per message.

Gupshup is the scale player: about $350M FY26 revenue and profitable, but Fidelity marked it down to $278M in Jan 2026. Interakt is owned through Jio/Haptik. Gallabox, WATI, AiSensy and DoubleTick compete on SMB price and AI agents.

### Cited Findings

**Meta (the cost floor)**
- **Pricing model:** per-message since 1 Jul 2025.
- **Categories:** marketing, utility, authentication, service, and "Meta Business Agent" (added 1 Jul 2026).
- **India changes:**
  - 1 Jan 2026: India marketing rate rose.
  - 1 Apr 2026: India authentication-international rate rose.
  - From 1 Jan 2026, INR billing is available. Eligible India accounts must move to INR by 31 Dec 2026, and non-INR accounts stop delivering on 1 Jan 2027.
- **Free allowances:**
  - 1,000 free service messages per phone number a month.
  - From 1 Oct 2026, service messages above that, and utility messages within the service window, are charged.
  - Click-to-WhatsApp ad replies open a free-entry-point window of up to 7 days.
  
  — [Meta WhatsApp pricing docs](https://developers.facebook.com/docs/whatsapp/pricing/)
- India's marketing rate went from ₹0.7846 to ₹0.8631 per message from 1 Jan 2026. — [MSG91 guide, 16 Dec 2025](https://msg91.com/guide/whatsapp-pricing-update-2026-and-save-with-msg91)

**Interakt (Haptik, Jio Platforms)**
- Plans per month: Growth ₹2,799; Advanced ₹3,799; Sales CRM ₹2,499 with 5 agents (+₹499 per extra agent); Instagram-only ₹999.
- Per-message prices:

| Plan | Marketing | Utility | Authentication |
|---|---|---|---|
| Starter | ₹0.970 | ₹0.160 | ₹0.129 |
| Growth | ₹0.958 | ₹0.150 | ₹0.128 |
| Advanced | ₹0.949 | ₹0.140 | ₹0.127 |
| Enterprise | no markup | no markup | no markup |

- WhatsApp AI Agents cost ₹2,499 a month, with ₹0.50 per AI message after 100.
- Public APIs for sending templates and creating campaigns are included in every plan.

— [Interakt pricing](https://www.interakt.shop/pricing/)
- Haptik is part of Jio Platforms, which took a majority stake in early 2019 (~$100M, older). Interakt is listed as a Haptik product. — [Haptik about](https://www.haptik.ai/about-us)

**AiSensy**
- Per-message prices effective 1 Oct 2026: marketing ₹1.09; utility, authentication and service ₹0.145 each (service after the first 1,000 free).
- Add-ons: chatbot builder ₹2,500 a month; AI agent builder ₹1,350 a month; Indian virtual number ₹2,000 a year.
- Contacts are unlimited under fair use, and it does not charge for WhatsApp Business API procurement.

— [AiSensy pricing](https://aisensy.com/pricing)
- Latka *estimates* 2025 revenue at $8.9M with about 101 staff, and lists only a $100K seed round (2022). These are unverified aggregator figures. — [Latka](https://getlatka.com/companies/aisensy)

**WATI**
- Plans per month, billed quarterly: Growth ₹2,699 (3 users), Pro ₹5,799 (5 users), Business ₹16,799 (5 users). The tiers add AI agents (Astra), API calls (10k / 200k / 20M a month) and HubSpot or Salesforce integrations. India per-message rates sit in a separate rate card. — [WATI pricing](https://www.wati.io/pricing/)
- A third-party audit estimates WATI's message markup at about 20%. — [CodingClave](https://codingclave.com/blog/wati-pricing-india-2026)

**Gallabox**
- Plans per month: Basic ₹2,999 quarterly / ₹2,399 annual (3 users); Essential ₹6,999 / ₹5,599 (6 users); Advanced ₹16,999 / ₹13,599 (10 users, with AI voice on WhatsApp and phone). — [Gallabox pricing](https://gallabox.com/pricing)
- Funding: a $3.5M seed in Jan 2025 led by FUSE, with Prime Venture Partners and Neon Fund. Total raised is about $5M since 2021. It claims 10,000+ businesses in 45 countries. — [Gallabox press release, 29 Jan 2025](https://gallabox.com/news/gallabox-raises-3.5-million-to-fuel-its-mission)
- Earlier $1.2M seed round led by Prime (older). — [Inc42](https://inc42.com/?p=368373)

**DoubleTick**
- Starter, Pro and Enterprise plans have no published prices, and there is no free trial. AI agents are included in every plan. — [DoubleTick pricing](https://doubletick.io/pricing)

**Gupshup**
- India-entity FY25: revenue ₹1,943 Cr, down from ₹2,051 Cr; net profit ₹26 Cr, down from ₹54 Cr.
- CEO: FY26 global revenue is about $350M and the company is profitable; AI is about 25% of revenue.
- 50,000+ businesses in 130 countries.
- Valuation: Fidelity invested at $1.4B (2021), marked it to $697M (Jul 2023), then $278M (Jan 2026).
- Meta Business Agent is pushing WhatsApp up into the AI-application layer where Gupshup is building, which threatens BSPs.

— [Inc42 feature, 23 Sep 2026](https://inc42.com/features/gupshup-ai-rebuild-can-it-stay-ahead-of-the-platforms-it-runs-on/)
- Gupshup raised $60M in equity and debt in July 2025 in an unpriced round. — [TechCrunch, 22 Jul 2025](https://techcrunch.com/2025/07/22/gupshup-raises-60m-in-equity-and-debt-leaves-unicorn-status-hanging)

### Inferences
- **Cost model.** Cold "marketing" templates to 2,500 new UP companies a month would cost under ₹3,000 a month in message fees (about ₹1 each). Subscription and compliance, not message cost, dominate the budget.
- **Opt-in is the constraint.** Meta's per-message model makes marketing templates the most expensive category. The proposal's "WhatsApp only to opted-in contacts" rule therefore pushes the design toward channels that start the conversation: click-to-WhatsApp ads (free 7-day window), website and email CTAs, and QR codes at IIT E-Cell events.
- **Choice of BSP.** For SolutionAI, Interakt and AiSensy have the lowest entry prices and published APIs. Gallabox and WATI bundle AI voice and agents. Meta's own Business Agent may commoditise BSP AI layers, which argues for keeping the agent logic in SolutionAI's stack and using the BSP only as a pipe.

### Gaps
- Meta's India utility and authentication base rates. The rate-card CSVs were not fetched.
- Meta's opt-in policy wording. Not fetched; well known, but uncited here.
- Funding for WATI, DoubleTick and AiSensy beyond Latka.
- Yellow.ai: not researched (search budget exhausted).
- G2/Capterra sentiment for the BSPs: not retrieved.

---

## Q4. How Indian compliance and registration firms find and convert newly incorporated companies

### Takeaway
Direct evidence that named large firms (Vakilsearch, IndiaFilings, ClearTax, etc.) **buy** MCA lists was not found. However:
- An open market for daily new-company lists with director phones and emails exists (InstaFinancials, Q1).
- A May 2026 investigation names smaller "compliance-services intermediaries" among those calling founders within hours of incorporation.
- Reviews of IndiaFilings and Vakilsearch document aggressive call, WhatsApp and email follow-up.

Razorpay Rize acquires founders through community and programmes rather than cold lists.

### Cited Findings
- **Callers within 24 hours of incorporation.** Inventiva (26 May 2026) names banks (Kotak, HDFC, ICICI, IDFC First, Federal, Axis, IndusInd, South Indian Bank, Deutsche Bank) pitching current accounts. It also names compliance-services intermediaries: **Filingbuzz, Falcon Ebiz, Bizz At Ease, H&G Ebiz, My Biz Development, Filingbuddy.in**, plus a phishing-style "MCA Support" email. This is an opinion/investigative piece built partly on anonymous founder accounts. — [Inventiva, 26 May 2026](https://www.inventiva.co.in/?p=439177)
- **Other uses of the data.** A June 2024 Inventiva piece alleges directors' data is used by "private entities… to offer trademark, website design, and domain registration services". These are allegations without documents (older). — [Inventiva, 19 Jun 2024](https://www.inventiva.co.in/?p=423955)
- **IndiaFilings** has a Trustpilot TrustScore of 2.8/5 from 1,175 reviews (58% 5-star, 35% 1-star). Recent reviews describe heavy follow-up:
  - "repeatedly calls and follows up until you make the payment" (23 Oct 2026);
  - "called me every day" (5 Sep 2026);
  - "bombarded me with WhatsApp messages and emails" (4 Sep 2026).
  
  — [Trustpilot IndiaFilings](https://www.trustpilot.com/review/indiafilings.com)
- **Vakilsearch**'s Trustpilot rating is suppressed: Trustpilot says it "removed a number of fake reviews". It has 1,560 reviews, 29% of them 1-star. One September 2026 reviewer says "we are still receiving your emails to buy services from you". — [Trustpilot Vakilsearch](https://www.trustpilot.com/review/vakilsearch.com)
- **Razorpay Rize** handles incorporation (Pvt Ltd, LLP, OPC) "through dedicated partners" at "low fees". Its acquisition engine is community-led: Rize Tech+, D2C+ and Xport+ communities, Rize for YC, Pitch Perfect, and a list of 250+ investors. It claims **14,950+ company registrations** and 1,750+ founders. — [Razorpay Rize](https://razorpay.com/rize/)
- **Company profiles** (Inc42's data looks unreliable):
  - Vakilsearch: Chennai, founded 2010, $10M+ raised over 3 rounds (last Oct 2021). FY24 revenue is shown as "₹24 lakh", which is implausible.
  - IndiaFilings: Chennai, 2013, $4.3M raised (Jan 2022). The page's revenue fields conflict and its business description appears to be for a different company.
  
  — [Inc42 Vakilsearch](https://inc42.com/company/vakilsearch/); [Inc42 IndiaFilings](https://inc42.com/company/indiafilings/)

### Inferences
- **Two acquisition models.** Large registration firms mainly acquire customers *before* incorporation, through search/SEO, marketplace ads and Razorpay-style partnerships, then upsell compliance with intensive tele-calling. A long tail of small "e-biz" firms appears to work purchased post-incorporation director lists.
- **Differentiation.** SolutionAI's angle is consent-first, personalised outreach that avoids the "called within hours" pattern founders resent. It should never use language or channels that resemble MCA, given the MCA fraud advisory (Q6).

### Gaps
- No sourced evidence on whether ClearTax, RegisterKaro, LegalWiz, Corpbiz, Setindiabiz, Vakilsearch or IndiaFilings buy MCA or InstaFinancials lists.
- Their CAC and channel mix were not found.
- Reddit threads (r/IndiaBusiness, r/StartUpIndia) on post-incorporation spam could not be located before the search budget ran out.

---

## Q5. Catalogue of public and licensable data sources for new Indian companies and startups

### Takeaway
The only **free, official, complete and timely** national feed of new incorporations is MCA's monthly "Incorporated or Closed During the Month" Excel file:
- posted around the 1st–5th of the following month;
- about 21–26k companies and about 9.5–11k LLPs a month;
- only six columns (CIN, class, name, date, type, activity code), with **no address, email or directors**;
- manual download only, because MCA's Akamai edge blocks scripts.

Other notes on official sources:
- Director and contact data lives in per-company MCA master data and paid public documents.
- data.gov.in's MCA master is free but **stale (data to 3 Nov 2023)**.
- DPIIT offers anonymous count APIs, but its directory search was down on 1 Oct 2026.
- State portals (Startup in UP) expose profile pages without contacts.
- Udyam and GST data is mostly per-ID lookup, not discovery.

### Cited Findings: catalogue

| # | Source | What it gives (fields) | Freshness | Access method | Cost | Terms / notes |
|---|---|---|---|---|---|---|
| 1 | **MCA monthly "Companies and LLPs registered in <month>"** (Data & Reports → Company/LLP Info → Incorporated or Closed During the Month → "Master Details of Companies Registered", folder 403, ~125 monthly files back to ~2016) | 3 sheets. **Indian Companies:** CIN, Class, Company Name, Date of Registration, Company Type, Activity Code. **LLP:** LLPIN, LLP Name, Date of registration, Activity. **Foreign:** FCIN, Name, Date, Activity. No address, email, directors or capital. State, ROC, year and type are decoded from the CIN. | Monthly. The Aug 2026 file was posted 1 Sep 2026; the Sep 2026 file was generated 05-Oct-2026. Volumes: Sep 2026 = 24,325 companies and ≈10,877 LLPs; Aug 2026 = 21,511 companies and 9,574 LLPs (MCA KPI tiles). | Manual download in a real browser. Akamai returns 403 to scripted clients and headless Chrome. Files come from `/bin/dms/getdocument`. | Free | Public government report. Source: [local MCA file, 5 Oct 2026](file:///C:/Users/goura/Downloads/Incorporation-Report-20261005.xlsx); [local L1 report](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L1_registry/REPORT.md); [collector notes](file:///C:/Users/goura/Downloads/up-startup-intel/engine/collect_mca_files.py) |
| 2 | **UP slice of #1** (ROC UP-I and UP-II, after ROC Kanpur was split on 16 Feb 2026) | As #1 | May–Sep 2026: 2,638 / 2,189 / 2,829 / 2,381 / 2,676 UP companies a month, about 11% of India. About 480–630 a month look "startup-like" by activity code. | As #1 | Free | [local monthly stats](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L1_registry/up_monthly_stats.csv) |
| 3 | **MCA V3 company master data (per-company view)** | CIN, name, incorporation date, status, ROC, authorised and paid-up capital, directors and signatories, registered address, filing status. An MCA RTI reply says the Master Data Service includes **director names and emails but not phone numbers**. | Live | Web lookup per CIN on mca.gov.in | Basic details free; "certain detailed documents… may require a fee" | [Razorpay Rize guide, 23 Jun 2026](https://razorpay.com/rize/blogs/mca-master-data-company-search-roc-records-guide); RTI reported by [Inventiva, 26 May 2026](https://www.inventiva.co.in/?p=439181) |
| 4 | **MCA public documents (V3 "View Public Documents")**: incorporation forms, DIR-12 with DIR-2 attachments | DIR-2 carries the director's **phone, email, address, date of birth and PAN** plus ID proofs. After DIR-12 is filed it is a public document inspectable "for a nominal fee". In Apr 2022 MCA masked *members'* register details (email, PAN, address), but **not directors'** DIR-2 data. | As filed | Paid per-company document purchase on the V3 portal | Fee not confirmed (gap) | [Clasis Law via Conventus, 13 Feb 2024](https://conventuslaw.com/report/india-directors-in-the-digital-age-managing-personal-information-of-directors/); [Surepass FAQ (snippet)](https://surepass.io/faq/how-to-find-mca-master-data) |
| 5 | **data.gov.in "RoC-wise Company Master Data"** (MCA, OGD) | CIN, name, status, class, category, authorised and paid-up capital, date of registration, state, ROC; principal activity and registered address in state files. **No directors, DIN or charges.** | Metadata says "Monthly", but the note says **"data upto 3rd November 2023"** (stale). Metadata last changed 22 Jul 2026. | CSV download. The API exists (`is_webservice` 1), but api.data.gov.in refused connections on 1 Oct 2026. | Free (`is_priced` 0) | OGD platform; 65,701 downloads. [local cached metadata](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L1_registry/_cache/dgi_meta_roc_master.json); [data.gov.in resource](https://www.data.gov.in/resource/registrars-companies-roc-wise-company-master-data); [Apify note on missing directors](https://apify.com/nexgendata/india-mca-companies-director-filings-ogd) |
| 6 | **MCA "data products" or official bulk API** | No official bulk data product or price list was found. Resellers fill the gap. | — | — | Resellers: Apify $50 per 1k records; Infyner ₹0.10–₹5 per call; Tofler Enterprise API from ₹1.5 lakh a year | [Infyner](https://www.infyner.com/api-pricing); [Tofler](https://www.tofler.in/price-and-plans) |
| 7 | **MCA Monthly Information Bulletin** | Aggregate counts of companies and LLPs registered, active and closed; statistical, no personal data | Monthly | Web/PDF | Free | [MCA MIB page](https://www.mca.gov.in/mca/html/mcav2_en/home/dataandreports/reports/monthlyinformationbulletin/monthlyinformationbulletin.html); RTI description in [Inventiva](https://www.inventiva.co.in/?p=439181) |
| 8 | **DPIIT / Startup India: anonymous count APIs** | `GET api.startupindia.gov.in/sih/api/noauth/dpiit/services/recognition/recent-statistics?stateId=all` returned 238,177 recognised startups, 256,022 certificates, 4,612 "last month", 5,981 "current month" and 4,799 funded. UP: 24,079 (rank #2 after Maharashtra at 40,441). | Live counters (read 1 Oct 2026) | Anonymous JSON GET | Free | Undocumented public endpoints used by the site. [local cache](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L2_dpiit/_cache/stats_all.json); [L2 report](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L2_dpiit/REPORT.md) |
| 9 | **DPIIT / Startup India directory search** | Profile search with filters: DPIIT-recognised, 80-IAC, industry, sector, stage, state, city. Full details trigger a login prompt. | Live | `POST /sih/api/noauth/search/profiles` returned **503 on 1 Oct 2026** (backend down). The `/auth/` variant needs a login token, which is out of bounds. | Free | [Startup India search](https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup&page=0); [L2 report](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L2_dpiit/REPORT.md) |
| 10 | **DPIIT official open dataset** (NMDS) | Year, State, Industry, Count of startups recognised. Aggregate only; 8,550 rows. | "Monthly" release calendar | data.gov.in CSV | Free; "Public" | [Startup India NMDS metadata PDF (Dec 2024)](https://www.startupindia.gov.in/content/dam/invest-india/States-images/Metadata-NMDS-Startup-India.pdf) |
| 11 | Third-party DPIIT mirrors | Company name, legal name, CIN, website, status, focus industry and sector (about 2,937 rows; incomplete). One NIRF-linked list of institution startups has 6,817 rows (updated 20 Jul 2026). | Yearly or irregular | Dataful download | Freemium | [Dataful](https://dataful.in/datasets/?q=startups); [Dataful NIRF set](https://dataful.in/datasets/20553/) |
| 12 | **Startup in UP / UP Startup Mission** | Public directory: 216 pages, 2,157 startups. Cards show brand, website, entity type, sector, stage, team names, incubator, year of establishment, district and PIN. **Email and phone are commented out of the HTML.** Also 88 incubators (with portfolios) and 7 CoEs. | Live; the incubator table was printed 30/09/2026 | Public HTML pages (`/crm/welcome/connect_network/{page}/`) | Free | Homepage counters: 24,840 Startup India-recognised in UP, 2,368 StartinUP-recognised, ₹146 Cr incentives approved and ₹58 Cr disbursed. The portal is moving to "UP Startup Mission". [StartinUP](https://startinup.up.gov.in/); [L3 report](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L3_startinup/REPORT.md) |
| 13 | **Udyam (MSME)**: data.gov.in district-wise totals; "List of MSME Registered Units under UDYAM" | District totals with LGD codes (manufacturing and services splits); a unit list | Listed as "daily", but last modified 07/05/2025 (totals) and 23/04/2025 (unit list) | CSV download. **No API** ("Request API" button; ndsap@gov.in) | Free | [data.gov.in Udyam district](https://www.data.gov.in/resource/district-wise-total-msme-registered-enterprises-under-udyam-registration-till-last-date); [Udyam units list](https://data.gov.in/resource/list-msme-registered-units-under-udyam); [AIKosh mirror](https://aikosh.indiaai.gov.in/home/datasets/details/district_wise_total_msme_registered_enterprises_under_udyam_registration_till_last_date.html) |
| 14 | Udyam verification APIs | Per Udyam number: MSME business details. Field list not published. | Live | Vendor API (Surepass, SignalX free tool) | Contact sales | [Surepass](https://surepass.io/udyam-registration-check-api/); [SignalX](https://signalx.ai/) |
| 15 | **GST: GSTIN search** | Per-GSTIN or PAN lookup. The official page is JavaScript-only; fields were not retrievable. | Live | Official portal (JS) or vendor APIs | Infyner ₹1 (own data) or ₹3 (official verification) per call; SignalX free search tool | [GST search page](https://services.gst.gov.in/services/searchtp); [Infyner](https://www.infyner.com/api-pricing) |
| 16 | **DGFT IEC: "View Any IEC"** | Needs the IEC *and* the first 3 characters of the firm name. Shows basic details including Denied Entity List status. | Live | Per-ID web form | Free | Not usable for discovery. [DGFT](https://www.dgft.gov.in/CP/?opt=view-any-ice) |
| 17 | **Incubators: AIM / AICs** | The AIM site lists "Selected" and "Established" AICs (PDF). No public incubatee list was found. The page was last updated 03-01-2024. | Irregular | Web/PDF | Free | [AIM AIC page](https://aim.gov.in/atal-incubation-centres.php) |
| 18 | Incubator portfolios (UP pipeline experience) | AIC-BIMTECH: 147 portfolio companies with incubation year; SIIC (IIT Kanpur): 260 and IIML EIC: 378, both **undated** | Irregular | Scraped from public portfolio pages | Free | [L4 report](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L4_ecosystem/REPORT.md) |
| 19 | **Funding news: Inc42** | Funding rounds, lists | Daily | inc42.com pages are blocked to scripts, but its **WordPress REST API works**. Google News RSS hit 429 errors and Bing News RSS was used as a fallback. DataLabs Pro is ₹1,499 a month for exports. | Free / ₹1,499 a month | [L4 report](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L4_ecosystem/REPORT.md); [Inc42 DataLabs](https://inc42.com/datalabs/pricing/) |
| 20 | Funding data: TheKredible / Entrackr | Funding, valuations, MCA financials | Ongoing | Subscription | Undisclosed | [Entrackr](https://entrackr.com/2023/09/launching-startup-intelligence-platform-thekredible-closes-500k-seed-round) |

### Inferences
- **Recommended freshness stack:**
  1. MCA monthly file (T+1–5 days after month end) as the spine for every new CIN.
  2. Per-CIN enrichment within days: MCA master data via an API vendor at ₹0.10–₹5 per call. This gives directors, registered address and possibly the company email.
  3. DPIIT counts and StartinUP profiles for startup signals.
  4. Inc42 WordPress REST and news for funding.
  5. Website discovery for business emails and contact forms.
- **The only same-day option is commercial.** No public source is fresher than the monthly file except InstaFinancials-type daily lists, whose sourcing is opaque (see Q6).
- **Discovery versus verification.** Udyam, GST, IEC and EPFO are per-ID verification lookups. They are useful for enrichment and scoring once a PAN, GSTIN or CIN is known, but not for discovery.

### Gaps
- **IP India trademarks and patents:** the Trade Marks Journal (weekly) and patent journal pages returned 404 or a certificate error, so frequency, fields and terms are unverified.
- **EPFO establishment search:** connection refused, so fields are unverified.
- **.IN WHOIS (NIXI registry.in):** returned 500; redaction and bulk policy unknown.
- **Not researched:** GeM sellers, app stores, Naukri, LinkedIn and Wellfound hiring signals, BIRAC, NSRCEL, CIIE, T-Hub cohorts, VCCEdge, YourStory, and the other state portals (Karnataka, KSUM, Telangana, Gujarat, MSInS). MSInS and KSUM fetches returned empty pages or 404.
- **MCA fees:** the V3 "View Public Documents" fee and whether the company email appears in V3 master data were not confirmed from an official page.
- **data.gov.in licence:** GODL terms were not fetched (the site returned 403).
- **Udyam total:** the cumulative registration count is only available in older figures (99.58 lakh as of Aug 2022, via community.data.gov.in summaries).

---

## Q6. The freshest and most legally clean way to get new-incorporation data with contacts, and what is risky

### Takeaway
**Clean route:**
1. MCA monthly file (free, official).
2. Per-CIN enrichment from MCA master data or KYB APIs, for directors, address and company email where present.
3. Business-level contacts from the company's own website and domain.
4. Outreach by email with a clear opt-out.
5. WhatsApp only after opt-in.
6. Calls only through registered telemarketing channels.

**Risky:** buying director mobile numbers and emails (InstaFinancials-style daily lists, DirectorConnect), extracting DIR-2 personal data from public documents, and robocalling from ordinary numbers.

These are risky because:
- DPDP's main consent and notice duties apply from **13 May 2027**.
- The "public data" exemption covers data made public *under a legal obligation*, and whether that extends to commercial resale is unsettled.
- TRAI's Feb 2025 rules force promotional robocalls onto the 140 series, with escalating disconnection for unregistered senders.
- MCA itself is investigating leakage of incorporation data.

### Cited Findings
- **Contact data in MCA filings.** DIR-2 (director consent) contains phone, email, address, date of birth and PAN, and becomes publicly inspectable once DIR-12 is filed.
- **DPDP exemption.** The DPDP Act excludes personal data that a person is "under a legal obligation" to make public. The authors suggest this exemption applies to the MCA filing itself. They recommend MCA mask DIR-2 data as it did members' data in April 2022.

— [Clasis Law, 13 Feb 2024](https://conventuslaw.com/report/india-directors-in-the-digital-age-managing-personal-information-of-directors/)
- **MCA's own public channels** (per an RTI reply) are the Monthly Information Bulletin (statistical) and the Master Data Service, which has director names and emails but **no phone numbers**. Inventiva infers that phone numbers reaching banks within hours must come from a non-public route, calling it "a leak". MCA has confirmed an internal investigation, with no findings published. — [Inventiva, 26 May 2026](https://www.inventiva.co.in/?p=439177)
- **DPDP timeline.** The rules were notified on 13 Nov 2025 (G.S.R. 843(E)) and commence in phases:
  - Board and definitions: 13 Nov 2025.
  - Section 6(9) (consent managers) and section 27(1)(d): 13 Nov 2026.
  - **All remaining provisions, including notice and consent obligations: 13 May 2027.**
  
  — [Wikipedia, DPDP Act 2023](https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Act,_2023)
- **DPDP penalties:** up to ₹250 Cr per category of failure. The Data Protection Board had not acted against any named bank as of May 2026. — [Inventiva, 26 May 2026](https://www.inventiva.co.in/?p=439181)
- **TRAI TCCCPR Second Amendment (12 Feb 2025):**
  - All commercial calls must come from designated series. Promotional voice calls, **including auto-dialler and robocalls, go only through the 140 series**; service and transactional robocalls go through the **1600 series**.
  - Promotional consent is collected through operators' Digital Consent Acquisition platforms.
  - Unregistered senders: a first violation bars **all** the sender's telecom resources for 15 days. A second violation disconnects them for 1 year, with blacklisting and device blocking.
  - Complaints must be filed within 7 days.
  - Call-management apps may not block the designated series.
  - In force 30 days (some clauses 60 days) after gazette publication.
  
  — [TRAI Regulation, 12 Feb 2025 (PDF)](https://www.trai.gov.in/sites/default/files/2025-02/Regulation_12022025.pdf)
- **TRAI Third Amendment (18 Sep 2026).** A further TCCCPR (Third Amendment) Regulations, 2026 was published on 18 Sep 2026. Its content was not retrieved: the PDF is over 10 MB. — [TRAI regulations list](https://www.trai.gov.in/release-publication/regulations)
- **MCA fraud advisory.** MCA warns of fraudulent calls, WhatsApp messages and emails impersonating MCA, RBI and the Income Tax department. It states it does **not** contact stakeholders by mobile call or WhatsApp about non-compliance or enforcement. — [TaxGuru, 5 Jul 2026](https://taxguru.in/company-law/beware-fraudulent-communications-impersonating-mca-officials.html)
- **Commercial availability of director contacts:**
  - InstaFinancials openly sells daily lists with director emails and mobiles, without stating a source or consent basis. — [InstaFinancials offer](https://contact.instafinancials.com/offers/companyfresh-diwali-25-offer)
  - Zauba scraper tools advertise exporting email and phone data. — [Chrome Web Store](https://chromewebstore.google.com/detail/ikcifjddojhekaegbjokknfnjmnjffap)
- **SolutionAI's existing design** already limits WhatsApp to opted-in contacts and AI calling to "TRAI-compliant registered channels only". In the UP pipeline, StartinUP email and phone fields were deliberately not captured, because they are hidden in the portal HTML. — [L3 report](file:///C:/Users/goura/Downloads/up-startup-intel/raw/L3_startinup/REPORT.md)

### Inferences
- **Lowest-risk contact path:** the company-level email, if present in MCA master data, together with emails and contact forms from the company website and domain. Treat these as business contacts, send relevant B2B email, and honour an easy opt-out. Director *personal* mobiles from purchased lists are the highest-risk input:
  - provenance is possibly leaked;
  - from 13 May 2027 they likely fall outside the DPDP public-data exemption once resold;
  - TRAI penalties apply to calls.
- **Calls and WhatsApp:**
  - AI voice calls for promotion must use a registered 140-series route via an operator's Digital Consent Acquisition flow, or happen only after inbound or opt-in.
  - WhatsApp marketing templates require opt-in under Meta policy.
  - Avoid "MCA"/"ROC"-style sender names and urgency language that echo the MCA impersonation scams in the advisory.
- **Timing.** The DPDP grace period ends on 13 May 2027, so any engine launched in late 2026 should already carry consent logging, notices and erasure flows.

### Gaps
- Content of the TRAI Third Amendment (18 Sep 2026).
- The exact DPDP Rules text on legitimate uses and B2B contacts.
- Whether the company email appears in V3 master data. An RTI cited by Inventiva says *director* emails are in the Master Data Service, which conflicts with the Razorpay guide listing no email field.
- No legal opinion on reselling MCA-derived personal data after DPDP.

---

## Q7. User sentiment (Reddit, LinkedIn, X, G2, Quora)

### Takeaway
Sentiment evidence is thin because of blocked sites and the exhausted search budget:
- Trustpilot shows polarised reviews and sales-pressure complaints for registration firms (IndiaFilings 2.8/5; Vakilsearch's rating suppressed over fake reviews).
- Vendor-reported ratings for Kylas are high (G2 4.7, Capterra 4.8).
- No Reddit, Quora or X threads were retrieved.

### Cited Findings
- **IndiaFilings:** Trustpilot 2.8/5 from 1,175 reviews. Complaints cover repeated calls before payment, dropping urgency after payment, and extra charges (Aug–Oct 2026). — [Trustpilot](https://www.trustpilot.com/review/indiafilings.com)
- **Vakilsearch:** Trustpilot score withheld for guideline breaches and fake reviews; 1,560 reviews with 29% 1-star. — [Trustpilot](https://www.trustpilot.com/review/vakilsearch.com)
- **Kylas:** 4.7/5 on G2 and 4.8/5 on Capterra, as self-reported on its pricing page. — [Kylas](https://kylas.io/pricing)
- **WATI:** a third-party audit criticises add-on costs (chatbot-session overages, seats) and an estimated 20% message markup. — [CodingClave](https://codingclave.com/blog/wati-pricing-india-2026)
- **AiSensy:** a competitor's comparison says AiSensy's contact-based tiers can turn a ₹2,399-a-month plan into ₹15,000+ a month at 5–10k contacts. This is a competitor claim, and AiSensy's current page advertises unlimited contacts under fair use. — [go4whatsup comparison (competitor)](https://www.go4whatsup.com/compare/best-aisensy-alternatives/index.html); [AiSensy pricing](https://aisensy.com/pricing)

### Inferences
- Founders' resentment is aimed at aggressive, unsolicited follow-up. That supports a differentiated, consent-first posture for SolutionAI's outreach.

### Gaps
- No Reddit (r/IndiaBusiness, r/StartUpIndia, r/IndiaInvestments, r/developersIndia), Quora, LinkedIn or X evidence was collected.
- G2 and Capterra pages for Tracxn, LeadSquared, Probe42 and Tofler returned 403 or 404.

---

## Q8. Founders' complaints of spam right after incorporation (evidence of leakage from MCA filings)

### Takeaway
There is consistent media evidence from 2012 to 2026 that founders get calls, emails, WhatsApp messages, visits and even unordered parcels within hours to days of incorporation:
- mostly from private banks pitching current accounts;
- also from compliance intermediaries and vendors of trademark, website and domain services;
- sometimes before the certificate of incorporation arrives.

MCA has an internal investigation open. No official finding names the channel.

### Cited Findings
- **Moneylife (2024 reporting).** Newly registered founders get a wave of calls, emails and WhatsApp messages, sometimes before MCA's confirmation. An ICICI Bank marketer said: "We receive this information from the back-end." Senior MCA officials were reportedly investigating. (Via search snippet; the page returned 403.) — [Moneylife](https://moneylife.in/article/congratulations-your-privacy-is-officially-compromised-with-no-remedy/71480.html)
- **Inventiva (26 May 2026):**
  - Calls arrive within 24 hours from IDFC First, HDFC, Kotak and Federal; nine banks are named.
  - A bank employee visited a founder's home with his PAN and Aadhaar visible on the employee's phone.
  - The certificate of incorporation typically arrives 1–2 days *after* the calls begin.
  - MCA's V3 portal runs on external vendor infrastructure, which the article presents as a plausible but unconfirmed leak route.
  - The DPDP Board, RBI, TRAI and MeitY have taken no public action.
  
  — [Inventiva](https://www.inventiva.co.in/?p=439177); [Inventiva companion piece](https://www.inventiva.co.in/?p=439181)
- **Moneylife (Jan 2024, older).** A security expert said an MCA vulnerability exposed personal data of about 9.8M Indians, including directors, and took "11 months and four days" to fix. (Via search snippet.) — [Moneylife](https://moneylife.in/article/mca-leaked-personal-data-of-indias-richest-people-and-company-directors-says-security-expert/73167.html)
- **Inventiva (19 Jun 2024, older).** Alleges MCA officials sell new-company directors' data to banks (ICICI, Axis, IDFC) and to trademark, website and domain vendors. These are allegations without documents. — [Inventiva](https://www.inventiva.co.in/?p=423955)
- **Citizen Matters (4 Jan 2012, older).** Newly registered companies received unordered "Legal Book Supplies" parcels demanding ₹2,300 cash on delivery: "It appears that MCA is leaking the addresses". — [Citizen Matters](https://citizenmatters.in/3701-if-you/)
- **Demand side.** InstaFinancials' daily new-company lists (director email and mobile, delivered before 10:30 AM) show a functioning commercial market for this data. — [InstaFinancials](https://contact.instafinancials.com/offers/companyfresh-diwali-25-offer)

### Inferences
- **Two leakage channels are plausible:**
  - lawful-but-intrusive extraction from public documents (DIR-2 phone and email);
  - non-public leakage, suggested by same-day calls before the certificate is issued and by phones absent from the Master Data Service.
  
  Either way, list-based cold calling of brand-new founders is saturated and resented. Banks call within 24 hours.
- **Positioning:** SolutionAI should not compete on speed of cold calls. It should compete on relevance: grant matching, compliance calendars tied to incorporation date (from the CIN), and value-first email.

### Gaps
- No primary MCA statement or RTI document was fetched; the RTI is known only via Inventiva.
- The Moneylife articles were not readable directly (403).
- No Reddit or LinkedIn founder posts were retrieved to quantify how widespread this is.
