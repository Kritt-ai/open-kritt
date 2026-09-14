import { PROVIDER_CREDENTIALS_PATH, readManagedCredentialStateSync } from './providerCredentials.js';

const BASE_URL = 'https://api.deepseek.com';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class DeepSeekError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new DeepSeekError('DeepSeek returned an invalid response.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new DeepSeekError('DeepSeek returned an oversized response.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Account diagnostics deliberately accept no repository content, prompts, or tools.
export function createDeepSeekClient({
  env = process.env,
  credentialsPath = PROVIDER_CREDENTIALS_PATH,
  fetchImpl = globalThis.fetch,
} = {}) {
  function credential() {
    const state = readManagedCredentialStateSync(credentialsPath);
    const key =
      state.credentials.deepseek || (!state.disabledEnvironmentProviders.includes('deepseek') && env.DEEPSEEK_API_KEY);
    if (typeof key !== 'string' || !key.trim()) throw new DeepSeekError('Add a DeepSeek API key in Accounts.', 409);
    if (key.length > 16384 || /[\r\n]/.test(key)) throw new DeepSeekError('The DeepSeek API key is invalid.', 409);
    return key.trim();
  }

  async function request(path, key, body) {
    try {
      const response = await fetchImpl(`${BASE_URL}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) {
          throw new DeepSeekError('DeepSeek rejected the API key. Check or replace it in Accounts.', 422);
        }
        if (response.status === 402) throw new DeepSeekError('DeepSeek reports insufficient account balance.', 422);
        if (response.status === 429) throw new DeepSeekError('DeepSeek is rate limited. Try again later.', 429);
        throw new DeepSeekError('DeepSeek could not complete the request. Try again later.');
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof DeepSeekError) throw error;
      // Transport errors and upstream bodies can contain credentials or request data.
      throw new DeepSeekError('Could not reach DeepSeek or read its response. Try again later.');
    }
  }

  async function modelsForKey(key) {
    const payload = await request('/models', key);
    if (!Array.isArray(payload?.data) || payload.data.length > 200) {
      throw new DeepSeekError('DeepSeek returned an invalid model list.');
    }
    const ids = [
      ...new Set(payload.data.map((item) => item?.id).filter((id) => typeof id === 'string' && MODEL_ID.test(id))),
    ];
    return { models: ids.map((id) => ({ id, label: id })) };
  }

  return {
    listModels: async () => modelsForKey(credential()),
    async check(model) {
      if (typeof model !== 'string' || !MODEL_ID.test(model)) {
        throw new DeepSeekError('Select an available DeepSeek model.', 422);
      }
      const key = credential();
      const { models } = await modelsForKey(key);
      if (!models.some((item) => item.id === model)) {
        throw new DeepSeekError('This DeepSeek model is no longer available. Reload the models.', 422);
      }
      const payload = await request('/chat/completions', key, {
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        thinking: { type: 'disabled' },
        max_tokens: 32,
        stream: false,
      });
      const choice = payload?.choices?.[0];
      if (
        choice?.finish_reason !== 'stop' ||
        typeof choice?.message?.content !== 'string' ||
        !choice.message.content.trim() ||
        choice.message.tool_calls?.length
      ) {
        throw new DeepSeekError('DeepSeek did not return a complete text response.');
      }
      return { status: 'ok', model };
    },
  };
}
