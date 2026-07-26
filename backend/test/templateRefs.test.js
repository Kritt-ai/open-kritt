import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TEMPLATE_REF_MALFORMED_SAMPLE_LIMIT,
  hasMalformedTemplateRefs,
  parseRefs,
  parseTemplateRefs,
} from '../src/lib/constants.js';

test('template parsing preserves valid inner references while reporting malformed braces', () => {
  const content = 'stray }} {{bad-key}} {{outer {{repo_full}} {{ extra.impact_1 }} {{unclosed';
  const parsed = parseTemplateRefs(content);

  assert.deepEqual(parsed.refs, ['repo_full', 'extra.impact_1']);
  assert.equal(parsed.malformed.length, 4);
  assert.equal(hasMalformedTemplateRefs(content), true);
  assert.deepEqual(parseRefs(content), parsed.refs);
});

test('template parsing bounds diagnostics for large repeated, nested, and unmatched openers', () => {
  // This remains below the API's 2 MB body limit and forces the parser through
  // the adversarial shape without relying on timing. The valid token near the
  // end proves that reaching the sample cap does not stop reference parsing.
  const content = `${'{{'.repeat(899_999)}{{repo_full}} {{unclosed`;
  const parsed = parseTemplateRefs(content);

  assert.deepEqual(parsed.refs, ['repo_full']);
  assert.equal(parsed.malformed.length, TEMPLATE_REF_MALFORMED_SAMPLE_LIMIT);
  assert.ok(parsed.malformed.every((sample) => sample.length <= 200));
  assert.equal(hasMalformedTemplateRefs(content), true);
  assert.deepEqual(parseRefs(content), ['repo_full']);
});
