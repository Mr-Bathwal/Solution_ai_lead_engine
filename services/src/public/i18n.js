import { formatDate } from '../outreach/evidence.js';

/**
 * The words on the founder's pages, in English and Hindi.
 *
 * The English is the wording the lawyer reviewed (claim-v2, notice-v1) and must not change without a
 * new wording version. The Hindi is a DRAFT translation, written for review: it is served to founders
 * only once config/outreach.json claim.hindi has `approved_by` and `approved_on` (the lawyer's
 * review, ops/WEEK4_ACTIONS.md item 20). Until then it can only be previewed, with `?lang=hi&preview=1`
 * on a company page link, and the form cannot be sent. Consents given in Hindi are recorded in the
 * ledger with the Hindi wording exactly as shown and the Hindi wording version.
 *
 * Deadline titles, form names, laws and scheme names come from the rules data and stay as written
 * there (they are the names on the government's own forms).
 */

export const LANGS = ['en', 'hi'];

const hiDate = (d) => {
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${d}T00:00:00+05:30` : d);
  return Number.isNaN(t.getTime()) ? String(d) : new Intl.DateTimeFormat('hi-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(t);
};

export const TEXT = {
  en: {
    html_lang: 'en',
    date: formatDate,
    skip: 'Skip to content',
    new_tab: ' (opens in a new tab)',
    footer: (legal) => `${legal} helps new companies in Uttar Pradesh keep up with their filings. This page shows only company information published in the MCA register and on the Startup in UP and UP Startup Mission portals; nothing about any person.`,
    incorporated: (kind, date) => `${kind === 'llp' ? 'registered' : 'incorporated'} ${date}`,
    dates_title: 'Your next filing dates',
    due: (past, date) => `${past ? 'was due by ' : 'by '}${date}`,
    dates_note: 'Dates are worked out from the incorporation date and the law, and checked by a chartered accountant. We cannot see what has already been filed, so a date that has passed may already be done.',
    no_dates: 'No firm dates in the next few months.',
    schemes_title: (name) => `Schemes ${name} may qualify for`,
    verdict: { eligible: 'Looks eligible', check_required: 'May qualify: a few details to check' },
    to_check: (list) => `To check: ${list}.`,
    source: 'Source',
    no_schemes: 'None that we can see from public information yet.',
    being_checked: (name) => `The filing dates and schemes for ${name} are being checked by a chartered accountant and will appear here shortly.`,
    yours: 'Is this your company?',
    claim_pitch: (org, name) => `Claim the page to get reminders of these dates by email or WhatsApp, and to set up ${org} for ${name}. It takes a minute, and you choose what you hear about.`,
    claim: (name) => `Claim ${name}`,
    crumb_claim: 'Claim',
    privacy_link: 'Privacy notice',
    notice: (legal, org, contact, hasUrl) => `${legal} will use your name, email address and mobile number only for what you tick below, and to set up your ${org} account if you go on to sign up. You can withdraw at any time: reply STOP on WhatsApp, say so on a call, use the link at the foot of any email, or write to ${contact ?? 'us'}.${hasUrl ? ' Our privacy notice explains how we keep and delete your data.' : ''}`,
    consent: {
      email_reminders: (c) => `Email me reminders of ${c}'s filing deadlines.`,
      whatsapp_reminders: (c) => `Send me WhatsApp reminders of ${c}'s filing deadlines at the number above.`,
      email_schemes: (c) => `Email me when ${c} may qualify for a government scheme.`,
      callback: (c, org) => `Call me back at the number above about ${c}'s filings. The call may come from ${org}'s AI assistant, which will say so at the start; I can ask for a person at any time.`,
    },
    f_name: 'Your name',
    f_role: (name) => `Your role at ${name}`,
    roles: { Director: 'Director', Founder: 'Founder', Partner: 'Partner', Employee: 'Employee', Other: 'Other' },
    f_email: 'Email address',
    f_mobile: 'Mobile number',
    f_mobile_hint: 'Optional. Only if you want WhatsApp reminders or a call back.',
    hear_about: 'What would you like to hear about?',
    nothing_ticked: 'Nothing is ticked for you. You can claim the page without ticking anything.',
    if_callback: 'If you asked for a call back',
    best_time: 'Best time',
    slots: { morning: 'in the morning (10 am to 1 pm)', afternoon: 'in the afternoon (1 pm to 4 pm)', evening: 'in the evening (4 pm to 7 pm)', any: 'between 10 am and 7 pm' },
    language: 'Language',
    lang_names: { hi: 'Hindi', en: 'English' },
    call_days: 'Calls are made Monday to Saturday. We call at most twice if you do not answer.',
    errors: {
      name: 'Please give your name.', role: 'Please choose your role.', email: 'Please give a valid email address.',
      mobile: 'That mobile number does not look like an Indian mobile number.',
      whatsapp_needs_mobile: 'Add your mobile number to get WhatsApp reminders, or untick that box.',
      callback_needs_mobile: 'Add your mobile number for the call back, or untick that box.',
    },
    thanks: 'Thank you',
    claimed: (name) => `${name} is claimed.`,
    you_will_get: (what) => `You will get ${what}.`,
    none_asked: 'You did not ask for any reminders; you can add them from your account later.',
    get: {
      reminders: (by) => `reminders of filing deadlines by ${by.join(' and ')}`,
      channel: { email: 'email', whatsapp: 'WhatsApp' },
      scheme: 'an email when a scheme may apply',
      callback: (slot) => `a call back ${slot} on the next calling day`,
      join: (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`),
    },
    setup: (org) => `Set up ${org}`,
    prefilled: (name) => `Your account is ready to finish, with ${name}'s details filled in.`,
    create: (org, name) => `Create your ${org} account to manage ${name}'s filings in one place.`,
    continue_to: (org) => `Continue to ${org}`,
    switch_to: 'हिन्दी में पढ़ें',
    claimed_title: 'Claimed',
    // a claim made from a campaign page waits for the person to confirm their email address
    confirm: {
      check_title: 'Check your email',
      check: (name, masked) => `To finish claiming ${name}, open the link we have just sent to ${masked}. It works for 48 hours. Until then nothing is recorded and nobody is contacted.`,
      check_again: 'If nothing arrives in a few minutes, look in your spam folder, or go back and check the address.',
      page_title: 'Confirm your claim',
      ask: (name) => `Confirm that you are claiming ${name}.`,
      button: 'Confirm',
      not_open: 'Claims from this page are not open yet. Please use the link in the email we sent your company, or write to us.',
      too_many: 'Too many confirmation emails to this address today. Please try again tomorrow.',
      subject: (name) => `Confirm your claim of ${name}`,
      body: (name, org, url) => [`Someone, we hope you, asked to claim ${name}'s page on ${org} and to hear from us about it.`,
        `To confirm, open this link within 48 hours:\n${url}`,
        'If this was not you, ignore this email. Nothing has been recorded, and we will not write to this address about it again.', org].join('\n\n'),
    },
  },
  hi: {
    html_lang: 'hi',
    date: hiDate,
    skip: 'सामग्री पर जाएँ',
    new_tab: ' (नए टैब में खुलता है)',
    footer: (legal) => `${legal} उत्तर प्रदेश की नई कंपनियों को उनकी फ़ाइलिंग समय पर करने में मदद करती है। इस पेज पर केवल वही कंपनी-जानकारी है जो MCA रजिस्टर और Startup in UP तथा UP Startup Mission पोर्टलों पर प्रकाशित है; किसी व्यक्ति के बारे में कुछ नहीं।`,
    incorporated: (kind, date) => `${kind === 'llp' ? 'पंजीकरण' : 'निगमन'}: ${date}`,
    dates_title: 'आपकी अगली फ़ाइलिंग तिथियाँ',
    due: (past, date) => `${past ? 'अंतिम तिथि थी: ' : 'अंतिम तिथि: '}${date}`,
    dates_note: 'ये तिथियाँ निगमन की तारीख़ और क़ानून के आधार पर निकाली गई हैं, और एक चार्टर्ड अकाउंटेंट ने इनकी जाँच की है। हम यह नहीं देख सकते कि क्या पहले ही फ़ाइल हो चुका है, इसलिए जो तिथि बीत चुकी है, उसका काम शायद हो चुका हो।',
    no_dates: 'अगले कुछ महीनों में कोई तय तिथि नहीं है।',
    schemes_title: (name) => `योजनाएँ, जिनके लिए ${name} पात्र हो सकती है`,
    verdict: { eligible: 'पात्र लगती है', check_required: 'पात्र हो सकती है: कुछ बातें जाँचनी हैं' },
    to_check: (list) => `जाँचना है: ${list}।`,
    source: 'स्रोत',
    no_schemes: 'सार्वजनिक जानकारी से अभी कोई योजना नहीं दिखती।',
    being_checked: (name) => `${name} की फ़ाइलिंग तिथियों और योजनाओं की जाँच एक चार्टर्ड अकाउंटेंट कर रहे हैं; ये जल्द ही यहाँ दिखेंगी।`,
    yours: 'क्या यह आपकी कंपनी है?',
    claim_pitch: (org, name) => `इन तिथियों के रिमाइंडर ईमेल या WhatsApp पर पाने के लिए, और ${name} के लिए ${org} शुरू करने के लिए, यह पेज क्लेम करें। इसमें एक मिनट लगता है, और आप ख़ुद चुनते हैं कि आपको किस बारे में सूचना मिले।`,
    claim: (name) => `${name} को क्लेम करें`,
    crumb_claim: 'क्लेम',
    privacy_link: 'गोपनीयता सूचना',
    notice: (legal, org, contact, hasUrl) => `${legal} आपका नाम, ईमेल पता और मोबाइल नंबर केवल उन्हीं कामों के लिए इस्तेमाल करेगी जिन्हें आप नीचे चुनेंगे, और, यदि आप आगे साइन अप करते हैं, तो आपका ${org} खाता बनाने के लिए। आप अपनी सहमति कभी भी वापस ले सकते हैं: WhatsApp पर STOP लिखकर भेजें, कॉल पर कह दें, किसी भी ईमेल के नीचे दिए गए लिंक का उपयोग करें, या ${contact ?? 'हमें'} पर लिखें।${hasUrl ? ' हमारी गोपनीयता सूचना बताती है कि हम आपका डेटा कैसे रखते और हटाते हैं।' : ''}`,
    consent: {
      email_reminders: (c) => `${c} की फ़ाइलिंग की अंतिम तिथियों के रिमाइंडर मुझे ईमेल पर भेजें।`,
      whatsapp_reminders: (c) => `${c} की फ़ाइलिंग की अंतिम तिथियों के रिमाइंडर मुझे ऊपर दिए गए नंबर पर WhatsApp पर भेजें।`,
      email_schemes: (c) => `जब ${c} किसी सरकारी योजना के लिए पात्र हो सकती हो, तो मुझे ईमेल करें।`,
      callback: (c, org) => `${c} की फ़ाइलिंग के बारे में मुझे ऊपर दिए गए नंबर पर वापस कॉल करें। कॉल ${org} के AI सहायक की ओर से हो सकती है, जो शुरुआत में ही यह बता देगा; मैं कभी भी किसी व्यक्ति से बात करने के लिए कह सकता/सकती हूँ।`,
    },
    f_name: 'आपका नाम',
    f_role: (name) => `${name} में आपकी भूमिका`,
    roles: { Director: 'निदेशक', Founder: 'संस्थापक', Partner: 'साझेदार', Employee: 'कर्मचारी', Other: 'अन्य' },
    f_email: 'ईमेल पता',
    f_mobile: 'मोबाइल नंबर',
    f_mobile_hint: 'वैकल्पिक। केवल तभी, जब आप WhatsApp रिमाइंडर या वापसी कॉल चाहते हों।',
    hear_about: 'आप किस बारे में सूचना पाना चाहेंगे?',
    nothing_ticked: 'आपके लिए कुछ भी पहले से चुना नहीं गया है। आप कुछ भी चुने बिना भी पेज क्लेम कर सकते हैं।',
    if_callback: 'यदि आपने वापसी कॉल माँगी है',
    best_time: 'सबसे अच्छा समय',
    slots: { morning: 'सुबह (10 से 1 बजे के बीच)', afternoon: 'दोपहर (1 से 4 बजे के बीच)', evening: 'शाम (4 से 7 बजे के बीच)', any: 'सुबह 10 से शाम 7 बजे के बीच' },
    language: 'भाषा',
    lang_names: { hi: 'हिन्दी', en: 'अंग्रेज़ी' },
    call_days: 'कॉल सोमवार से शनिवार तक की जाती हैं। आपके फ़ोन न उठाने पर हम अधिकतम दो बार कॉल करते हैं।',
    errors: {
      name: 'कृपया अपना नाम लिखें।', role: 'कृपया अपनी भूमिका चुनें।', email: 'कृपया सही ईमेल पता लिखें।',
      mobile: 'यह मोबाइल नंबर भारतीय मोबाइल नंबर जैसा नहीं लगता।',
      whatsapp_needs_mobile: 'WhatsApp रिमाइंडर के लिए अपना मोबाइल नंबर लिखें, या उस विकल्प से निशान हटा दें।',
      callback_needs_mobile: 'वापसी कॉल के लिए अपना मोबाइल नंबर लिखें, या उस विकल्प से निशान हटा दें।',
    },
    thanks: 'धन्यवाद',
    claimed: (name) => `${name} क्लेम हो गई है।`,
    you_will_get: (what) => `आपको ये मिलेंगे: ${what}।`,
    none_asked: 'आपने कोई रिमाइंडर नहीं माँगा; आप बाद में अपने खाते से इन्हें जोड़ सकते हैं।',
    get: {
      reminders: (by) => `फ़ाइलिंग की अंतिम तिथियों के रिमाइंडर ${by.join(' और ')} पर`,
      channel: { email: 'ईमेल', whatsapp: 'WhatsApp' },
      scheme: 'किसी योजना के लागू होने पर एक ईमेल',
      callback: (slot) => `अगले कॉल वाले दिन ${slot} एक वापसी कॉल`,
      join: (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} और ${parts.at(-1)}`),
    },
    setup: (org) => `${org} शुरू करें`,
    prefilled: (name) => `आपका खाता लगभग तैयार है; ${name} का विवरण पहले से भरा हुआ है।`,
    create: (org, name) => `${name} की सारी फ़ाइलिंग एक जगह संभालने के लिए अपना ${org} खाता बनाएँ।`,
    continue_to: (org) => `${org} पर आगे बढ़ें`,
    switch_to: 'Read in English',
    claimed_title: 'क्लेम हो गया',
    confirm: {
      check_title: 'अपना ईमेल देखें',
      check: (name, masked) => `${name} का क्लेम पूरा करने के लिए, ${masked} पर अभी भेजा गया लिंक खोलें। यह 48 घंटे तक काम करेगा। तब तक न कुछ दर्ज होता है, न किसी से संपर्क किया जाता है।`,
      check_again: 'अगर कुछ मिनट में ईमेल न आए, तो स्पैम फ़ोल्डर देखें, या वापस जाकर पता जाँचें।',
      page_title: 'अपने क्लेम की पुष्टि करें',
      ask: (name) => `पुष्टि करें कि आप ${name} को क्लेम कर रहे हैं।`,
      button: 'पुष्टि करें',
      not_open: 'इस पेज से क्लेम अभी शुरू नहीं हुए हैं। कृपया आपकी कंपनी को भेजे गए ईमेल का लिंक इस्तेमाल करें, या हमें लिखें।',
      too_many: 'आज इस पते पर बहुत सारे पुष्टि ईमेल भेजे जा चुके हैं। कृपया कल फिर कोशिश करें।',
      subject: (name) => `${name} के क्लेम की पुष्टि करें`,
      body: (name, org, url) => [`किसी ने, उम्मीद है आपने, ${org} पर ${name} का पेज क्लेम करने और इसके बारे में हमसे सूचना पाने के लिए कहा है।`,
        `पुष्टि के लिए, 48 घंटे के भीतर यह लिंक खोलें:\n${url}`,
        'अगर यह आपने नहीं किया, तो इस ईमेल को अनदेखा करें। कुछ भी दर्ज नहीं हुआ है, और हम इस बारे में इस पते पर दोबारा नहीं लिखेंगे।', org].join('\n\n'),
    },
    draft_banner: 'मसौदा: यह हिन्दी पाठ अभी कानूनी समीक्षा में है और चालू नहीं है, इसलिए यह फ़ॉर्म भेजा नहीं जा सकता। Draft: this Hindi wording is under legal review and is not live; the form cannot be sent.',
  },
};

/**
 * Hindi's state from the outreach config: `live` once the lawyer's review is recorded
 * (claim.hindi.approved_by and approved_on), otherwise only a preview.
 */
export function hindiState(outreachCfg) {
  const h = outreachCfg?.claim?.hindi ?? {};
  return { live: Boolean(String(h.approved_by ?? '').trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(h.approved_on ?? ''))),
    wordingVersion: h.wording_version ?? null };
}

/**
 * The language of a page request: Hindi when asked for (?lang=hi) and approved; a draft preview when
 * asked for with preview=1 before approval; English otherwise.
 */
export function pageLanguage(searchParams, state) {
  if (searchParams.get('lang') !== 'hi') return { lang: 'en', preview: false };
  if (state.live) return { lang: 'hi', preview: false };
  if (searchParams.get('preview') === '1') return { lang: 'hi', preview: true };
  return { lang: 'en', preview: false };
}
