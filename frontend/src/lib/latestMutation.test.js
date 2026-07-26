import { describe, expect, it } from 'vitest';
import { createLatestFieldMutationGate, createLatestFieldMutationQueue } from './latestMutation.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createLatestFieldMutationGate', () => {
  it('ignores an older response for a field with a newer mutation', () => {
    const gate = createLatestFieldMutationGate();
    const first = gate.begin(['interesting']);
    const second = gate.begin(['interesting']);

    expect(gate.currentFields(first)).toEqual([]);
    expect(gate.currentFields(second)).toEqual(['interesting']);
  });

  it('tracks unrelated fields independently', () => {
    const gate = createLatestFieldMutationGate();
    const comment = gate.begin(['comments']);
    const interesting = gate.begin(['interesting']);

    expect(gate.currentFields(comment)).toEqual(['comments']);
    expect(gate.currentFields(interesting)).toEqual(['interesting']);
  });

  it('tracks the same field independently across records', () => {
    const gate = createLatestFieldMutationGate();
    const firstFinding = gate.begin(['interesting'], 'finding-1');
    const secondFinding = gate.begin(['interesting'], 'finding-2');

    expect(gate.currentFields(firstFinding)).toEqual(['interesting']);
    expect(gate.currentFields(secondFinding)).toEqual(['interesting']);
  });
});

describe('createLatestFieldMutationQueue', () => {
  it('serializes writes and sends the newest value last', async () => {
    const queue = createLatestFieldMutationQueue();
    const first = deferred();
    const calls = [];
    const successes = [];

    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: () => {
        calls.push(1);
        return first.promise;
      },
      onSuccess: () => successes.push(1),
    });
    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 0,
      mutate: async () => {
        calls.push(0);
        return { interesting: 0 };
      },
      onSuccess: () => successes.push(0),
    });

    expect(calls).toEqual([1]);
    first.resolve({ interesting: 1 });
    await settle();

    expect(calls).toEqual([1, 0]);
    expect(successes).toEqual([0]);
  });

  it('coalesces queued values while preserving the latest optimistic overlay', async () => {
    const queue = createLatestFieldMutationQueue();
    const first = deferred();
    const calls = [];

    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: () => first.promise,
    });
    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 0,
      mutate: async () => calls.push(0),
    });
    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: null,
      mutate: async () => calls.push(null),
    });

    expect(queue.overlayRecords([{ id: 'finding-1', interesting: 0 }])).toEqual([
      { id: 'finding-1', interesting: null },
    ]);
    first.resolve({ interesting: 1 });
    await settle();

    expect(calls).toEqual([null]);
  });

  it('reports only a latest failure and removes its overlay', async () => {
    const queue = createLatestFieldMutationQueue();
    const errors = [];

    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: async () => {
        throw new Error('save failed');
      },
      onError: (error) => errors.push(error.message),
    });
    await settle();

    expect(errors).toEqual(['save failed']);
    expect(queue.overlayRecords([{ id: 'finding-1', interesting: 0 }])).toEqual([{ id: 'finding-1', interesting: 0 }]);
  });
});
