/**
 * Sarvam's voice agent, instant outbound calls (docs.sarvam.ai/voice-agents/api/instant-outbound):
 *
 *   POST {api_base}/v1/orgs/{org_id}/workspaces/{workspace_id}/outbounds   header X-API-Key
 *     { app_config: { app_id, app_version, connection_config: { connection_id, agent_phone_number },
 *                     agent_variables, app_overrides: { initial_bot_message, initial_language_name } },
 *       user_config: { user_phone_number }, webhook_config: { url, metadata } }
 *   -> { attempt_id }
 *
 * After the attempt, Sarvam POSTs { attempt_id, status (connected | no_answer | busy | failed),
 * duration, interaction_transcript, final_agent_variables, failure_reason, webhook_config } to the
 * webhook. The webhook is not signed by Sarvam, so the engine signs each call itself: the metadata
 * carries the call's id and an HMAC of it, and a payload whose HMAC or attempt_id does not match a
 * call the engine placed is refused.
 *
 * The agent itself (its prompt and voice) lives in the Sarvam app, pinned to `app_version`; the
 * engine passes the approved opening line, so the disclosure that it is an AI is the engine's
 * reviewed text, word for word. The telephone line (Exotel, with the DLT-registered number) is
 * the `connection_id` set up in Sarvam.
 *
 * Without SARVAM_API_KEY and the ids, `configured` is false and nothing is called.
 */

export class VoiceUnavailable extends Error {
  constructor(message, { status = null, placed = false } = {}) {
    super(message);
    this.name = 'VoiceUnavailable';
    this.status = status;
    this.placed = placed;     // true when the request may have reached Sarvam (a call may exist)
  }
}

const LANGUAGE_NAME = { en: 'English', hi: 'Hindi' };

export class SarvamClient {
  constructor({ apiBase, apiKey = '', orgId = '', workspaceId = '', appId = '', appVersion = '', connectionId = '', callerNumber = '',
    fetch = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    this.apiBase = String(apiBase ?? '').replace(/\/+$/, '');
    Object.assign(this, { apiKey, orgId, workspaceId, appId, connectionId, callerNumber, fetch, timeoutMs });
    this.appVersion = Number.parseInt(appVersion, 10);
  }

  get configured() {
    return Boolean(this.apiBase && this.apiKey && this.orgId && this.workspaceId && this.appId && Number.isInteger(this.appVersion)
      && this.connectionId && this.callerNumber);
  }

  /** Places one call. Returns { attemptId }. Throws VoiceUnavailable. */
  async call({ to, language, opening, variables, webhookUrl, metadata }) {
    if (!this.configured) throw new VoiceUnavailable('the voice provider is not configured');
    const body = {
      app_config: {
        app_id: this.appId, app_version: this.appVersion, app_type: 'agent',
        connection_config: { connection_id: this.connectionId, agent_phone_number: this.callerNumber },
        agent_variables: variables,
        app_overrides: { initial_bot_message: opening, initial_language_name: LANGUAGE_NAME[language] ?? 'Hindi' },
      },
      user_config: { user_phone_number: to },
      webhook_config: { url: webhookUrl, metadata },
    };
    let res;
    try {
      res = await this.fetch(`${this.apiBase}/v1/orgs/${encodeURIComponent(this.orgId)}/workspaces/${encodeURIComponent(this.workspaceId)}/outbounds`, {
        method: 'POST',
        headers: { 'X-API-Key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // no answer: the request may or may not have reached Sarvam
      throw new VoiceUnavailable(`the call request got no answer: ${err?.message ?? err}`, { placed: true });
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = JSON.stringify((await res.json())?.detail ?? '').slice(0, 300);
      } catch {
        // no JSON body
      }
      throw new VoiceUnavailable(`Sarvam answered ${res.status}${detail ? `: ${detail}` : ''}`, { status: res.status, placed: res.status >= 500 });
    }
    const r = await res.json().catch(() => null);
    if (typeof r?.attempt_id !== 'string' || !r.attempt_id) throw new VoiceUnavailable('Sarvam answered without an attempt_id', { placed: true });
    return { attemptId: r.attempt_id };
  }
}

export function sarvamFromEnv(env, cfg, { fetch = globalThis.fetch } = {}) {
  return new SarvamClient({
    apiBase: env.SARVAM_API_BASE || cfg.api_base, apiKey: env.SARVAM_API_KEY, orgId: env.SARVAM_ORG_ID, workspaceId: env.SARVAM_WORKSPACE_ID,
    appId: env.SARVAM_APP_ID, appVersion: env.SARVAM_APP_VERSION, connectionId: env.SARVAM_CONNECTION_ID, callerNumber: env.VOICE_CALLER_NUMBER, fetch,
  });
}
