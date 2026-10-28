// Tracks the newest mutation independently for each field. This lets an
// optimistic UI ignore a slow failure/success after the user has already sent
// a newer value for the same field.
export function createLatestFieldMutationGate() {
  let sequence = 0;
  const latestByField = new Map();

  return {
    begin(fields, scope = '') {
      const id = ++sequence;
      const entries = fields.map((field) => ({ field, key: `${scope}\u0000${field}` }));
      for (const { key } of entries) latestByField.set(key, id);
      return { id, entries };
    },
    currentFields(request) {
      return request.entries.filter(({ key }) => latestByField.get(key) === request.id).map(({ field }) => field);
    },
  };
}

// Serializes writes independently for each record field. While one request is
// active, newer values replace the queued value for that field. This guarantees
// that the final request reaching the server is also the newest user choice,
// rather than merely ignoring an older response after it has already won in the
// database.
// Route remounts create new queue instances, so in-flight writes for one field
// must share a lane across instances as well as within one view.
const pendingFieldWrites = new Map();
const settledListeners = new Map();
let fieldWriteSequence = 0;

async function drainFieldWrite(key, state) {
  if (state.active || !state.queued) return;
  const item = state.queued;
  state.queued = null;
  state.active = item;

  try {
    const result = await item.mutate();
    const latest = !item.owner.disposed && item.owner.overlays.get(key)?.id === item.id && !state.queued;
    if (latest) {
      item.owner.overlays.delete(key);
      item.onSuccess?.(result);
    }
  } catch (error) {
    const latest = !item.owner.disposed && item.owner.overlays.get(key)?.id === item.id && !state.queued;
    if (latest) {
      item.owner.overlays.delete(key);
      item.onError?.(error);
    }
  } finally {
    state.active = null;
    if (state.queued) void drainFieldWrite(key, state);
    else {
      pendingFieldWrites.delete(key);
      for (const subscription of settledListeners.get(item.scope) || []) {
        if (subscription.owner !== item.owner && !subscription.owner.disposed) subscription.listener();
      }
    }
  }
}

export function createLatestFieldMutationQueue() {
  const owner = { disposed: false, overlays: new Map(), subscriptions: new Set() };

  return {
    enqueue({ scope = '', field, value, mutate, onSuccess, onError }) {
      if (owner.disposed) return;
      const key = `${scope}\u0000${field}`;
      const state = pendingFieldWrites.get(key) || { active: null, queued: null };
      const item = { id: ++fieldWriteSequence, owner, scope: String(scope), field, value, mutate, onSuccess, onError };
      state.active?.owner.overlays.delete(key);
      state.queued?.owner.overlays.delete(key);
      state.queued = item;
      pendingFieldWrites.set(key, state);
      owner.overlays.set(key, { id: item.id, scope: String(scope), field, value });
      void drainFieldWrite(key, state);
    },

    overlayRecords(records, idField = 'id') {
      if (!Array.isArray(records) || pendingFieldWrites.size === 0) return records;
      const patches = new Map();
      for (const state of pendingFieldWrites.values()) {
        const pending = state.queued || state.active;
        if (!pending) continue;
        const patch = patches.get(pending.scope) || {};
        patch[pending.field] = pending.value;
        patches.set(pending.scope, patch);
      }
      return records.map((record) => {
        const patch = patches.get(String(record?.[idField]));
        return patch ? { ...record, ...patch } : record;
      });
    },

    subscribe(scope, listener) {
      if (owner.disposed) return () => {};
      const key = String(scope);
      const subscribers = settledListeners.get(key) || new Set();
      const subscription = { owner, listener };
      subscribers.add(subscription);
      settledListeners.set(key, subscribers);
      const unsubscribe = () => {
        subscribers.delete(subscription);
        owner.subscriptions.delete(unsubscribe);
        if (subscribers.size === 0) settledListeners.delete(key);
      };
      owner.subscriptions.add(unsubscribe);
      return unsubscribe;
    },

    dispose() {
      owner.disposed = true;
      owner.overlays.clear();
      for (const unsubscribe of owner.subscriptions) unsubscribe();
    },
  };
}
