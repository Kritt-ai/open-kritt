import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SCAN_PAGE_SIZE,
  MAX_SCAN_PAGE_SIZE,
  SCAN_LIST_ORDER,
  scanListPagination,
} from '../src/routes/scans.js';

test('scan lists sort newest activity first with a stable id tie-breaker', () => {
  assert.deepEqual(SCAN_LIST_ORDER, [{ updatedAt: 'desc' }, { id: 'desc' }]);
});

test('scan pagination remains opt-in for backward-compatible list consumers', () => {
  assert.equal(scanListPagination({}), null);
  assert.equal(scanListPagination({ status: 'completed' }), null);
});

test('scan pagination applies defaults and calculates the database offset', () => {
  assert.deepEqual(scanListPagination({ page: '3' }), {
    page: 3,
    pageSize: DEFAULT_SCAN_PAGE_SIZE,
    skip: DEFAULT_SCAN_PAGE_SIZE * 2,
  });
  assert.deepEqual(scanListPagination({ pageSize: '20' }), { page: 1, pageSize: 20, skip: 0 });
});

test('scan pagination rejects malformed and excessive values', () => {
  assert.throws(
    () => scanListPagination({ page: '0', pageSize: String(MAX_SCAN_PAGE_SIZE + 1) }),
    (error) => {
      assert.deepEqual(error.errors, [
        { field: 'page', message: 'Page must be a positive integer.' },
        { field: 'pageSize', message: `Page size must be between 1 and ${MAX_SCAN_PAGE_SIZE}.` },
      ]);
      return true;
    }
  );
  assert.throws(() => scanListPagination({ page: ['1', '2'] }), /Validation failed/);
});
