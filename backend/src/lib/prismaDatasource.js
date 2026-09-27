const DEFAULT_CONNECTION_LIMIT = 5;
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function prismaDatasourceUrl(rawUrl, env = process.env) {
  if (!rawUrl) return rawUrl;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) return rawUrl;
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set(
      'connection_limit',
      `${boundedPositiveInteger(env.BACKEND_DB_CONNECTION_LIMIT, DEFAULT_CONNECTION_LIMIT, 20)}`
    );
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set(
      'pool_timeout',
      `${boundedPositiveInteger(env.BACKEND_DB_POOL_TIMEOUT_SECONDS, DEFAULT_POOL_TIMEOUT_SECONDS, 300)}`
    );
  }
  return url.toString();
}
