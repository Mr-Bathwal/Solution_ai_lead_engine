# Voice AI Calling Platforms and Voice-Agent Stacks for Hindi/English/Hinglish Outbound Lead Qualification (India focus)

Research date: 24 Oct 2026. Pricing pages that carry no effective date are marked "page as fetched 24 Oct 2026". Vendor-authored comparisons are flagged as such. The web-search budget ran out partway through, so a few items (Sarvam "Samvaad" branding, Haptik, Deepgram Flux, ElevenLabs India telephony) could not be checked. They are listed under Gaps.

---

## 1. Platform landscape: who does what (global and India)

### Takeaway
The market splits into three layers: (a) **orchestration/"agent" platforms** that bundle STT→LLM→TTS plus telephony (Vapi, Retell, Bland, Synthflow, ElevenLabs Agents, Deepgram Voice Agent, Sarvam voice agents, Bolna, Ringg, Gnani, Smallest Atoms); (b) **open-source frameworks** you self-host (LiveKit Agents, Pipecat); (c) **model/infra vendors** (OpenAI Realtime, Cartesia, Deepgram, ElevenLabs, Sarvam, Smallest, Google, Azure) plus **Indian CPaaS/telephony** (Exotel, Plivo, Ozonetel, Knowlarity, Vobiz). For Hindi/Hinglish calls over Indian PSTN, the Indian-built models (Sarvam Saaras/Bulbul; Smallest Lightning) and India-native telephony (Exotel/Plivo/Vobiz) are the practical core. Global orchestrators are usable mainly with BYO Indian telephony and Indic STT/TTS plugged in.

### Cited Findings

