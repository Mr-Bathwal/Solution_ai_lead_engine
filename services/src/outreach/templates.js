import { formatDate } from './evidence.js';

/**
 * The reviewed message templates: the drafter when no LLM gateway is configured, and the fallback
 * when an AI draft fails the quality check (design 7.5). They are written only from the evidence
 * pack, in English or Hindi, in plain text (no tracking pixel, no images, one link to the company's
 * page and one to unsubscribe).
 *
 * {{page_url}} and {{unsubscribe_url}} stay as placeholders in the draft a person approves; the
 * sender fills them in with the company's own unguessable links at the moment of sending.
 *
 * Tone rules, also enforced by the quality check: say what applies and when, with the law; never
 * that a filing was missed (the engine cannot see filings), never a threat of penalty, never
 * urgency, never a claim to speak for the government.
 */

export const TEMPLATE_VERSION = 'templates-v1';
export const PAGE_URL = '{{page_url}}';
export const UNSUBSCRIBE_URL = '{{unsubscribe_url}}';

const list = (items, lang) => {
  if (items.length <= 1) return items.join('');
  const and = lang === 'hi' ? ' और ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${and}${items.at(-1)}`;
};

function signature(sender, org) {
  return [sender.name, sender.title ? `${sender.title}, ${org.name}` : org.name, org.website].filter(Boolean).join('\n');
}

