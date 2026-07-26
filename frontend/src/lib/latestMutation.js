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
export function createLatestFieldMutationQueue() {
  let sequence = 0;
  let disposed = false;
  const states = new Map();
  const overlays = new Map();

  const keyFor = (scope, field) => `${scope}\u0000${field}`;

  const drain = async (key, state) => {
    if (disposed || state.active || !state.queued) return;
    const item = state.queued;
    state.queued = null;
    state.active = item;

    try {
      const result = await item.mutate();
      const latest = !disposed && overlays.get(key)?.id === item.id && !state.queued;
      if (latest) {
        overlays.delete(key);
        item.onSuccess?.(result);
      }
    } catch (error) {
      const latest = !disposed && overlays.get(key)?.id === item.id && !state.queued;
      if (latest) {
        overlays.delete(key);
        item.onError?.(error);
      }
    } finally {
      state.active = null;
      if (!disposed) {
        if (state.queued) void drain(key, state);
        else states.delete(key);
      }
    }
  };

  return {
    enqueue({ scope = '', field, value, mutate, onSuccess, onError }) {
      if (disposed) return;
      const key = keyFor(scope, field);
      const state = states.get(key) || { active: null, queued: null };
      const item = { id: ++sequence, mutate, onSuccess, onError };
      state.queued = item;
      states.set(key, state);
      overlays.set(key, { id: item.id, scope: String(scope), field, value });
      void drain(key, state);
    },

    overlayRecords(records, idField = 'id') {
      if (!Array.isArray(records) || overlays.size === 0) return records;
      const patches = new Map();
      for (const overlay of overlays.values()) {
        const patch = patches.get(overlay.scope) || {};
        patch[overlay.field] = overlay.value;
        patches.set(overlay.scope, patch);
      }
      return records.map((record) => {
        const patch = patches.get(String(record?.[idField]));
        return patch ? { ...record, ...patch } : record;
      });
    },

    dispose() {
      disposed = true;
      states.clear();
      overlays.clear();
    },
  };
}