**Global orchestration platforms**
- **Vapi**: developer platform. $0.05/min hosting fee, plus provider costs at cost (Deepgram STT ~$0.0095–0.0099/min, OpenAI LLM ~$0.0077–0.0452/min, ElevenLabs voice ~$0.0146–0.0238/min). Vapi telephony/SIP/WebSocket transport is free. Vapi's own estimate for 1,000 min/mo is $82–129. Free tier allows 4 concurrent calls, extra lines cost $10/month each, and HIPAA is $2,000/month (page as fetched 24 Oct 2026) — [Vapi pricing](https://vapi.ai/pricing)
- Vapi scale (May 2026): >1M developers, >2.7M agents, >1B calls. Amazon Ring is cited as running 100% of inbound volume on Vapi (customer claim) — [SiliconANGLE, 12 May 2026](https://siliconangle.com/2026/05/12/vapi-nabs-50m-make-voice-ai-human/)
- **Retell AI**: pay-as-you-go headline $0.07–0.31/min. Voice infra is $0.055/min, and a sample config totals $0.11/min (LLM $0.04 + infra $0.055 + TTS $0.015). TTS options: platform/Cartesia/OpenAI/Minimax voices $0.015/min, ElevenLabs Flash $0.04, ElevenLabs Multilingual v2 $0.06, ElevenLabs v3 $0.10. Telephony is $0.015/min (India listed via Twilio/Telnyx); SIP/BYO telephony is free. 20 concurrent calls are included, then $8 per extra concurrent call/month. Add-ons: Branded Call $0.10/outbound call, batch call $0.005/dial, PII removal $0.01/min. The page lists **no Hindi language support** (page as fetched 24 Oct 2026) — [Retell pricing](https://www.retellai.com/pricing)
- **Bland AI**: Start plan $0/month at $0.14/min talk time (10 concurrent, 100 calls/day cap). Build plan $299/month at $0.12/min (50 concurrent, 2,000/day). Transfer time costs $0.04–0.05/min. The per-minute rate bundles LLM+STT+TTS, and telephony is extra (built-in Twilio at pass-through). No India notes (page as fetched 24 Oct 2026) — [Bland pricing](https://www.bland.ai/pricing)
- **Synthflow**: no-code. Pay-as-you-go from ~$0.08/min; enterprise contracts from ~$30,000/yr; old monthly bundles discontinued (third-party guide, Jul 2026) — [Layer3Labs Synthflow pricing guide](https://www.layer3labs.io/guides/synthflow-pricing); summarised in [Morph comparison](https://www.morphllm.com/comparisons/vapi-vs-retell-vs-bland-vs-synthflow)
- **ElevenLabs Agents ("Speech Engine")**: $0.08/min plus LLM usage. Burst above the concurrency limit costs $0.16/min. Plans include 15–12,375 minutes and 4–40 concurrent calls. Realtime v1 Mini tokens are $0.20/1M input and $6/1M output. Scribe v2 Realtime STT is $0.39/hour. Flash TTS is $0.04/1K chars at ~75 ms across 32 languages (page as fetched 24 Oct 2026) — [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)
- **OpenAI Realtime (gpt-realtime)**: audio tokens $32/1M input and $64/1M output (cached audio input $0.40/1M). Supports WebRTC, WebSocket and **SIP** — [OpenAI gpt-realtime model page](https://developers.openai.com/api/docs/models/gpt-realtime). A third-party estimate (Oct 2026) puts the realtime model alone at ~$0.05–0.10 per conversational minute and OpenAI Realtime + LiveKit all-in at $0.08–0.25/min — [Forasoft production guide, 22 Oct 2026](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026). Retell resells GPT Realtime at $0.345/min and Realtime mini at $0.07/min as the LLM line item — [Retell pricing](https://www.retellai.com/pricing)
- **Deepgram Voice Agent API**: its marketing page still says "$4.50/hour" — [Deepgram voice AI platform](https://deepgram.com/voice-ai-platform). A pricing change log says it moved to per-minute pricing in 2025: Standard $0.08/min PAYG ($0.07 on Growth), Advanced $0.16/$0.15 — [PricingSaaS diff 2025Q3](https://pricingsaas.com/companies/deepgram/diffs/2025Q3). A Sept 2026 guide gives a $0.050–0.163/min range, with BYO LLM+TTS at $0.05/min PAYG and $0.041 on Growth. Nova-3 streaming STT is $0.0077/min ($0.0048 promo) and Aura-2 TTS $0.030/1K chars — [Cekura on Deepgram pricing, 18 Sep 2026](https://www.cekura.ai/blogs/deepgram-pricing). Sources conflict, so verify directly.
- **Hume EVI**: English-first speech-to-speech. Overage is reported at $0.04–0.07/min, and EVI 4 Mini at $0.02–0.035/min since June 2026 (third-party, Jul 2026) — [Dupple Hume review](https://dupple.com/reviews/hume). An older 2025 guide says $0.06/min overage on Pro — [eesel Hume pricing](https://www.eesel.ai/blog/hume-ai-pricing). EVI 3 is described as supporting ~11 languages and optimised for English (same sources). No evidence of production Hindi telephony use.
- **Cartesia (Sonic)**: Sonic-3 supports 42 languages with emotion/laughter controls. Sonic-3.5 is reported #1 on the Artificial Analysis Speech Arena (May/June 2026; dates conflict across sources). Hindi support was **not confirmed** in the sources found — [AIWiki Cartesia](https://www.aiwiki.ai/wiki/cartesia). Claimed TTFB is ~90 ms with no public test conditions — [Dograh TTFB roundup, 18 Aug 2026](https://www.dograh.com/feeds/blog/tts-time-first-byte)

**Open-source frameworks**
- **LiveKit Agents**: open framework for building and deploying voice agents, launched alongside LiveKit's April 2025 Series B. It partnered with OpenAI on the Realtime API launch (Oct 2024) — [Unite.ai](https://www.unite.ai/livekit-reaches-1-billion-valuation-as-voice-ai-infrastructure-heats-up/). Its audio turn detector supports **Hindi** among 14 languages (see §2) — [LiveKit turn detector docs](https://docs.livekit.io/agents/logic/turns/turn-detector)
- **Pipecat (Daily)**: BSD-2 open-source Python framework (~16.8k GitHub stars), maintained by Daily and the community. It lists **Sarvam** (STT/TTS/LLM) and **Smallest** (TTS) as services, and speech-to-speech options OpenAI Realtime, Gemini Live, AWS Nova Sonic, Azure Voice Live, Grok, Ultravox. It ships telephony serializers for **Twilio, Plivo, Exotel**, Telnyx, Vonage, Genesys (page as fetched 24 Oct 2026) — [Pipecat GitHub](https://github.com/pipecat-ai/pipecat)

**India-native platforms**
- **Sarvam AI voice agents**: end-to-end per-minute pricing that includes STT, LLM and TTS ("no separate model or token charge"). Covers 11 Indian languages plus English, and handles code-mixed speech. BYO telephony is supported for Exotel, Smartflo, Plivo, Twilio, Vobiz, InTalk and Pulse, with custom SIP on Business/Enterprise. Sarvam's own telephony runs via **Vobiz** — [Sarvam voice-agent pricing docs](https://docs.sarvam.ai/voice-agents/pricing). Models: **Saaras V4** STT (released 25 Sep 2026) — [Sarvam blog](https://www.sarvam.ai/blogs/introducing-saaras-v4); **Bulbul V3** TTS (7 Feb 2026, 11 languages, 35+ voices) — [Sarvam Bulbul V3 blog](https://www.sarvam.ai/blogs/bulbul-v3)
- **Bolna** (Bengaluru, founded 2024, YC): self-serve voice-agent orchestration, 10+ Indian languages — [Bolna press release](https://www.bolna.ai/newsroom/enterprise-voice-ai-startup-bolna-bags-63-million-seed-funding-led-by-general-catalyst). It integrates Sarvam STT (saarika/saaras v2.5) and Sarvam TTS as providers — [Bolna docs: Sarvam STT](https://www.bolna.ai/docs/providers/transcriber/sarvam). Reported at >200,000 calls/day and >1,050 paying customers (secondary summary of Inc42; lower confidence) — [LetsDataScience](https://letsdatascience.com/news/bolna-raises-63m-seed-to-expand-voiceai-937001e5)
- **Gnani.ai (Inya)**: founded 2016. Launched **Inya VoiceOS**, a 5B-parameter voice-to-voice "sovereign" model (research preview ahead of a 14B flagship), at the AI Impact Summit 2026. Claims 200+ enterprise clients and >30M voice interactions/day in 12+ languages, and was selected under the IndiaAI Mission — [Inc42](https://inc42.com/buzz/gnani-ai-raises-10-mn-to-build-sovereign-ai-voice-agents/), [Outlook Business](https://www.outlookbusiness.com/corporate/gnaniai-raises-10-mn-in-first-tranche-of-funding-round-led-by-aavishkaar-capital). Claims >80% gross margin from building orchestration, denoising and turn-taking in-house — [Inc42 unit economics, 15 Jul 2026](https://inc42.com/features/the-unit-economics-of-indias-voice-ai-boom/)
- **Ringg AI** (Bengaluru): voice, WhatsApp and browser agents in 18 languages including 10 Indian. Customers cited include Policybazaar, CRED, Flipkart, Groww, Practo — [YourStory, Aug 2026](https://yourstory.com/2026/08/voice-ai-startup-ringg-ai-raises-10m-series-a-peak-xv-partners), [Inc42](https://inc42.com/?p=545709)
- **Smallest.ai**: Lightning v3.1 TTS covers 12 languages (English, Hindi + 9 Indian). Lightning v3.1 Pro adds English+Hindi **code-switching**; Lightning v2 is deprecated — [Smallest docs](https://docs.smallest.ai/waves/documentation/getting-started/models). It also runs the Atoms agent platform, and its STT is marketed as optimised for Indian accents and Hinglish (vendor claim) — [AWS Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-5het7at3rymmy)
- **Exotel**: launched **AgentStream**, a real-time streaming layer connecting AI voice bots over PSTN, WhatsApp, in-app and WebRTC, claiming "sub-20ms latency vs 150ms industry standard" (vendor claim; launch date not found) — [Exotel newsroom](https://exotel.com/newsroom/exotel-launches-indias-first-agent-streaming-platform-for-voice-ai/). In Aug 2026 it announced "India's first AI-initiated CX call" built via its MCP framework; listed use cases include **sales outreach** — [Exotel newsroom](https://exotel.com/newsroom/exotel-powers-indias-first-fully-agentic-ai-voice-call/). A reseller listing says the voicebot handles Hindi, English and Hinglish — [SoftwareOne listing](https://platform.softwareone.com/product/ai-voicebot/PCP-8909-9402)
- **Ozonetel**: agentic voicebot covering 10+ Indian languages (vendor claim) — [Ozonetel AI](https://ozonetel.com/ai/). Integrated with ElevenLabs Agents for inbound and outbound calls in India — [ElevenLabs × Ozonetel integration](https://elevenlabs.io/agents/integrations/ozonetel)
- **Knowlarity / Exotel / Ozonetel** are categorised as cloud-telephony "infrastructure layers" rather than voice-AI platforms (vendor-authored buyer guide, Jul 2026). The same guide rates Knowlarity G2 4.1/5 (22 reviews) — [Caller.Digital](https://caller.digital/blog/voice-ai-vs-exotel-knowlarity-ozonetel-india-2026)
- **Google / Azure Indic voices**: Google Chirp 3 HD costs US$30 per 1M characters — [Google TTS pricing](https://cloud.google.com/text-to-speech/pricing/?authuser=2). Azure standard neural is ~$15/1M chars per third-party sources; the official HD-voice rate was not retrieved — [Azure speech pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/). A Smallest-authored comparison (12 Oct 2026) says Google and Azure have the widest range of Indian locales but presents no measured quality data — [Smallest blog](https://smallest.ai/blog/hindi-tts-apis-6-vendors-compared-for-indian-language-quality)

**Comparison table (prices from pages fetched 24 Oct 2026 unless dated otherwise)**

| Platform | Type | Headline price | Hindi/Hinglish | Indian telephony path |
|---|---|---|---|---|
| Sarvam voice agents | IN, managed, all-in | ₹3.00–3.50/min + telephony (Vobiz ₹0.20/30s) | Native, 11 Indic + EN, code-mix | Vobiz, Exotel, Plivo, Smartflo, SIP |
| Bolna | IN, orchestration | ~$0.05–0.10/min bundles; ~₹5.5 self-serve, ₹1.75–2 enterprise (Inc42, Jul 2026) | 10+ Indic, uses Sarvam etc. | Exotel/Plivo/Twilio (provider rates) |
| Ringg / Gnani / Smallest Atoms | IN, managed/enterprise | Not published | 10–12+ Indic | Enterprise integrations |
| Vapi | Global, dev orchestration | $0.05/min + pass-through (~$0.08–0.13/min est.) | Via plug-in STT/TTS | BYO SIP/Exotel/Plivo |
| Retell | Global, orchestration | $0.07–0.31/min (sample $0.11) | Not listed on pricing page | Twilio/Telnyx or BYO SIP |
| Bland | Global, managed | $0.12–0.14/min + telephony | Not stated | BYO telephony |
| Synthflow | Global, no-code | from ~$0.08/min | Not stated | Not stated |
| ElevenLabs Agents | Global, model+platform | $0.08/min + LLM | Hindi voices (Multilingual) | Via Ozonetel integration, SIP |
| OpenAI Realtime | S2S model | ~$0.05–0.10/min model only | Not assessed | SIP endpoint |
| Deepgram Voice Agent | Global, model+platform | $0.05–0.163/min | Not assessed | BYO |
| LiveKit / Pipecat | OSS frameworks | Infra + model costs | Plug Sarvam/Smallest | Pipecat: Exotel, Plivo, Twilio serializers |

### Inferences
- For a Hindi/Hinglish outbound engine, Sarvam's all-in agent product (or Bolna/LiveKit/Pipecat wired to Sarvam/Smallest models and Exotel/Plivo/Vobiz telephony) is the lowest-friction stack. Retell/Bland/Synthflow do not advertise Hindi on their pricing pages, and their default telephony (Twilio) cannot originate from Indian numbers (see §4).
- Pipecat's native Exotel/Plivo serializers and Sarvam/Smallest services make it the most India-ready open-source path. LiveKit is a close alternative and adds a Hindi-capable turn detector.

### Gaps
- Could not verify the "Samvaad" product name for Sarvam's agent platform (search budget exhausted). The docs describe it only as "Sarvam voice agents".
- No information found on Haptik's (Jio) voice-bot offering, or on Servetel/Knowlarity AI-calling products beyond telephony.
- No published per-minute pricing found for Gnani, Ringg or Smallest Atoms.
- Cartesia Hindi support unconfirmed. ElevenLabs India-specific telephony beyond the Ozonetel integration not checked.

---

## 2. Architecture: cascaded vs speech-to-speech, latency, turn-taking, barge-in, voicemail detection

### Takeaway
Most production agents are still **cascaded** (streaming STT → LLM → streaming TTS) because it gives control, cloned/Indic voices, transcripts and tool reliability. **Speech-to-speech** (OpenAI Realtime, Gnani Inya VoiceOS, Hume EVI) cuts latency to ~0.8 s but limits voices and control. Real-world end-to-end latency is ~0.9–1.5 s for cascaded stacks; the ~800 ms target is reachable only with streaming at every hop and tight endpointing. Most "slow agent" complaints trace back to **turn-detection/endpointing waits and oversized prompts**, not model speed.

### Cited Findings
**Latency figures**
- Vendor guide target: ~800 ms end-to-end, split STT 50–150 ms, LLM 200–400 ms, TTS first audio 100–200 ms, network 20–80 ms (vendor-authored) — [Smallest.ai blog](https://smallest.ai/blog/neural-tts-latency-explained-how-to-build-faster-ai-voice-agents)
- Daily's engineering team (as quoted, Aug 2026) gives a P50 budget of ~400 ms turn detection + transcription, ~500 ms LLM, ~200 ms TTS and ~200 ms network, roughly 1.3 s before the caller hears anything — [Dograh, 18 Aug 2026](https://www.dograh.com/feeds/blog/tts-time-first-byte)
- Coval's guide puts typical cascaded pipelines at ~1,400–2,600 ms, with the LLM the largest share — [Coval latency guide](https://www.coval.dev/blog/how-to-measure-voice-ai-latency-the-complete-guide)
- Oct 2026 production guide: OpenAI Realtime speech-to-speech ~800 ms voice-to-voice ("achievable, not free"; rises in long sessions); chained STT→LLM→TTS 1.0–1.5 s; **Vapi and Retell 900–1,100 ms**. Proxying the realtime WebSocket through your own server adds 80–150 ms. Tool-call accuracy of the realtime model is "a touch below" text-tuned models. Custom voices are gated by OpenAI approval and a speaker-consent recording — [Forasoft, 22 Oct 2026](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026)
- Practitioner reports show the gap between component and end-to-end latency. One LiveKit user measured <1 s ASR+LLM+TTS but 3–4 s from end of speech to reply, traced to endpointing/delivery — [LiveKit community](https://community.livekit.io/t/high-end-to-end-latency-asr-llm-tts-total-1s-but-speech-end-to-reply-takes-3-4s-livekit-agents/1277). A Vapi user's dashboard showed 575–1,000 ms but live calls took 3–4 s, sometimes 6–7 s — [Vapi support](https://support.vapi.ai/t/27532450/high-latency-problem-in-vapi-what-could-be-the-reason)
- Vapi's default `onNoPunctuationSeconds` = 1.5 s is called out as a major hidden latency cost (practitioner claim) — [Skool post](https://www.skool.com/voice-ai-wrapper-academy-3838/the-1500ms-vapi-default-eating-your-latency-budget-and-a-few-other-things-worth-knowing). A Sept 2026 guide says delays usually come from configured waits and prompt size rather than the model — [Macha](https://www.getmacha.com/blog/voice-ai-agent-latency)

**TTS time-to-first-audio**
- Coval streaming TTS benchmark (23 Jul 2026): median TTFA across all models is **519 ms**; ElevenLabs Flash v2.5 202 ms; Inworld TTS-2 196 ms; Palabra 103 ms. Sarvam/Smallest/Cartesia figures were not in the article — [Coval TTS benchmark](https://www.coval.ai/blog/tts-latency-benchmark-2026/)
- Vendor TTFB claims: ElevenLabs Flash ~75 ms (excludes network), Cartesia Sonic 3.5 ~90 ms, Deepgram Aura-2 sub-200 ms, Rime ~175 ms; voice agents need ≲200 ms TTFB — [Dograh](https://www.dograh.com/feeds/blog/tts-time-first-byte). Smallest Lightning v3.1 is ~200 ms TTFB per a 2026 Smallest-authored comparison — [Smallest 2026 TTS ranking](https://smallest.ai/hi/blog/top-fastest-text-to-speech-apis-in-2026) — versus an older (Dec 2024) "sub-100 ms" claim — [Smallest vs Sarvam blog, Dec 2024](https://smallest.ai/blog/smallest-ai-vs-sarvam-ai)
- Sarvam Saaras V4 STT streams with time-to-first-token <150 ms — [Sarvam Saaras V4](https://www.sarvam.ai/blogs/introducing-saaras-v4)

**Turn-taking and barge-in**
- LiveKit's audio turn detector adds semantic and acoustic signals (wording, intonation, pitch) on top of VAD. It supports 14 languages **including Hindi**, and with it endpointing defaults tighten from 0.5 s/3.0 s (min/max delay) to 0.3 s/2.5 s. On the older text detector, Hindi true-negative rate (correctly waiting while the user continues) was 96.3% vs 87.0% for English, at 50–160 ms CPU inference. v1-mini runs free on CPU — [LiveKit turn-detector docs](https://docs.livekit.io/agents/logic/turns/turn-detector)
- Barge-in (user interrupting the agent) is a first-class feature in LiveKit; Pipecat implements it with upstream cancel frames — [LiveKit blog](https://livekit.com/blog/turn-detection-and-interruption-handling), [Trae learn guide](https://learn.traeai.com/t/ai-engineering/phases/14-agent-engineering/22-voice-agents-pipecat-livekit)
- Self-published turn-detector benchmarks: TurnWave reports LiveKit v1 at 9.9% false cut-offs at 300 ms vs Pipecat SmartTurn v3.2 at 35.2%; voxturn reports 16.7% vs Smart Turn v3 45.3% (English, unverified, setups differ) — [TurnWave card](https://huggingface.co/Nikhil-09/turnwave), [voxturn card](https://huggingface.co/AustinXiao/voxturn)

**Voicemail / answering-machine detection (AMD)**
- Retell (16 Oct 2026): separate voicemail and IVR detectors run on outbound calls only, within a fixed, non-configurable **3-minute** window. Options are hang up or leave a static/LLM-generated message; the agent waits for the greeting to end. No accuracy figures given — [Retell AMD blog](https://www.retellai.com/blog/answering-machine-detection)
- Vendor-published AMD accuracies range 94.7–98.5% on each vendor's own audio, with verdict times of 840 ms–30 s. A missed voicemail means pitching a recording; a false positive hangs up on a live human — [Cekura AMD guide](https://www.cekura.ai/blogs/voicemail-detection)
- Vapi relies on Twilio-based detection (e.g., `machineDetectionTimeout: 15`) and support staff said there is "no native solution" to tell AI/automated answerers from humans — [Vapi support](https://support.vapi.ai/t/33128269/effective-detection-for-automated-voice-assistant-urgent), [Vapi docs PR](https://github.com/VapiAI/docs/pull/361/files)

### Inferences
- For Hindi sales calls, a cascaded stack is the safer default: Indic-specialist STT/TTS (Saaras, Bulbul, Lightning) are only available as separate components, and lead-qualification needs reliable tool calls (CRM writes, slot capture). Gnani's Inya VoiceOS is the only Indic speech-to-speech model found, and it is a research preview.
- Hosting the agent in an Indian region near the telephony POP (Exotel/Plivo/Vobiz in India) avoids two international round trips. This is inferred from the 200 ms network share in Daily's budget.
- Indian mobile networks often deliver voicemail as operator messages ("switched off/not reachable") rather than personal voicemail. AMD tuned on US greetings may need re-tuning (inference; no India-specific AMD data found).

### Gaps
- No neutral, reproducible end-to-end latency benchmark across Vapi/Retell/LiveKit/Pipecat found. Cekura's benchmark site (benchmarks.cekura.ai) exists, but its numbers were not retrievable.
- Deepgram Flux (conversational STT with built-in end-of-turn) not researched; search budget was exhausted.
- No India-specific AMD accuracy data.

---

## 3. Indic language quality: Hindi / Hinglish / code-mixed STT and TTS

### Takeaway
On Hindi STT, Sarvam Saaras (v3/v4) and the open Tara model lead on Vistaar (~12% mean WER). ElevenLabs Scribe v2 is close on clean read speech but much worse on **telephony and spontaneous** Hindi (GramVaani ~27%, IndicVoices ~27% vs ~15–23% for Sarvam), and strongest on read Hinglish. On TTS, Sarvam's Bulbul V3 wins listener preference on **8 kHz telephony audio**, while ElevenLabs v3 wins on studio-quality audio. Independent benchmarks are scarce, and most numbers are vendor-run.

### Cited Findings
- **Vistaar (2023 baseline, dated)**: Hindi average WER was Google STT ~23.9, Azure 20.0, IndicWhisper 13.6, before current models — [Vistaar paper, arXiv 2305.15386](https://arxiv.org/pdf/2305.15386)
- **Sarvam Saarika v2.5** (now deprecated): Hindi WER 11.81% on Vistaar. Docs point to Saaras v3/v4 as successors — [Sarvam Saarika docs](https://docs.sarvam.ai/api/getting-started/models/saarika/llms.txt)
- **Tara model card (Trelis, 2026)** says "commercial-system results are measured by us under the same protocol," i.e. not vendor-reported. Normalisation: NFC, punctuation removed, clips ≤30 s.

  | Dataset (WER ↓) | Tara | Sarvam Saaras-v3 | ElevenLabs Scribe-v2 |
  |---|---|---|---|
  | Vistaar Hindi mean (7 sets) | 12.06 | 12.32 | 13.79 |
  | GramVaani (telephony) | 21.03 | 23.00 | 26.94 |
  | IndicVoices-500 (spontaneous) | 16.51 | 15.29 | 27.46 |
  | CoSHE-500 (conversational Hinglish) | 14.41 | 11.25 | 12.40 |
  | Code-Switch FLEURS hi-en (read) | 8.37 | 16.47 | 7.57 |
  | FLEURS-en | 4.55 | 4.36 | 2.93 |
  — [Trelis/tara on Hugging Face](https://huggingface.co/Trelis/tara). Deepgram, GPT-4o-transcribe and Gemini were not included.
- **Saaras V4** (25 Sep 2026): language-ID error 5.22% across 22 Indian languages (2.9% for the top 10) on IndicVoices. "Codemix" mode keeps English words in Latin script and the rest in native script; "Translit" mode outputs fully Romanised ("WhatsApp language"). The blog gives no Hindi WER numbers in text — [Sarvam Saaras V4](https://www.sarvam.ai/blogs/introducing-saaras-v4)
- **Vendor-reported dialect WER** (Caller.Digital, 10 Jul 2026, self-ranked first, no methodology): Sarvam Delhi Hindi 7–9% / Bhojpuri 9–12%; Bolna 9–11% / 15–18%; Gnani 8–10% / 11–13%; global vendors (ElevenLabs, Vapi, Retell, Bland) 18–28% "on the same audio sets" — [Caller.Digital](https://caller.digital/blog/best-hindi-voice-ai-agent-platform-india-2026). Treat as marketing.
- **Bulbul V3 TTS** (7 Feb 2026) was evaluated in a blind A/B test by **Josh Talks**: 11 languages, 500+ annotators, 20,000+ votes, full-band and 8 kHz telephony conditions. Bulbul V3 ranked top in 8 kHz telephony; ElevenLabs v3 alpha led on full-band audio quality. Sarvam claims lowest CER on numerics, code-mixing and named entities, but publishes no CER values — [Sarvam Bulbul V3 blog](https://www.sarvam.ai/blogs/bulbul-v3). Reported 8 kHz win rates for Bulbul V3: 77.95% vs ElevenLabs Flash v2.5, 43.64% vs ElevenLabs v3 alpha, 40.08% vs Cartesia Sonic-3 (remainder = losses or ties; from Sarvam's table as summarised in search results) — [Sarvam TTS page](https://www.sarvam.ai/text-to-speech)
- Bulbul pricing: v3 ₹30/10K characters (beta), v2 ₹15/10K characters — [Sarvam API pricing](https://docs.sarvam.ai/api-reference-docs/pricing)
- Developer complaint on Retell's forum: Hindi "pronunciation, understanding numbers" was "not satisfactory" with default providers; the developer asked for Sarvam integration — [Retell community](https://community.retellai.com/t/integration-of-indian-language-based-tts-and-stt-providers-like-sarvam-ai/2856)
- Smallest Lightning v3.1 Pro supports English+Hindi code-switching — [Smallest docs](https://docs.smallest.ai/waves/documentation/getting-started/models). A Smallest-authored 6-vendor Hindi TTS comparison (12 Oct 2026) presents **no measured MOS/CER/latency**. It advises testing Hindi with English terms, Romanised Hinglish and mixed numbers/dates — [Smallest blog](https://smallest.ai/blog/hindi-tts-apis-6-vendors-compared-for-indian-language-quality)
- One vendor guide warns that a vendor demoing "clean Delhi Hindi on a clean laptop browser may fail entirely on Bhojpuri-Hindi audio". It recommends tests on real phone-line audio, dialect-specific WER, and a bot-detection test: if 4 of 5 listeners identify a 90-s TTS sample as AI within 10 s, it is not production-ready — [Caller.Digital](https://caller.digital/blog/best-hindi-voice-ai-agent-platform-india-2026)

### Inferences
- Telephony audio (8 kHz, noisy, spontaneous) is where global models degrade most: Scribe goes from ~13.8 WER on Vistaar to ~27 on GramVaani and IndicVoices. Benchmark choice should weight GramVaani and IndicVoices over clean read sets.
- For Hinglish, no single STT wins everywhere. Sarvam leads on conversational code-mix (CoSHE), ElevenLabs on read code-mix. A/B test on SolutionAI's own recorded calls with founders/MSME owners.
- For TTS on PSTN, Bulbul V3 is the evidence-backed default. ElevenLabs is a candidate where audio is wideband (WebRTC/WhatsApp calls).

### Gaps
- No independent Hindi WER for Deepgram Nova-3 or GPT-4o-transcribe on Vistaar/IndicVoices found.
- No independent MOS/CER numbers for Hindi TTS; the Josh Talks report itself was not located.
- No public Hindi accuracy data for Gnani, Ringg, Bolna's own models, Google Chirp 3 or Azure HD voices.

---

## 4. Telephony in India: SIP, numbers, number series, practical constraints

### Takeaway
You cannot run a compliant Indian outbound AI campaign on Twilio-style global telephony. Twilio only allows calls **to** India from **non-Indian** numbers, and several global vendors withdrew Indian-number outbound in Aug 2024. Practical stacks use Indian CPaaS (Exotel, Plivo India, Vobiz, Ozonetel, Knowlarity, Tata Smartflo). Promotional calls go on registered **140-series** headers via DLT, and service/transactional calls on **1600-series** (regulated entities). Since Sept 2026, TRAI treats software-initiated (AI) calls as A2P calls that must be registered in advance or be treated as spam.

### Cited Findings
- Twilio India guidelines: "outbound calls to India can only be made from non-Indian numbers". Voice OTP is not permitted, and "high volumes of short-duration calls may trigger automated carrier blocks". Without consent, TRAI treats commercial calls as UCC, which can lead to blocking or account termination — [Twilio India voice guidelines](https://www.twilio.com/en-us/guidelines/in/voice)
- Talkdesk: from 1 Aug 2024, no domestic outbound calls from existing Indian numbers (including toll-free) for regulatory reasons — [Talkdesk notice](https://support.talkdesk.com/hc/en-us/articles/27625422599067--Archive-Product-Notice-Changes-to-Domestic-Outbound-Calls-from-Indian-Numbers-Effective-Aug-1-2024). Outreach also ended +91 outbound on 1 Aug 2024 — [Outreach support](https://support.outreach.io/hc/en-us/articles/16200555167515)
- Vapi community advice: Twilio doesn't provide Indian numbers for this use; use Exotel or Plivo for better local deliverability — [Vapi support thread](https://support.vapi.ai/t/33237506/indian-number-outbound-calling-us-twilio-number-sufficient)
- Twilio status page logged an incident on 10 Mar 2026 where India customers received SIP 480 on outbound calls — [Twilio status](https://status.twilio.com/incidents/wp8x2xwkz4tm)
- **140-series provisioning (Plivo)**: promotional calls only, with explicit digital consent held by the Principal Entity. The Telemarketer must be registered in **Mumbai or Karnataka**, and only **Tata DLT** is supported. Requires GST registration, an Aggregator Telemarketer Declaration, and a per-number NOC. Steps run DLT registration (2–3 days) → number + NOC (1–2) → voice header approval (1–2) → voice template (1); **~5–10 business days total**. Consent records must be timestamped — [Plivo 140-series docs](https://plivo.com/docs/voice/concepts/140-series-provisioning)
- **1600 series**: for service/transactional calls by RBI/SEBI/IRDAI/PFRDA-regulated entities and government. Apps may not tag or block these (TRAI clarification reported 10 Jul 2026). Some telephony bills in 60-second pulses, and some platforms charge per dial attempt (vendor guide, 10 Sep 2026) — [Edesy guide](https://edesy.in/blog/ai-outbound-calling-india-guide-2026)
- **TRAI, Sept 2026**: all software-initiated calls (robocalls, prerecorded, AI) are classified as **A2P**. Businesses must register these numbers with operators in advance or calls are auto-classified as spam. Operators may charge up to **5 paise/min** A2P termination. Caller-ID apps must share user spam flags with operators via a blockchain platform, which Truecaller calls "anti-competitive" — [NokiaMob, 19 Sep 2026](https://nokiamob.net/2026/09/19/indias-telecom-regulator-targets-ai-robocalls-and-caller-id-apps/) (regulatory detail is covered by the other researcher)
- Sarvam telephony via Vobiz: ₹0.20 per 30-s pulse (≈₹0.40/min); forwarding to PSTN ₹0.40/pulse, to SIP ₹0.35/pulse; number rental ₹59/30 days. Unanswered, busy and failed calls are not charged on the agent side — [Sarvam voice-agent pricing](https://docs.sarvam.ai/voice-agents/pricing)
- Exotel telephony is listed "starting at INR 0.50/min for Indian calls" by a third-party reseller (unverified) — [Edesy Exotel page](https://edesy.in/ai-voice-agent/providers/exotel)
- Bolna's agent API assumes Exotel/Plivo rather than Twilio for India (vendor commentary) — [Caller.Digital Retell alternatives](https://caller.digital/blog/retell-ai-alternatives-india-2026)

### Inferences
- SolutionAI's outbound calls to newly registered startups/MSMEs are promotional unless there is an existing relationship. That means a 140-series header via a DLT-registered telemarketer (or partnering with one), recipients' DND preferences honoured, and consent stored. Calling from a +1/foreign CLI would likely hurt answer rates and invite spam flags.
- Budget ~2 weeks for DLT/140-series onboarding before the first live campaign. Choose a CPaaS that natively streams audio to your agent (Exotel AgentStream, Plivo, Vobiz) to avoid an extra hop.
- 60-second pulse billing vs 30-second pulses (Vobiz) materially changes the cost of short qualification calls.

### Gaps
- Could not verify Exotel's or Knowlarity's official per-minute outbound rates or 140-series provisioning terms.
- Unclear whether TRAI's A2P rule applies on top of 140-series headers or replaces any part of them; deferred to the regulation researcher.

---

## 5. Pricing per minute and total cost per qualified conversation

### Takeaway
All-in costs in India run roughly **₹2–6/min** for India-native platforms (Sarvam ₹3.00–3.50 + ~₹0.40 telephony; Bolna ~₹5.5 self-serve, ₹1.75–2 at enterprise volume). Global platforms land at roughly **$0.08–0.31/min (≈₹7–27)**. Human callers cost ~₹7–8/min. At ~2.5-minute connected calls and a 10–20% qualification rate, a qualified conversation would cost roughly ₹60–150 on an Indian stack (model below, assumptions flagged).

### Cited Findings
- Sarvam voice agents (excl. GST, telephony extra): PAYG **₹3.50/min** (<3,000 min/mo); Pro ₹3.25 (₹9,999/mo fee); Growth ₹3.15 (₹49,999/mo); Business ₹3.00 (₹1,99,999/mo, 65k–2 lakh min); Enterprise custom above 2 lakh min/mo. Billed per 60-s minute rounded up; simulated test runs ₹2 each — [Sarvam pricing](https://docs.sarvam.ai/voice-agents/pricing). The Saaras V4 blog says agents cost "as low as ₹3 a minute" — [Sarvam](https://www.sarvam.ai/blogs/introducing-saaras-v4)
- Bolna: self-serve ~₹5.5/min; enterprises with large long-term volume ₹1.75–2/min. Human calling ops ₹7–8/min excluding hiring, training and attrition. A founder cites **60,000–90,000 connected minutes per use case** as the threshold where economics work — [Inc42, 15 Jul 2026](https://inc42.com/features/the-unit-economics-of-indias-voice-ai-boom/). Bolna's own pricing page shows bundles from ~$0.10 down to ~$0.05/min — [Bolna pricing](https://www.bolna.ai/pricing). A third-party lists the "Pilots" plan at 12,000 min @ $0.06 (~₹5.52/min), Sept 2026 — [Edesy](https://edesy.in/blog/bolna-ai-pricing-alternatives-2026)
- Vendor-reported India price bands (Jul 2026, vendor bias): Bolna ₹4–6/min; Skit.ai ₹18–28/min; Yellow.ai/Verloop ₹20–30/min — [Caller.Digital](https://caller.digital/blog/best-hindi-voice-ai-agent-platform-india-2026)
- Global (pages as fetched 24 Oct 2026): Vapi $0.05 + pass-through ($82–129 per 1,000 min) — [Vapi](https://vapi.ai/pricing); Retell sample $0.11/min, range $0.07–0.31 — [Retell](https://www.retellai.com/pricing); Bland $0.12–0.14 + telephony — [Bland](https://www.bland.ai/pricing); ElevenLabs $0.08 + LLM — [ElevenLabs](https://elevenlabs.io/pricing/api). Third-party all-in estimate for Vapi is $0.13–0.31/min — [Morph comparison](https://www.morphllm.com/comparisons/vapi-vs-retell-vs-bland-vs-synthflow). Forasoft (Oct 2026): Vapi $0.11–0.33, self-hosted Pipecat chained $0.06–0.15 — [Forasoft](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026)
- Concurrency limits matter for outbound blasts: Vapi 4 free / 10 Core / 30 Pro; Retell 20 included then $8 per line/mo; Bland 10–50 with daily caps of 100–2,000; ElevenLabs 4–40 by plan (sources above).

**Worked cost model (inference; assumptions explicit)**
Assumptions: 2.5-min average connected conversation; Sarvam PAYG + Vobiz telephony; 18% GST (standard Indian rate, not sourced here); ₹88/USD (assumed); unanswered dials free on Sarvam.

| Stack | ≈₹/min all-in | ≈₹ per connected 2.5-min call | ≈₹ per qualified lead @20% | @10% |
|---|---|---|---|---|
| Sarvam PAYG (₹3.50 + ₹0.40) ×1.18 GST | ~₹4.6 | ~₹11.5 | ~₹58 | ~₹115 |
| Bolna self-serve (~₹5.5, telephony incl.?) | ~₹5.5–6.5 | ~₹14–16 | ~₹70–80 | ~₹140–160 |
| Retell sample $0.11 + ElevenLabs Multilingual swap (+$0.045) ≈ $0.155 | ~₹13.6 | ~₹34 | ~₹170 | ~₹340 |
| Human caller (Inc42) | ₹7–8 + overheads | ~₹18–20 | ~₹90–100 | ~₹180–200 |

### Inferences
- Fixed setup (DLT/140-series, number rental, prompt engineering, QA tooling) dominates at low volume. Inc42's 60–90k connected-minute threshold suggests an AI lead engine needs meaningful call volume before it beats a small human SDR team on total cost.
- The cheapest per-minute stack may not be cheapest per qualified lead. Hindi WER and voice naturalness drive conversation completion, so a 2x difference in qualification rate outweighs a 2x difference in per-minute cost.

### Gaps
- No public data on AI outbound **qualification or connect rates** in India for B2B/MSME audiences. The 10–20% qualification and 2.5-min call length are assumptions.
- Sarvam does not say whether its rate changes with the LLM chosen. Bolna's INR self-serve rate and whether it includes telephony are not confirmed on an official INR page.

---

## 6. Funding and valuations of key players (dated)

### Takeaway
Capital is concentrated in model/infra players (ElevenLabs $11B; Deepgram, LiveKit and Sarvam each ~$1–1.5B). Indian application-layer voice-agent startups are still at seed/Series A–B scale ($6–16M rounds in 2026).

### Cited Findings
| Company | Latest round (date) | Amount / valuation | Source |
|---|---|---|---|
| ElevenLabs | Feb 2026 | $500M at $11B (Sequoia lead); later reports of secondary talks at ~$22B (unconfirmed) | [eWeek](https://www.eweek.com/fr/news/elevenlabs-500m-funding/), [AI Weekly](https://aiweekly.co/alerts/elevenlabs-anchors-7bn-voice-ai-funding-rush-in-q1-2026) |
| Deepgram | Jan 2026 | $130M Series C at $1.3B (aggregator) | [AI Weekly](https://aiweekly.co/alerts/elevenlabs-anchors-7bn-voice-ai-funding-rush-in-q1-2026) |
| LiveKit | Jan 2026 | $100M Series C at $1B, Index lead; total $183M | [Pulse 2.0](https://pulse2.com/livekit-100-million-series-c/) |
| Cartesia | Oct/Nov 2025 | $100M (Kleiner, Index, Lightspeed, NVIDIA); ~$191M total; earlier $64M Series A Mar 2025 | [AIWiki](https://www.aiwiki.ai/wiki/cartesia), [Fortune](https://www.fortune.com/2025/03/11/exclusive-cartesia-voice-ai-startup-raises-64-million-series-a) |
| Vapi | May 2026 | $50M Series B, Peak XV lead; total $72M. Earlier $20M Series A (Dec 2024) at ~$130M valuation (Reuters via AOL) | [SiliconANGLE](https://siliconangle.com/2026/05/12/vapi-nabs-50m-make-voice-ai-human/), [AOL/Reuters](https://www.aol.com/news/voice-ai-startup-vapi-raises-123356188.html) |
| Retell AI | No 2026 round confirmed; seed Aug 2024 (~$4.6M) | Sacra estimates ~$60M annualised revenue, Apr 2026, +650% YoY (estimate) | [CB Insights](https://www.cbinsights.com/company/retell-ai/financials), [Sacra](https://sacra.com/research/retell-ai-60m-yr-up-650-yoy) |
| Synthflow | Jun 2025 | $20M Series A, Accel lead; $30M total | [BusinessWire](https://www.businesswire.com/news/home/20250624442670/en/Synthflow-AI-Raises-$20M-to-Transform-the-$168B-Global-Conversational-AI-Market-With-Enterprise-AI-Voice-Agents) |
| Bland AI | Series B listed Jan 2025 (amount undisclosed in source) | $56.13M over 6 rounds | [CB Insights](https://www.cbinsights.com/company/blend-ai/financials) |
| Sarvam AI | Jun 2026 | $234M first close of $300M Series B at $1.5B post; HCLTech $150M; Bessemer | [exchange4media](https://www.exchange4media.com/industry-briefing-news/sarvam-raises-234m-in-first-close-of-300m-series-b-at-15b-valuation-155498.html) |
| Gnani.ai | Mar 2026 | $10M Series B first tranche, Aavishkaar lead, Info Edge | [Inc42](https://inc42.com/buzz/gnani-ai-raises-10-mn-to-build-sovereign-ai-voice-agents/) |
| Bolna | Jan 2026 | $6.3M seed, General Catalyst lead; YC, Blume | [Entrepreneur India](https://india.entrepreneur.com/news-and-trends/voice-ai-startup-bolna-raises-usd-63-mn-funding-led-by/502062) |
| Ringg AI | Jan 2026 + Aug 2026 | $5.5M (Arkam) + $10M extension (Peak XV) = ~$15.5M Series A | [YourStory](https://yourstory.com/2026/08/voice-ai-startup-ringg-ai-raises-10m-series-a-peak-xv-partners) |
| Smallest.ai | "October" (year unconfirmed, likely 2024) | $8M seed | [Inc42](https://inc42.com/buzz/voice-ai-startup-ringg-bags-5-5-mn-from-arkam-ventures/) |

### Inferences
- The Indian application layer is crowded and thinly funded (Bolna, Ringg, Gnani, Smallest, Caller.Digital, Edesy, SquadStack). Expect price competition and consolidation, so avoid deep lock-in to one small vendor and keep the STT/TTS/telephony layer swappable.

### Gaps
- No disclosed valuations for Bolna, Ringg, Gnani, Smallest, Retell, Bland or Synthflow. Bland's Series B amount unconfirmed. Exotel/Ozonetel funding not researched.

---

## 7. User sentiment (Reddit, HN, forums, reviews)

### Takeaway
Direct Reddit/HN threads did not surface in searches. The available practitioner signal (vendor support forums, reviews quoting Reddit) has three themes: demos are easy but production brings latency spikes and edge-case bugs, especially at concurrency; latency is usually a configuration problem; and Hindi on global platforms is weak on pronunciation and numbers.

### Cited Findings
- Review aggregating user feedback on Vapi: once moved to production, users report bugs, broken integrations, inconsistent settings and multi-second delays. One Reddit user said they "ran into quite a few bugs and edge cases", and another that voice lagged at higher concurrency — [Quiq Vapi review](https://quiq.com/blog/vapi-ai-review/)
- Vapi support thread: 3–4 s (sometimes 6–7 s) live latency vs 575–1,000 ms on the dashboard; smart endpointing didn't fix it — [Vapi support](https://support.vapi.ai/t/27532450/high-latency-problem-in-vapi-what-could-be-the-reason)
- Retell community: live-call latency traced partly to a large markdown file in the base prompt — [Retell community](https://community.retellai.com/t/performance-related-configurations-and-noticeable-latency-during-live-calls/747)
- Hindi quality complaint on Retell (pronunciation, numbers) — [Retell community](https://community.retellai.com/t/integration-of-indian-language-based-tts-and-stt-providers-like-sarvam-ai/2856)
- Knowlarity G2: 4.1/5 from 22 reviews (via vendor comparison) — [Caller.Digital](https://caller.digital/blog/voice-ai-vs-exotel-knowlarity-ozonetel-india-2026); Ozonetel has G2 reviews — [G2 Ozonetel](https://www.g2.com/products/ozonetel-ozonetel/reviews) (content not extracted)

### Inferences
- Plan for an evaluation/QA harness (simulated calls, latency p95 tracking, AMD outcome tracking) from day one. Production problems are configuration- and edge-case-driven rather than model-driven.

### Gaps
- No Reddit threads from r/AI_Agents, r/LocalLLaMA, r/SaaS, r/IndiaTech or r/developersIndia, and no HN threads, were returned by the search tool. YouTube reviews and X sentiment were not checked. Recommend a manual Reddit/HN pass if sentiment matters to the final report.

---

## 8. Documented failures, enforcement and spam-flagging

### Takeaway
AI voice calling carries real regulatory and reputational risk. The US FCC confirmed in Feb 2024 that AI voices are "artificial" voices under the TCPA (consent required). The FTC sued Air AI in Aug 2025 for deceptive "AI replaces your sales team" claims. India is the world's 5th most-spammed market, and from Sept 2026 TRAI treats AI calls as A2P traffic and feeds Truecaller-style spam flags to operators.

### Cited Findings
- **FCC Declaratory Ruling (8 Feb 2024)**: AI-generated voices count as "artificial or prerecorded voice" under the TCPA, so such calls need prior express consent. Prompted by the AI-Biden New Hampshire primary robocalls. It enables FCC fines, carrier blocking, private suits and state-AG actions. It is not a blanket ban; consented calls remain lawful — [FCC](https://WWW.FCC.GOV/document/fcc-makes-ai-generated-voices-robocalls-illegal), [Orrick](https://www.orrick.com/insights/2024/02/Did-the-FCC-Really-Ban-AI-Generated-Voice-Calls-No-But-Restrictions-Apply), [Cooley](https://www.cooley.com/news/insight/2024/2024-02-15-fcc-ai-generated-robocalls-illegal-under-the-tcpa)
- **Air AI (FTC v. Air AI Technologies, filed 25 Aug 2025, D. Ariz., 3-0 vote)**: 9 defendants (the company, 5 affiliates, 3 owners). Alleged false earnings claims, refund guarantees rarely honoured, and marketing its "conversational AI" as able to replace human reps. Consumers allegedly lost up to $250,000; violations of FTC Act §5, the Telemarketing Sales Rule and the Business Opportunity Rule — [FTC press release](https://www.ftc.gov/news-events/news/press-releases/2025/08/ftc-sues-stop-air-ai-using-deceptive-claims-about-business-growth-earnings-potential-refund). Law firms call it among the first "AI-washing" cases on agentic AI and human-replacement claims — [Perkins Coie](https://perkinscoie.com/insights/blog/ftc-files-new-ai-washing-case), [DLA Piper](https://www.dlapiper.com/insights/publications/2025/08/ftcs-latest-ai-washing-case). A March 2026 settlement reportedly bars Air AI from marketing business opportunities (single secondary source) — [BABL AI](https://babl.ai/?p=8416)
- **Truecaller India 2025** (report Feb 2026): 4,168 crore (~41.7B) spam calls identified, 1,189 crore blocked by users, 770 crore fraudulent calls. AI-generated voice messages flagged as a growing 2026 scam tactic — [FoneArena](https://www.fonearena.com/blog/475283/india-received-4168-crore-spam-calls-2025-truecaller.html), [ETV Bharat](https://www.etvbharat.com/en/technology/india-ranked-fifth-most-spammed-country-in-the-world-truecaller-report-reveals-enn26050604266). Globally, Truecaller says AI voice calls are getting harder to distinguish and is strengthening its "AI Call Scanner" — [Malaysian Wireless, May 2026](https://www.malaysianwireless.com/2026/05/truecaller-68billion-spam-fraud-calls/)
- Truecaller has 350M+ active users in India and disputes TRAI's exemption for designated number series as a "free pass" for spam. TRAI earlier barred call-management apps from blanket-blocking those series — [NokiaMob, 19 Sep 2026](https://nokiamob.net/2026/09/19/indias-telecom-regulator-targets-ai-robocalls-and-caller-id-apps/)
- Carrier-level risk: "high volumes of short-duration calls may trigger automated carrier blocks" — [Twilio India](https://www.twilio.com/en-us/guidelines/in/voice)

### Inferences
- Spam flagging works at three levels: carrier (short-call heuristics, A2P registration), crowd (Truecaller user reports now shared with operators), and regulator (UCC complaints). One bad campaign can poison a 140-series header. Throttle volume, avoid rapid hang-ups (AMD false positives produce exactly the short-call pattern), and pursue verified business caller ID where available (Retell's "Branded Call" add-on is the US analogue at $0.10/call — [Retell](https://www.retellai.com/pricing)).
- Air AI is a positioning lesson: avoid "replace your sales team" and guaranteed-ROI claims when marketing the lead engine.

### Gaps
- No India-specific enforcement case against an AI voice-calling company found. No India figure for the share of spam that is AI-voiced.

---

## 9. Lessons: what makes AI sales calls acceptable and effective

### Takeaway
Acceptability rests on consent, honest disclosure, fast natural turn-taking, and native-sounding Hindi/Hinglish on 8 kHz lines. Effectiveness comes from short, relevant, well-timed calls with clean human handoff. Upfront AI disclosure measurably hurts conversion, but regulation and trust make disclosure the safer default; mitigate the hit with fast, competent, empathetic delivery and opt-outs.

### Cited Findings
- **Disclosure effect**: in a field experiment with >6,200 customers of a financial-services firm, disclosing the chatbot identity before the conversation cut purchase rates by **79.7%**. Undisclosed bots performed as well as proficient human workers and ~4x better than inexperienced ones. The drop came from customers perceiving the bot as less knowledgeable and less empathetic, and was mitigated by **late disclosure timing** and customers' **prior AI experience** (Luo, Tong, Fang, Qu, *Marketing Science* 2019) — [IDEAS/RePEc abstract](https://ideas.repec.org/a/inm/ormksc/v38y2019i6p937-947.html), [Temple Fox news](https://www.fox.temple.edu/news/2020/01/chatbots-can-help-improve-salesprovided-you-dont-reveal-its-chatbot)
- **Consent is the legal gate** (US: FCC 2024 ruling — [Cooley](https://www.cooley.com/news/insight/2024/2024-02-15-fcc-ai-generated-robocalls-illegal-under-the-tcpa); India: explicit digital consent for 140-series promotional calls — [Plivo](https://plivo.com/docs/voice/concepts/140-series-provisioning); TRAI A2P registration — [NokiaMob](https://nokiamob.net/2026/09/19/indias-telecom-regulator-targets-ai-robocalls-and-caller-id-apps/))
- **Natural-sounding voice on the actual channel**: Bulbul V3 wins on 8 kHz telephony while ElevenLabs v3 wins full-band — [Sarvam](https://www.sarvam.ai/blogs/bulbul-v3). The "4 of 5 listeners within 10 s" bot-detection test gives a practical acceptance bar — [Caller.Digital](https://caller.digital/blog/best-hindi-voice-ai-agent-platform-india-2026)
- **Latency**: voice agents need ≲200 ms TTS first byte, and ~800 ms end-to-end feels natural — [Dograh](https://www.dograh.com/feeds/blog/tts-time-first-byte), [Forasoft](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026). Default endpointing waits (e.g., Vapi's 1.5 s) are the usual culprit — [Skool](https://www.skool.com/voice-ai-wrapper-academy-3838/the-1500ms-vapi-default-eating-your-latency-budget-and-a-few-other-things-worth-knowing)
- **Numbers, names, code-mix**: Hindi number/pronunciation errors are a known failure on global stacks — [Retell community](https://community.retellai.com/t/integration-of-indian-language-based-tts-and-stt-providers-like-sarvam-ai/2856). Test Romanised Hinglish and mixed numbers/dates — [Smallest](https://smallest.ai/blog/hindi-tts-apis-6-vendors-compared-for-indian-language-quality)
- **Voicemail handling**: wrong AMD either pitches a recording for 90 s or hangs up on a live human — [Cekura](https://www.cekura.ai/blogs/voicemail-detection)
- **Volume economics**: 60–90k connected minutes per use case are needed for viable economics (founder quote) — [Inc42](https://inc42.com/features/the-unit-economics-of-indias-voice-ai-boom/)
- **Don't over-promise**: Air AI was sued partly for marketing AI as a full replacement for human staff with guaranteed returns — [FTC](https://www.ftc.gov/news-events/news/press-releases/2025/08/ftc-sues-stop-air-ai-using-deceptive-claims-about-business-growth-earnings-potential-refund)

### Inferences (design recommendations for SolutionAI)
1. **Stack**: cascaded and streaming. Saaras V4 (codemix mode) STT → fast LLM with tight prompts → Bulbul V3 (or Lightning v3.1 Pro) TTS. Orchestrate via Sarvam agents (fastest to market) or Pipecat/LiveKit (more control) over Exotel/Plivo/Vobiz, hosted in India.
2. **Compliance-first telephony**: 140-series header via DLT, DND scrubbing, consent logs with timestamps, A2P number registration, calling-hour windows, one-tap opt-out ("Agar aap call nahi chahte, 'band karo' boliye").
3. **Disclosure that doesn't kill the call**: open with value and context (e.g., the startup's recent registration, a relevant scheme or benefit), then disclose early but not as the first sentence, in a warm voice. Given Luo et al., test disclosure timing within legal limits rather than hiding the AI.
4. **Language handling**: detect the caller's language in the first turn and mirror it (Hindi ↔ English ↔ Hinglish). Keep English business terms ("GST", "loan", "website") in English.
5. **Keep calls short**: 60–150 s qualification, 3–5 questions, with an immediate warm transfer or WhatsApp/callback booking for qualified leads.
6. **Measure**: p50/p95 end-of-speech-to-first-audio, AMD false-positive rate, hang-up-in-first-10-s rate (proxy for "sounds like a robot/spam"), qualification rate, complaint/spam-flag rate per header.

### Gaps
- No India-specific study on acceptance of AI sales calls (disclosure effects, Hindi vs English preference, B2B vs B2C) was found. The Luo et al. study is chatbot/financial services in China, so generalisability to Indian B2B voice calls is unproven.
- No published benchmarks of AI-call connect, completion or qualification rates for Indian MSME audiences.
- The search budget was exhausted before Deepgram Flux, Sarvam "Samvaad" branding, Haptik, ElevenLabs India telephony, and Reddit/HN/YouTube sentiment could be checked.
