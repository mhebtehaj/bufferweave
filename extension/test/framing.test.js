'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JsonLineDecoder, encodeMessage } = require('../src/framing');
const { requireString } = require('../src/errors');

test('decodes fragmented and coalesced Unicode JSON lines', () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"x":"'), []);
  const results = decoder.push('α"}\n{"y":2}\n');
  assert.deepEqual(results, [{ x: 'α' }, { y: 2 }]);
  assert.equal(encodeMessage(results[0]), '{"x":"α"}\n');
});

test('rejects malformed and over-limit frames', () => {
  assert.throws(() => new JsonLineDecoder().push('{bad}\n'), { code: 'INVALID_JSON' });
  assert.throws(() => new JsonLineDecoder({ maxBytes: 4 }).push('12345'), {
    code: 'MESSAGE_TOO_LARGE',
  });
});

test('human-readable string limits count Unicode code points, not UTF-16 units', () => {
  assert.equal(requireString('😀'.repeat(500), 'description', { maxLength: 500 }).length, 1000);
  assert.throws(
    () => requireString('😀'.repeat(501), 'description', { maxLength: 500 }),
    { code: 'INVALID_REQUEST' },
  );
});
