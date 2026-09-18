'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChangeHistory } = require('../src/history');
const { KeyedQueue } = require('../src/queue');

function record(from, to, text = 'x') {
  return {
    from_version: from,
    to_version: to,
    changes: [{ range_offset: 0, range_length: 0, text }],
  };
}

test('returns only a complete contiguous version chain', () => {
  const history = new ChangeHistory();
  history.add(record(1, 2));
  history.add(record(2, 4));
  assert.equal(history.between(1, 4).records.length, 2);
  assert.equal(history.between(2, 4).records.length, 1);
  assert.equal(history.between(3, 4).status, 'stale_version');
  assert.equal(history.between(5, 4).status, 'future_version');
});

test('bounded history produces a stale-version result rather than guessing', () => {
  const history = new ChangeHistory({ maxRecords: 2, maxBytes: 1_000_000 });
  history.add(record(1, 2));
  history.add(record(2, 3));
  history.add(record(3, 4));
  assert.equal(history.between(1, 4).status, 'stale_version');
  assert.equal(history.between(2, 4).status, 'available');
});

test('a history gap discards the unsafe old chain', () => {
  const history = new ChangeHistory();
  history.add(record(1, 2));
  history.add(record(7, 8));
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].from_version, 7);
});

test('keyed queue serializes one document but allows different documents concurrently', async () => {
  const queue = new KeyedQueue();
  const events = [];
  let releaseA;
  const firstA = queue.run('a', async () => {
    events.push('a1-start');
    await new Promise((resolve) => { releaseA = resolve; });
    events.push('a1-end');
  });
  const secondA = queue.run('a', async () => events.push('a2'));
  const firstB = queue.run('b', async () => events.push('b1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['a1-start', 'b1']);
  releaseA();
  await Promise.all([firstA, secondA, firstB]);
  assert.deepEqual(events, ['a1-start', 'b1', 'a1-end', 'a2']);
});
