export const GENERATION_POLL_FAILURE_LIMIT = 8;

export function generationPollErrorIsTerminal(error) {
  const status = Number(error?.status);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function generationPollShouldRetry(error, failureCount, limit = GENERATION_POLL_FAILURE_LIMIT) {
  return !generationPollErrorIsTerminal(error) && failureCount < limit;
}

export function generationIsRunning(generationId, job, pollError) {
  if (!generationId || generationPollErrorIsTerminal(pollError)) return false;
  return !job || job.status === 'pending' || job.status === 'running';
}
