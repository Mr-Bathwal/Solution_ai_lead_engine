/**
 * The two platform endpoints Phase 3 uses (design 8; shapes in docs/PLATFORM_CONTRACTS.md):
 *
 *   onboard: when a founder claims a company page, create a pre-filled business profile and return
 *     the sign-up link for it. Until the endpoint exists (PLATFORM_ONBOARDING_URL unset) the page
 *     hands the founder to the normal sign-up (PLATFORM_SIGNUP_URL), as the design's fallback says.
 *   notify: an in-app notification (and, through the platform's own mail, an email) for a signed-up
 *     founder who asked for reminders. Until PLATFORM_NOTIFY_URL is set, nothing is sent and the
 *     caller is told so.
 *
 * Only company-level facts and what the founder typed on the claim form are sent; nothing else
 * about any person.
 */

export class PlatformClient {
  constructor({ onboardingUrl = '', notifyUrl = '', signupUrl = '', key = '', fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.onboardingUrl = onboardingUrl;
    this.notifyUrl = notifyUrl;
    this.signupUrl = signupUrl;
    this.key = key;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async #post(url, body) {
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`the platform answered ${res.status}`);
    return res.json();
  }

  /**
   * Returns { signup_url, prefilled }. Falls back to the plain sign-up link (prefilled: false) when
   * the endpoint is not configured or fails: a founder who claimed is never left on an error.
   */
  async onboard(profile, { log = console } = {}) {
    if (this.onboardingUrl && this.key) {
      try {
        const r = await this.#post(this.onboardingUrl, profile);
        if (typeof r?.signup_url === 'string' && /^https:\/\//.test(r.signup_url)) return { signup_url: r.signup_url, prefilled: true };
        log.warn?.('[platform] onboarding answered without an https signup_url; using the plain sign-up');
      } catch (err) {
        log.warn?.(`[platform] onboarding failed (${err.message}); using the plain sign-up`);
      }
    }
    return { signup_url: this.signupUrl || null, prefilled: false };
  }

  get canNotify() {
    return Boolean(this.notifyUrl && this.key);
  }

  /** Sends one notification. Returns { delivered: true, id } or throws; callers check canNotify first. */
  async notify(notification) {
    if (!this.canNotify) throw new Error('PLATFORM_NOTIFY_URL is not configured');
    const r = await this.#post(this.notifyUrl, notification);
    return { delivered: true, id: r?.id ?? null };
  }
}
