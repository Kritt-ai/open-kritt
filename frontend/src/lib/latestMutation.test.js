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

  it('commits the last accepted choice after the view is disposed without calling it back', async () => {
    const queue = createLatestFieldMutationQueue();
    const first = deferred();
    const stored = [];
    const callbacks = [];

    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: async () => {
        await first.promise;
        stored.push(1);
      },
      onSuccess: () => callbacks.push(1),
    });
    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 0,
      mutate: async () => stored.push(0),
      onSuccess: () => callbacks.push(0),
    });

    expect(queue.overlayRecords([{ id: 'finding-1', interesting: null }])[0].interesting).toBe(0);
    queue.dispose();
    first.resolve();
    await settle();

    expect(stored).toEqual([1, 0]);
    expect(callbacks).toEqual([]);
  });

  it('continues a queued choice after the old write fails on a disposed view', async () => {
    const queue = createLatestFieldMutationQueue();
    const first = deferred();
    const stored = [];
    const callbacks = [];

    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: () => first.promise,
      onError: () => callbacks.push('old failure'),
    });
    queue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 0,
      mutate: async () => stored.push(0),
      onSuccess: () => callbacks.push('new success'),
    });

    queue.dispose();
    first.reject(new Error('old write failed'));
    await settle();

    expect(stored).toEqual([0]);
    expect(callbacks).toEqual([]);
  });

  it('keeps a remounted view choice newer than pending writes from a disposed view', async () => {
    const oldQueue = createLatestFieldMutationQueue();
    const newQueue = createLatestFieldMutationQueue();
    const first = deferred();
    const stored = [];
    const oldCallbacks = [];
    const newCallbacks = [];

    oldQueue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: async () => {
        await first.promise;
        stored.push(1);
      },
      onSuccess: () => oldCallbacks.push(1),
    });
    oldQueue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 0,
      mutate: async () => stored.push(0),
      onSuccess: () => oldCallbacks.push(0),
    });
    oldQueue.dispose();
    newQueue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 2,
      mutate: async () => stored.push(2),
      onSuccess: () => newCallbacks.push(2),
    });

    await settle();
    first.resolve();
    await settle();

    expect(stored).toEqual([1, 2]);
    expect(oldCallbacks).toEqual([]);
    expect(newCallbacks).toEqual([2]);
  });

  it('reconciles a remounted finding fetched before a retained choice settles', async () => {
    const oldQueue = createLatestFieldMutationQueue();
    const first = deferred();
    const second = deferred();
    let stored = null;
    oldQueue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: async () => {
        await first.promise;
        stored = 1;
      },
    });
    oldQueue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 0,
      mutate: async () => {
        await second.promise;
        stored = 0;
      },
    });
    oldQueue.dispose();
    first.resolve();
    await settle();

    const newQueue = createLatestFieldMutationQueue();
    let displayed = newQueue.overlayRecords([{ id: 'finding-1', interesting: stored }])[0].interesting;
    let reloads = 0;
    const unsubscribe = newQueue.subscribe('finding-1', () => {
      reloads += 1;
      displayed = newQueue.overlayRecords([{ id: 'finding-1', interesting: stored }])[0].interesting;
    });
    expect(displayed).toBe(0);
    second.resolve();
    await settle();
    expect(stored).toBe(0);
    expect(displayed).toBe(0);
    expect(reloads).toBe(1);
    unsubscribe();
    newQueue.dispose();
  });

  it('refreshes a remounted finding when its retained choice fails', async () => {
    const oldQueue = createLatestFieldMutationQueue();
    const pending = deferred();
    oldQueue.enqueue({
      scope: 'finding-2',
      field: 'interesting',
      value: 0,
      mutate: () => pending.promise,
    });
    oldQueue.dispose();

    const newQueue = createLatestFieldMutationQueue();
    let displayed = newQueue.overlayRecords([{ id: 'finding-2', interesting: 1 }])[0].interesting;
    let reloads = 0;
    newQueue.subscribe('finding-2', () => {
      reloads += 1;
      displayed = newQueue.overlayRecords([{ id: 'finding-2', interesting: 1 }])[0].interesting;
    });
    expect(displayed).toBe(0);
    pending.reject(new Error('save failed'));
    await settle();
    expect(displayed).toBe(1);
    expect(reloads).toBe(1);
    newQueue.dispose();
  });

  it('lets different finding fields save independently across views', async () => {
    const firstQueue = createLatestFieldMutationQueue();
    const secondQueue = createLatestFieldMutationQueue();
    const first = deferred();
    const stored = [];

    firstQueue.enqueue({
      scope: 'finding-1',
      field: 'interesting',
      value: 1,
      mutate: async () => {
        await first.promise;
        stored.push('first');
      },
    });
    secondQueue.enqueue({
      scope: 'finding-2',
      field: 'interesting',
      value: 0,
      mutate: async () => stored.push('second'),
    });

    await settle();
    expect(stored).toEqual(['second']);
    first.resolve();
    await settle();
    expect(stored).toEqual(['second', 'first']);
  });
});
