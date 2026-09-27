import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apiErrorHandler } from '../src/app.js';

function respond() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const quietReq = { log: { error() {} } };

test('an error with a client status keeps its status and message', () => {
  const error = new Error('Cannot change a running scan to pending.');
  error.status = 409;
  const res = respond();
  apiErrorHandler(error, quietReq, res, () => {});
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'Cannot change a running scan to pending.' });
});

test('errors without a client status stay generic 500s', () => {
  for (const status of [undefined, 500, 503]) {
    const error = new Error('database password is hunter2');
    if (status) error.status = status;
    const res = respond();
    apiErrorHandler(error, quietReq, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error.' });
  }
});
