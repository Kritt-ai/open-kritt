function withTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function requestHeaders(provider) {
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider.organization) headers['OpenAI-Organization'] = provider.organization;
  for (const [name, value] of Object.entries(provider.extraHeaders || {})) {
    headers[name] = value;
  }
  return headers;
}

async function testEndpoint(url, options) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const body = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error?.message || 'Connection failed.',
    };
  }
}

export async function testCustomProviderConnection(provider) {
  const headers = requestHeaders(provider);
  const baseUrl = withTrailingSlash(provider.baseUrl);
  const attempts = [
  {
    name: 'chat-completions',
    url: new URL('chat/completions', baseUrl),
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: 'user',
            content: 'ping',
          },
        ],
        stream: false,
        max_tokens: 1,
      }),
    },
  },
];

  const failures = [];
  for (const attempt of attempts) {
    const result = await testEndpoint(attempt.url, attempt.options);
    if (result.ok) return { ok: true, endpoint: attempt.name, status: result.status };
    failures.push(result);
  }

  const preferred = failures.find((failure) => failure.status) || failures[0] || { status: 0, body: 'Connection failed.' };
  const error = new Error(preferred.body || 'Connection failed.');
  error.statusCode = preferred.status >= 400 ? preferred.status : 502;
  throw error;
}
