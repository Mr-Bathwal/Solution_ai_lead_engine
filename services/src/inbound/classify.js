import { LlmUnavailable } from '../outreach/llm.js';

/**
 * Reply classification (design 7.5): what a founder's answer means, as one of
 *
 *   interested    wants to talk, asks for prices or a call
 *   question      asks something a person should answer
 *   not_now       later, already has a CA, no need at the moment
 *   unsubscribe   do not write again (and "not interested")
 *   wrong_person  not the company's address: the CA who incorporated it, someone who left
 *   unclear       none of these with any confidence
 *
 * Rules first, in English, Hindi and Hinglish; they are code, so they are the same every time and
 * cost nothing. When they are not sure (confidence below `ai_below`) and the LLM gateway is
 * configured, the small model is asked, given only the subject and the new text of the reply with
 * every address and number taken out. Its answer is recorded with its model; when it and the rules
 * disagree, the label is the safer of the two for the founder (an opt-out wins).
 *
 * Only two labels act by themselves, and only at high confidence: unsubscribe and wrong_person put
 * the address on the suppression list. Every other reply waits for a person in the Admin inbox,
 * whatever its label; the label only orders the queue and suggests the next step.
 */

export const CLASSIFIER_VERSION = 'reply-rules-v4';
export const LABELS = ['interested', 'question', 'not_now', 'unsubscribe', 'wrong_person', 'unclear'];

