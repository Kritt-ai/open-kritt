import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SCAN_PAGE_SIZE,
  findingExportSourceProfile,
  MAX_SCAN_PAGE_SIZE,
  SCAN_LIST_ORDER,
  scanListPagination,
  serializedScanVulnerabilities,
} from '../src/routes/scans.js';
import {
  FindingExportTooManyFindingsError,
  FindingExportTooManyRelatedRecordsError,
} from '../src/lib/findingExport.js';

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

test('bounded finding reads stop before loading related export data', async () => {
  let query;
  const db = {
    vulnerability: {
      findMany: async (options) => {
        query = options;
        return [{ id: 1n }, { id: 2n }, { id: 3n }];
      },
    },
    vulnerabilityEnrichment: {
      findMany: async () => assert.fail('enrichments must not load after the finding limit is exceeded'),
    },
  };

  await assert.rejects(
    () => serializedScanVulnerabilities(7n, { maxFindings: 2, db }),
    FindingExportTooManyFindingsError
  );
  assert.equal(query.take, 3);
  assert.deepEqual(query.where, {
    scanId: 7n,
    OR: [{ dedupeIsCanonical: true }, { dedupeIsCanonical: null }],
  });
});

test('finding export source profiles preserve database byte counts as bigints', async () => {
  const profile = await findingExportSourceProfile(7n, {
    db: {
      $queryRaw: async () => [
        {
          findingCount: 3n,
          enrichmentCount: 4n,
          duplicateCount: 2n,
          totalBytes: 1024n,
          largestRecordBytes: 512n,
        },
      ],
    },
  });

  assert.deepEqual(profile, {
    findingCount: 3n,
    enrichmentCount: 4n,
    duplicateCount: 2n,
    totalBytes: 1024n,
    largestRecordBytes: 512n,
  });
});

test('bounded finding reads cap related post-processing records', async () => {
  let enrichmentQuery;
  const db = {
    vulnerability: { findMany: async () => [{ id: 1n }] },
    vulnerabilityEnrichment: {
      findMany: async (options) => {
        enrichmentQuery = options;
        return [{ id: 1n }, { id: 2n }, { id: 3n }];
      },
    },
  };

  await assert.rejects(
    () => serializedScanVulnerabilities(7n, { maxFindings: 2, maxRelatedRecords: 2, db }),
    FindingExportTooManyRelatedRecordsError
  );
  assert.equal(enrichmentQuery.take, 3);
});