const EN = {
  firstSubject: (p) => `${p.company.name}: your next filing dates`,
  greeting: (p) => `Hello ${p.company.name} team,`,
  intro(p, asOf) {
    const inc = p.company.incorporated;
    const recent = inc && Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${inc}T00:00:00Z`) <= 120 * 86_400_000;
    const verb = p.company.kind === 'llp' ? 'registering' : 'incorporating';
    return recent ? `Congratulations on ${verb} ${p.company.name} on ${formatDate(inc, 'en')}.` : `A few filing dates are coming up for ${p.company.name}.`;
  },
  listHead: (p) => `These are the next dates that apply to ${p.company.name}:`,
  deadline(d) {
    const what = `${d.title}${d.form ? ` (${d.form})` : ''}`;
    const law = d.law ? `, under the ${d.law}` : '';
    return d.status === 'was_due'
      ? `- ${what}: this was due by ${formatDate(d.due, 'en')}${law}. If it is already done, please ignore this line.`
      : `- ${what}: due by ${formatDate(d.due, 'en')}${law}.`;
  },
  schemes(p) {
    const s = p.schemes;
    if (!s.length) return null;
    const sure = s.filter((x) => x.verdict === 'eligible').map((x) => x.name);
    const maybe = s.filter((x) => x.verdict !== 'eligible').map((x) => x.name);
    const parts = [];
    if (sure.length) parts.push(`${p.company.name} appears to qualify for ${list(sure, 'en')}.`);
    if (maybe.length) parts.push(`${sure.length ? 'It' : p.company.name} may also qualify for ${list(maybe, 'en')}; ${maybe.length > 1 ? 'each needs' : 'it needs'} a few details checked first, and the page says which.`);
    return parts.join(' ');
  },
  pageLine: (p) => `We have put these on one page for ${p.company.name}, with the law behind each date:`,
  offer: 'SolutionAI helps new companies in Uttar Pradesh keep up with these filings. If this is useful, just reply and one of us will answer.',
  why: (p) => (p.contact?.basis === 'published_by_company'
    ? `You are getting this email because ${p.company.name} publishes this address on its website, ${p.contact.domain}. If you would rather not hear from us, reply "unsubscribe" or use this link and we will not write again: ${UNSUBSCRIBE_URL}`
    : `You are getting this email because ${p.company.name}'s registered email address is published in the Ministry of Corporate Affairs register. If you would rather not hear from us, reply "unsubscribe" or use this link and we will not write again: ${UNSUBSCRIBE_URL}`),
  followSubject: (firstSubject) => `Re: ${firstSubject}`,
  followIntro: (p, firstSentOn) => `A short follow-up to my email of ${formatDate(firstSentOn, 'en')}.`,
  followNext(p, d) {
    if (!d) return `The dates for ${p.company.name} are on its page.`;
    return d.status === 'was_due'
      ? `The most recent date for ${p.company.name} was ${d.title}${d.form ? ` (${d.form})` : ''}, due by ${formatDate(d.due, 'en')}.`
      : `The next date for ${p.company.name} is ${d.title}${d.form ? ` (${d.form})` : ''}: due by ${formatDate(d.due, 'en')}.`;
  },
  followPage: 'The page with every date and the law behind it is here:',
  followClose: 'If it would help, reply and one of us will answer. If not, you will not get another email from us about this.',
  followStop: `To stop all emails from us: ${UNSUBSCRIBE_URL}`,
  needSubject: (p) => (p.need.type === 'deadline' ? `${p.company.name}: one more filing date` : `${p.company.name}: a scheme it may qualify for`),
  needIntro: (p) => (p.need.type === 'deadline'
    ? `I wrote to you on ${formatDate(p.thread.first_sent_on, 'en')} about ${p.company.name}'s filing dates. One more date now applies:`
    : `I wrote to you on ${formatDate(p.thread.first_sent_on, 'en')} about ${p.company.name}'s filing dates. Since then, a scheme has come up that may apply.`),
};

const HI = {
  firstSubject: (p) => `${p.company.name}: अगली फ़ाइलिंग की तारीखें`,
  greeting: (p) => `नमस्ते ${p.company.name} टीम,`,
  intro(p, asOf) {
    const inc = p.company.incorporated;
    const recent = inc && Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${inc}T00:00:00Z`) <= 120 * 86_400_000;
    const what = p.company.kind === 'llp' ? 'पंजीकरण' : 'निगमन (incorporation)';
    return recent ? `${formatDate(inc, 'hi')} को ${p.company.name} के ${what} पर बधाई।` : `${p.company.name} की कुछ फ़ाइलिंग की तारीखें आने वाली हैं।`;
  },
  listHead: (p) => `${p.company.name} पर लागू होने वाली अगली तारीखें ये हैं:`,
  deadline(d) {
    const what = `${d.title}${d.form ? ` (${d.form})` : ''}`;
    const law = d.law ? ` (${d.law})` : '';
    return d.status === 'was_due'
      ? `- ${what}: इसकी अंतिम तारीख ${formatDate(d.due, 'hi')} थी${law}। अगर यह हो चुका है, तो इस पंक्ति को अनदेखा करें।`
      : `- ${what}: ${formatDate(d.due, 'hi')} तक${law}।`;
  },
  schemes(p) {
    const s = p.schemes;
    if (!s.length) return null;
    const sure = s.filter((x) => x.verdict === 'eligible').map((x) => x.name);
    const maybe = s.filter((x) => x.verdict !== 'eligible').map((x) => x.name);
    const parts = [];
    if (sure.length) parts.push(`${p.company.name} ${list(sure, 'hi')} के लिए पात्र लगती है।`);
    if (maybe.length) parts.push(`${p.company.name} ${list(maybe, 'hi')} के लिए भी पात्र हो सकती है; पहले कुछ जानकारी की जाँच ज़रूरी है, जो पेज पर बताई गई है।`);
    return parts.join(' ');
  },
  pageLine: (p) => `हमने ${p.company.name} के लिए ये सभी तारीखें, हर तारीख के पीछे के क़ानून के साथ, एक पेज पर रखी हैं:`,
  offer: 'SolutionAI उत्तर प्रदेश की नई कंपनियों को इन फ़ाइलिंग्स में मदद करता है। अगर यह उपयोगी लगे, तो बस इस ईमेल का जवाब दें; हमारी टीम का कोई व्यक्ति उत्तर देगा।',
  why: (p) => (p.contact?.basis === 'published_by_company'
    ? `आपको यह ईमेल इसलिए मिला है क्योंकि ${p.company.name} ने यह पता अपनी वेबसाइट ${p.contact.domain} पर प्रकाशित किया है। अगर आप हमसे आगे कोई ईमेल नहीं चाहते, तो "unsubscribe" लिखकर जवाब दें या इस लिंक का उपयोग करें: ${UNSUBSCRIBE_URL}`
    : `आपको यह ईमेल इसलिए मिला है क्योंकि ${p.company.name} का पंजीकृत ईमेल पता कॉर्पोरेट कार्य मंत्रालय (MCA) के रजिस्टर में प्रकाशित है। अगर आप हमसे आगे कोई ईमेल नहीं चाहते, तो "unsubscribe" लिखकर जवाब दें या इस लिंक का उपयोग करें: ${UNSUBSCRIBE_URL}`),
  followSubject: (firstSubject) => `Re: ${firstSubject}`,
  followIntro: (p, firstSentOn) => `${formatDate(firstSentOn, 'hi')} के मेरे ईमेल के संदर्भ में एक छोटा-सा फ़ॉलो-अप।`,
  followNext(p, d) {
    if (!d) return `${p.company.name} की सभी तारीखें उसके पेज पर हैं।`;
    return d.status === 'was_due'
      ? `${p.company.name} की सबसे हाल की तारीख: ${d.title}${d.form ? ` (${d.form})` : ''}, ${formatDate(d.due, 'hi')} तक थी।`
      : `${p.company.name} की अगली तारीख: ${d.title}${d.form ? ` (${d.form})` : ''}, ${formatDate(d.due, 'hi')} तक।`;
  },
  followPage: 'हर तारीख और उसके पीछे के क़ानून वाला पेज यहाँ है:',
  followClose: 'अगर इससे मदद मिले, तो जवाब दें; हमारी टीम का कोई व्यक्ति उत्तर देगा। अगर नहीं, तो इस बारे में हमारी ओर से आगे कोई ईमेल नहीं आएगा।',
  followStop: `हमसे सभी ईमेल बंद करने के लिए: ${UNSUBSCRIBE_URL}`,
  needSubject: (p) => (p.need.type === 'deadline' ? `${p.company.name}: फ़ाइलिंग की एक और तारीख` : `${p.company.name}: एक योजना जिसके लिए वह पात्र हो सकती है`),
  needIntro: (p) => (p.need.type === 'deadline'
    ? `मैंने ${formatDate(p.thread.first_sent_on, 'hi')} को ${p.company.name} की फ़ाइलिंग की तारीखों के बारे में लिखा था। अब एक और तारीख लागू होती है:`
    : `मैंने ${formatDate(p.thread.first_sent_on, 'hi')} को ${p.company.name} की फ़ाइलिंग की तारीखों के बारे में लिखा था। तब से एक योजना सामने आई है जो लागू हो सकती है।`),
};

const TEXT = { en: EN, hi: HI };

/**
 * A draft from the templates. `context`: { kind, language, sender: { name, title }, org: { name,
 * website }, firstSubject, firstSentOn } (the last two for a follow-up). Returns { subject, body }.
 * A new-need message (kind 'new_need') is about the one deadline or scheme in pack.need, and names
 * the date of the first email from pack.thread.
 */
export function templateDraft(pack, { kind, language = 'en', sender, org, firstSubject = null, firstSentOn = null }) {
  const t = TEXT[language];
  if (!t) throw new TypeError(`no templates for language ${language}`);
  const sign = signature(sender, org);
  if (kind === 'first_touch') {
    const blocks = [t.greeting(pack), t.intro(pack, pack.as_of)];
    if (pack.deadlines.length) blocks.push([t.listHead(pack), ...pack.deadlines.map(t.deadline)].join('\n'));
    const schemes = t.schemes(pack);
    if (schemes) blocks.push(schemes);
    blocks.push(`${t.pageLine(pack)}\n${PAGE_URL}`, t.offer, sign, t.why(pack));
    return { subject: t.firstSubject(pack), body: blocks.join('\n\n') };
  }
  if (kind === 'follow_up') {
    if (!firstSubject || !firstSentOn) throw new TypeError('a follow-up needs the first email\'s subject and date');
    const next = pack.deadlines.find((d) => d.status !== 'was_due') ?? pack.deadlines.at(-1) ?? null;
    const blocks = [t.greeting(pack), `${t.followIntro(pack, firstSentOn)} ${t.followNext(pack, next)}`,
      `${t.followPage}\n${PAGE_URL}`, t.followClose, sign, t.followStop];
    return { subject: t.followSubject(firstSubject), body: blocks.join('\n\n') };
  }
  if (kind === 'new_need') {
    if (!pack.need || !pack.thread?.first_sent_on) throw new TypeError('a new-need message needs pack.need and the first email\'s date');
    const blocks = [t.greeting(pack), pack.need.type === 'deadline' ? `${t.needIntro(pack)}\n${pack.deadlines.map(t.deadline).join('\n')}` : t.needIntro(pack)];
    const schemes = pack.need.type === 'scheme' ? t.schemes(pack) : null;
    if (schemes) blocks.push(schemes);
    blocks.push(`${t.pageLine(pack)}\n${PAGE_URL}`, t.offer, sign, t.why(pack));
    return { subject: t.needSubject(pack), body: blocks.join('\n\n') };
  }
  throw new TypeError(`no template for ${kind}`);
}
