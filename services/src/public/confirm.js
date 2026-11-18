import { buildEmail } from '../outreach/mime.js';
import { mailboxFor } from '../outreach/sequence.js';
import { TEXT } from './i18n.js';

/** How long a confirmation link works. */
export const CONFIRM_HOURS = 48;

/**
 * The email that confirms a claim made from a campaign page (code review of 18 Nov, finding 1).
 *
 * A page link in one of our emails reached the company's own mailbox, so whoever opens it is close to
 * the company. A campaign page gives a link to anyone who searches, so a claim from it proves
 * nothing about the person: someone could claim a stranger's company, or give a stranger's mobile
 * number for a call back. So a campaign claim records nothing, contacts nobody and stops nothing until
 * the person opens the link sent to the email address they gave (/k/<token>, used once, 48 hours).
 *
 * It is the one email the person asked for, about their own request, so it carries no unsubscribe
 * link, and it is sent from the company's usual mailbox. Returns null when email is not set up (no
 * transport, mailbox or PUBLIC_BASE_URL): campaign claims then stay closed.
 */
export function claimConfirmer({ transport, mailboxes, mailboxIds, publicBaseUrl, org, clock = () => new Date() }) {
  if (!transport || !publicBaseUrl || !mailboxIds?.length) return null;
  const base = String(publicBaseUrl).replace(/\/+$/, '');
  return {
    async send({ to, token, company, lang = 'en' }) {
      const t = TEXT[lang === 'hi' ? 'hi' : 'en'].confirm;
      const mb = mailboxes[mailboxFor(company.id, mailboxIds)];
      if (!mb?.address) throw new Error('no sending mailbox is set up for the confirmation email');
      const email = buildEmail({ from: { name: mb.name, address: mb.address }, to: { name: null, address: to }, subject: t.subject(company.name),
        text: t.body(company.name, org.name, `${base}/k/${token}`), at: clock() });
      return transport.send({ raw: email.raw, messageId: email.messageId, mailbox: mb, to });
    },
  };
}
