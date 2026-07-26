import { describe, expect, it } from 'vitest';
import {
  GENERATION_POLL_FAILURE_LIMIT,
  generationIsRunning,
  generationPollErrorIsTerminal,
  generationPollShouldRetry,
} from './generationPolling.js';

describe('generation polling state', () => {
  it('treats a missing generation as a terminal polling error', () => {
    const notFound = { status: 404, message: 'Generation not found.' };
    expect(generationPollErrorIsTerminal(notFound)).toBe(true);
    expect(generationIsRunning('123', null, notFound)).toBe(false);
  });

  it('keeps retryable server and rate-limit failures in the running state', () => {
    expect(generationPollErrorIsTerminal({ status: 500 })).toBe(false);
    expect(generationPollErrorIsTerminal({ status: 429 })).toBe(false);
    expect(generationIsRunning('123', null, { status: 500 })).toBe(true);
    expect(generationPollShouldRetry({ status: 500 }, GENERATION_POLL_FAILURE_LIMIT - 1)).toBe(true);
    expect(generationPollShouldRetry({ status: 500 }, GENERATION_POLL_FAILURE_LIMIT)).toBe(false);
    expect(generationPollShouldRetry({ status: 404 }, 1)).toBe(false);
  });

  it('runs only while a job is absent, pending, or running', () => {
    expect(generationIsRunning('123', null, null)).toBe(true);
    expect(generationIsRunning('123', { status: 'pending' }, null)).toBe(true);
    expect(generationIsRunning('123', { status: 'running' }, null)).toBe(true);
    expect(generationIsRunning('123', { status: 'failed' }, null)).toBe(false);
    expect(generationIsRunning('', null, null)).toBe(false);
  });
});
