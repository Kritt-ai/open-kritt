import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_PAGE_SIZE, newestFirst, paginate } from './pagination.js';

export function useNewestFirst(items, dateKey = 'insertedAt') {
  return useMemo(() => newestFirst(items, dateKey), [dateKey, items]);
}

export function usePagination(items, { pageSize = DEFAULT_PAGE_SIZE, resetKey } = {}) {
  const [state, setState] = useState({ page: 1, resetKey });
  const resetChanged = !Object.is(state.resetKey, resetKey);
  const pagination = paginate(items, resetChanged ? 1 : state.page, pageSize);

  useEffect(() => {
    if (!resetChanged && state.page === pagination.page) return;
    setState({ page: pagination.page, resetKey });
  }, [pagination.page, resetChanged, resetKey, state.page]);

  const setPage = useCallback(
    (nextPage) => {
      setState((current) => ({
        page: typeof nextPage === 'function' ? nextPage(current.page) : nextPage,
        resetKey,
      }));
    },
    [resetKey]
  );

  return { ...pagination, setPage };
}