const RULES = {
  unsubscribe: [
    /\bun-?subscribe\b/, /\bopt[\s-]?out\b/, /\bremove (me|us|my|our|this|from)\b/, /\b(didn'?t|did not|never) (ask|asked|sign(ed)? up|subscribe[d]?|opt(ed)? in)\b/, /\btake (me|us) off\b/,
    /\b(stop|quit) (emailing|e-?mailing|sending|writing|contacting|spamming|mailing)\b/, /\bno more (e-?mails?|mails?|messages)\b/,
    /\b(do not|don't|dont|never) (e-?mail|mail|contact|write|message|send)\b/, /\bnot interested\b/, /\bspam(ming)?\b/,
    /\bblock(ed)? (you|this)\b/, /^\s*stop\.?\s*$/, /\bleave (me|us) alone\b/,
    /बंद कर/, /मत भेज/, /न भेज/, /(ई-?मेल|मेल) मत/, /हटा द/, /रुचि नहीं/, /दिलचस्पी नहीं/, /अनसब्सक्राइब/,
    /\bmat bhej/, /\bband kar/, /\bhata (do|dein|de)\b/, /\binterest nahi/, /\bnahi chahiye\b/,
  ],
  wrong_person: [
    /\bwrong (person|e-?mail|address|id|company|contact)\b/, /\bnot the (right|correct) (person|contact|e-?mail)\b/,
    /\b(no longer|not) (with|work(ing)? (with|at|for|in)|associated with|related to|part of)\b/, /\b(has|have) left (the|this) (company|organi[sz]ation)\b/,
    /\bdoes ?n[o']t work (here|for)\b/, /\bnot my company\b/, /\bresigned\b/, /\bfor (a|our|their|the) clients?\b/,
    /\bclient('?s)?( ki)? (company|firm)\b/, /\b(our|my) (consultancy|firm|office)('?s)? (e-?mail|id|address|mailbox)\b/, /\bcontact the directors?\b/, /\bmain (ca|cs) hoon\b/,
    /\b(i am|i'm|we are|this is)( (just|only))? (the |a |an |their |its )?(ca|c\.a\.|chartered accountant|cs|company secretary|consultant|professional|accountant)s?\b/,
    /\b(our|my) (client|clients)\b/, /\bincorporated (it|this company|the company) (for|on behalf)\b/, /\bwill (forward|pass) (this|it|your)\b/, /\bforward(ed|ing) (this|it|your)\b/,
    /गलत (व्यक्ति|ईमेल|पता)/, /किसी और का/, /(कंपनी|कम्पनी) से (जुड़ा|जुड़ी|संबंधित) नहीं/, /\bgalat (email|insaan|person|banda)\b/,
  ],
  not_now: [
    /\bnot (right )?now\b/, /\b(maybe|perhaps) later\b/, /\blater\b/, /\bnext (week|month|quarter|year)\b/, /\bafter (diwali|holi|eid|the festival|this month|[a-z]+ month)\b/,
    /\b(busy|occupied) (right now|now|at the moment|currently)\b/, /\bwill (get back|revert|come back|reach out|contact you)\b/,
    /\b(already|currently) (have|has|working with|work with|using|engaged|appointed) (a |an |our |my |own )*(ca|cs|accountant|consultant|auditor|firm|chartered accountant)\b/,
    /\b(have|has|got) (a |an |our |my )*(own )?(ca|cs|accountant|auditor|chartered accountant)\b/,
    /\b(no|not) (need|required|requirement|needed)\b/, /\bdon'?t need\b/, /\ball (set|sorted|done)\b/, /\balready (done|filed|taken care)\b/,
    /\b(ca|cs|accountant|auditor) (has )?(already )?(filed|done|handled)\b/, /\bno,? thanks?\b/, /\b(get|come) back\b/, /\blet me think\b/,
    // a date, never a time of day: "after the 15th", "after 15 Dec", but not "call me after 3 pm"
    /\bafter (the )?\d{1,2}(st|nd|rd|th)\b/, /\bafter \d{1,2} ?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/, /\b(travell?ing|out of (town|station))\b/,
    /\b(covered|taken care of|handled) by\b/, /\btakes? care of\b/, /\bcan wait\b/, /\bin a (few|couple of) (days|weeks|months)\b/, /\bonce (we|our|the)\b/,
    /हो चुका/, /\bho (gaya|chuka)\b/,
    /बाद में/, /अभी नहीं/, /ज़रूरत नहीं|जरूरत नहीं/, /पहले से/,
    /\bbaad (me|mein|main)\b/, /\babhi nahi\b/, /\bzarurat nahi\b/, /\bpehle se\b/,
  ],
  interested: [
    /\binterested\b/, /\b(please|pls|kindly) (call|contact|share|send|reach|connect|tell|let)\b/, /\bcall me\b/, /\bgive (me|us) a call\b/,
    /\blet'?s (talk|connect|discuss|speak|chat)\b/, /\b(would|we'?d|i'?d) (like|love) to\b/, /\bsounds (good|useful|helpful|great)\b/, /\byes,? please\b/,
    /\btell me more\b/, /\b(your|the) (charges|fees|pricing|price|quote|quotation|cost|package)\b/, /\bhow much\b/, /\b(book|schedule|set up|arrange) (a |the )?(call|meeting|demo)\b/,
    /\bhelp (us|me) (with|file|to)\b/, /\b(we|i) need (help|your help|support|assistance)\b/, /\bcan you (also )?(help|do|handle|file|assist|start|remind)\b/,
    /\bwho should (i|we) (speak|talk) to\b/, /\bwhen can you start\b/, /\bneed (someone|somebody|a ca|a cs|an accountant|a consultant)\b/,
    /\bget in touch\b/, /\b(send|share)( us| me)? (a |the |your )?(proposal|quote|quotation|details|brochure)\b/, /\blet'?s (do it|go ahead|proceed|start|begin)\b/,
    /\bgo ahead\b/, /\b(the|total) (cost|fees?|charges?)\b/, /\bwhat do you need from (us|me)\b/, /\bservice (chahiye|leni|lena)\b/,
    /रुचि है/, /कॉल कर/, /संपर्क कर/, /सेवा (लेना|चाहिए)/, /आगे क्या करना/, /फ़ोन कर|फोन कर/, /बात कर/, /कितना (शुल्क|चार्ज|खर्च)/, /मदद चाहिए/,
    /\bcall (karo|kar do|kijiye|karein)\b/, /\bbaat (karte|karein|kar)\b/, /\binterested h(ai|u|un|oon)\b/, /\bkitna (charge|lagega|fees)\b/, /\bmadad chahiye\b/,
    /\bcharges? (batao|bataiye|bata do)\b/,
  ],
  question: [
    /\?/, /^\s*(what|how|who|why|when|which|where|is|are|can|could|do|does|will|would|should)\b/m,
    /\b(i|we) (want|would like) to know\b/, /\bplease (clarify|explain)\b/,
    /क्या /, /कैसे/, /कौन/, /कब/, /\bkya\b/, /\bkaise\b/, /\bkab\b/,
  ],
};

/** Negations that turn an "interested" phrase around ("not interested" is an opt-out above). */
const NOT_INTERESTED = /\b(not|no longer|isn'?t|aren'?t) (really )?interested\b|रुचि नहीं|दिलचस्पी नहीं|interest nahi/;

/** The words the rules and the model see: the new text, lower case, with addresses and numbers taken out. */
export function scrub(text) {
  return String(text ?? '')
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/(?:\+91[\s-]?|\b0)?[6-9]\d{4}[\s-]?\d{5}\b/g, '[phone]')
    .slice(0, 3000);
}

/** The rules' answer: { label, confidence, by: 'rules', reasons }. */
export function classifyByRules({ subject = '', text = '' }) {
  const body = scrub(text).toLowerCase();
  const subj = scrub(subject).toLowerCase().replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '');
  const hits = {};
  for (const [label, rxs] of Object.entries(RULES)) {
    const found = rxs.filter((rx) => rx.test(body) || (label === 'unsubscribe' && rx.test(subj)));
    if (found.length) hits[label] = found.length;
  }
  if (hits.interested && NOT_INTERESTED.test(body)) delete hits.interested;
  const reasons = Object.entries(hits).map(([k, n]) => `${k} (${n})`);
  const words = body.split(/\s+/).filter(Boolean).length;
  // the unsubscribe mailto in every email's List-Unsubscribe header sends exactly this: subject "unsubscribe", no text
  if (!words && hits.unsubscribe) return { label: 'unsubscribe', confidence: 0.95, by: 'rules', reasons: ['the subject asks to unsubscribe'] };
  if (!words) return { label: 'unclear', confidence: 0.2, by: 'rules', reasons: ['no new text'] };
  // an opt-out wins over everything; a wrong address over the rest
  if (hits.unsubscribe) return { label: 'unsubscribe', confidence: hits.interested || hits.question ? 0.7 : 0.95, by: 'rules', reasons };
  if (hits.wrong_person) return { label: 'wrong_person', confidence: hits.interested ? 0.6 : 0.85, by: 'rules', reasons };
  if (hits.interested && hits.not_now) {
    // "interested, but after Diwali": the founder sets the time, unless the interest is plainly stronger
    if (hits.interested > hits.not_now) return { label: 'interested', confidence: 0.6, by: 'rules', reasons };
    return { label: 'not_now', confidence: 0.6, by: 'rules', reasons };
  }
  if (hits.interested) return { label: 'interested', confidence: hits.interested > 1 || !hits.question ? 0.85 : 0.75, by: 'rules', reasons };
  if (hits.not_now) return { label: 'not_now', confidence: hits.question ? 0.6 : 0.85, by: 'rules', reasons };
  if (hits.question) return { label: 'question', confidence: 0.75, by: 'rules', reasons };
  return { label: 'unclear', confidence: words <= 3 ? 0.4 : 0.3, by: 'rules', reasons: ['no rule matched'] };
}

function parseAnswer(content) {
  let v;
  try {
    v = JSON.parse(content);
  } catch {
    const m = /\{[\s\S]*\}/.exec(String(content ?? ''));
    if (!m) return null;
    try {
      v = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!v || !LABELS.includes(v.label)) return null;
  const confidence = Number(v.confidence);
  return { label: v.label, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5, reason: typeof v.reason === 'string' ? v.reason.slice(0, 200) : null };
}

const SAFER = ['unsubscribe', 'wrong_person', 'not_now', 'question', 'interested', 'unclear'];

/**
 * Classifies one reply. `llm`: an LlmGateway or null. Returns { label, confidence, by, model,
 * version, reasons, rules, ai }.
 */
export async function classifyReply({ subject, text }, { llm = null, aiBelow = 0.8, companyId = null, leadId = null } = {}) {
  const rules = classifyByRules({ subject, text });
  const base = { ...rules, model: null, version: CLASSIFIER_VERSION, rules, ai: null };
  if (rules.confidence >= aiBelow || !llm?.configured) return base;
  let ai = null;
  try {
    const res = await llm.chat({
      task: 'reply_classify', companyId, leadId,
      messages: [
        { role: 'system', content: [
          'You classify a reply to a short email from SolutionAI, which offers new companies in Uttar Pradesh help with their filings.',
          'Labels: interested (wants to talk, asks for prices or a call), question (asks something), not_now (later, already has a CA, no need now),',
          'unsubscribe (does not want more emails, or is not interested), wrong_person (not the company\'s own address, e.g. the CA who incorporated it, or someone who left),',
          'unclear (none of these). The reply may be in English, Hindi or Hinglish.',
          'Answer with JSON only: {"label": "...", "confidence": 0.0 to 1.0, "reason": "at most ten words"}.',
        ].join('\n') },
        { role: 'user', content: JSON.stringify({ subject: scrub(subject), reply: scrub(text) }) },
      ],
    });
    ai = parseAnswer(res.content);
    if (ai) ai.model = res.model;
  } catch (err) {
    if (!(err instanceof LlmUnavailable)) throw err;
    return { ...base, reasons: [...rules.reasons, `AI not used: ${err.message}`] };
  }
  if (!ai) return { ...base, reasons: [...rules.reasons, 'the AI answer could not be read'] };
  if (ai.label === rules.label) return { ...base, confidence: Math.max(rules.confidence, ai.confidence), by: 'ai', model: ai.model, ai };
  // they disagree: the rules' label when it is the safer one, otherwise the model's, never above 0.7
  const label = SAFER.indexOf(rules.label) < SAFER.indexOf(ai.label) && rules.label !== 'unclear' ? rules.label : ai.label;
  return { ...base, label, confidence: Math.min(0.7, label === ai.label ? ai.confidence : rules.confidence), by: 'ai', model: ai.model, ai,
    reasons: [...rules.reasons, `the AI said ${ai.label}${ai.reason ? ` (${ai.reason})` : ''}`] };
}

/** The next step a person sees beside each label. */
export const NEXT_STEP = {
  interested: 'Call or write back today: they asked to hear more.',
  question: 'Answer their question from the mailbox.',
  not_now: 'Thank them; no more cold emails will go. Note when they said to come back.',
  unsubscribe: 'Nothing to do: the address is on the suppression list.',
  wrong_person: 'Nothing to send: the address is suppressed. If it is the CA who incorporated the company, they may be worth a partner conversation.',
  unclear: 'Read it and choose a label.',
};
