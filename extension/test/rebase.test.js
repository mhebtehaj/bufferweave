'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyEditsToText,
  normalizeEol,
  rebaseRange,
  rebaseRangeAcrossBatch,
} = require('../src/rebase');

function applyHistory(base, records) {
  return records.reduce((text, record) => applyEditsToText(
    text,
    record.changes.map((change) => ({
      start_offset: change.range_offset,
      end_offset: change.range_offset + change.range_length,
      replacement_text: change.text,
    })),
  ), base);
}

test('rebases a target over a simultaneous deletion ending at its start and boundary insertions', () => {
  const base = 'ABCDE';
  const changes = [
    { range_offset: 0, range_length: 3, text: '' },
    { range_offset: 3, range_length: 0, text: 'x' },
    { range_offset: 5, range_length: 0, text: 'y' },
  ];
  const current = applyEditsToText(base, changes.map((change) => ({
    start_offset: change.range_offset,
    end_offset: change.range_offset + change.range_length,
    replacement_text: change.text,
  })));
  const result = rebaseRangeAcrossBatch({ start_offset: 3, end_offset: 5 }, changes);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.range, { start_offset: 1, end_offset: 3 });
  assert.equal(current.slice(result.range.start_offset, result.range.end_offset), 'DE');
});

test('defines deterministic insertion boundary behavior', () => {
  const target = { start_offset: 2, end_offset: 5 };
  const atStart = rebaseRangeAcrossBatch(target, [
    { range_offset: 2, range_length: 0, text: 'X' },
  ]);
  assert.deepEqual(atStart.range, { start_offset: 3, end_offset: 6 });
  assert.equal(atStart.conflicts.length, 0);

  const atEnd = rebaseRangeAcrossBatch(target, [
    { range_offset: 5, range_length: 0, text: 'X' },
  ]);
  assert.deepEqual(atEnd.range, target);
  assert.equal(atEnd.conflicts.length, 0);

  const inside = rebaseRangeAcrossBatch(target, [
    { range_offset: 3, range_length: 0, text: 'X' },
  ]);
  assert.equal(inside.conflicts.length, 1);

  const sameAnchor = rebaseRangeAcrossBatch(
    { start_offset: 2, end_offset: 2 },
    [{ range_offset: 2, range_length: 0, text: 'user' }],
  );
  assert.equal(sameAnchor.conflicts.length, 1);
});

test('touching replacements remain non-overlapping while true overlaps conflict', () => {
  assert.equal(rebaseRangeAcrossBatch(
    { start_offset: 3, end_offset: 5 },
    [{ range_offset: 0, range_length: 3, text: 'q' }],
  ).conflicts.length, 0);
  assert.equal(rebaseRangeAcrossBatch(
    { start_offset: 3, end_offset: 5 },
    [{ range_offset: 5, range_length: 2, text: 'q' }],
  ).conflicts.length, 0);
  assert.equal(rebaseRangeAcrossBatch(
    { start_offset: 3, end_offset: 5 },
    [{ range_offset: 4, range_length: 2, text: 'q' }],
  ).conflicts.length, 1);
});

test('random conflict-free batches preserve the exact target substring', () => {
  let seed = 0x5eed1234;
  const random = (maximum) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % maximum;
  };
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const base = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const start = 2 + random(20);
    const end = start + 1 + random(Math.min(8, base.length - start));
    const leftEnd = random(start + 1);
    const leftStart = random(leftEnd + 1);
    const rightStart = end + random(base.length - end + 1);
    const rightEnd = rightStart + random(base.length - rightStart + 1);
    const changes = [];
    if (leftEnd > leftStart) {
      changes.push({ range_offset: leftStart, range_length: leftEnd - leftStart, text: `L${iteration % 7}` });
    }
    if (iteration % 3 === 0) {
      changes.push({ range_offset: start, range_length: 0, text: 'S' });
    } else if (iteration % 3 === 1) {
      changes.push({ range_offset: end, range_length: 0, text: 'E' });
    }
    if (rightEnd > rightStart && rightStart !== start && rightStart !== end) {
      changes.push({ range_offset: rightStart, range_length: rightEnd - rightStart, text: 'R' });
    }
    const current = applyEditsToText(base, changes.map((change) => ({
      start_offset: change.range_offset,
      end_offset: change.range_offset + change.range_length,
      replacement_text: change.text,
    })));
    const result = rebaseRangeAcrossBatch({ start_offset: start, end_offset: end }, changes);
    assert.equal(result.conflicts.length, 0, `iteration ${iteration}`);
    assert.equal(
      current.slice(result.range.start_offset, result.range.end_offset),
      base.slice(start, end),
      `iteration ${iteration}`,
    );
  }
});

test('rebases across several version records in UTF-16 offsets', () => {
  const base = 'A😀β\nC';
  const targetStart = base.indexOf('β');
  const targetEnd = targetStart + 'β'.length;
  const result = rebaseRange(
    { start_offset: targetStart, end_offset: targetEnd },
    [
      { from_version: 1, to_version: 2, changes: [{ range_offset: 0, range_length: 0, text: 'λ' }] },
      { from_version: 2, to_version: 3, changes: [{ range_offset: 1, range_length: 0, text: '😀' }] },
    ],
  );
  assert.equal(result.status, 'rebased');
  assert.deepEqual(result.range, {
    start_offset: targetStart + 'λ'.length + '😀'.length,
    end_offset: targetEnd + 'λ'.length + '😀'.length,
  });
});

test('conflict envelope contains an exact replacement after later prefix edits', () => {
  const records = [
    {
      from_version: 1,
      to_version: 2,
      changes: [{ range_offset: 2, range_length: 3, text: 'CURRENT' }],
    },
    {
      from_version: 2,
      to_version: 3,
      changes: [{ range_offset: 0, range_length: 0, text: 'PREFIX' }],
    },
  ];
  const result = rebaseRange({ start_offset: 2, end_offset: 5 }, records);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.range, { start_offset: 8, end_offset: 15 });
  assert.equal('PREFIXabCURRENTf'.slice(result.range.start_offset, result.range.end_offset), 'CURRENT');
});

test('conflict metadata excludes nonconflicting insertions at the target start', () => {
  const base = 'abCDEf';
  const histories = [
    {
      records: [
        {
          from_version: 1,
          to_version: 2,
          changes: [{ range_offset: 2, range_length: 0, text: 'S' }],
        },
        {
          from_version: 2,
          to_version: 3,
          changes: [{ range_offset: 4, range_length: 1, text: 'X' }],
        },
      ],
      current: 'abSCXEf',
      currentText: 'CXE',
    },
    {
      records: [
        {
          from_version: 1,
          to_version: 2,
          changes: [
            { range_offset: 2, range_length: 0, text: 'S' },
            { range_offset: 3, range_length: 1, text: 'X' },
          ],
        },
      ],
      current: 'abSCXEf',
      currentText: 'CXE',
    },
    {
      records: [
        {
          from_version: 1,
          to_version: 2,
          changes: [{ range_offset: 3, range_length: 1, text: 'X' }],
        },
        {
          from_version: 2,
          to_version: 3,
          changes: [{ range_offset: 2, range_length: 0, text: 'S' }],
        },
      ],
      current: 'abSCXEf',
      currentText: 'CXE',
    },
  ];

  for (const scenario of histories) {
    const current = applyHistory(base, scenario.records);
    assert.equal(current, scenario.current);
    const result = rebaseRange({ start_offset: 2, end_offset: 5 }, scenario.records);
    assert.equal(result.status, 'conflict');
    assert.deepEqual({
      current_range: result.range,
      current_text: current.slice(result.range.start_offset, result.range.end_offset),
    }, {
      current_range: { start_offset: 3, end_offset: 6 },
      current_text: scenario.currentText,
    });
  }
});

test('rejects an ambiguous insertion and conflicting replacement at the same start anchor', () => {
  assert.throws(
    () => rebaseRangeAcrossBatch(
      { start_offset: 2, end_offset: 5 },
      [
        { range_offset: 2, range_length: 0, text: 'S' },
        { range_offset: 2, range_length: 1, text: 'X' },
      ],
    ),
    (error) => error.code === 'INVALID_HISTORY' && /ambiguous same-anchor edits/.test(error.message),
  );
});

test('conflict metadata excludes nonconflicting insertions at the target end', () => {
  const base = 'abCDEf';
  const histories = [
    {
      records: [
        {
          from_version: 1,
          to_version: 2,
          changes: [{ range_offset: 5, range_length: 0, text: 'T' }],
        },
        {
          from_version: 2,
          to_version: 3,
          changes: [{ range_offset: 3, range_length: 1, text: 'X' }],
        },
      ],
      current: 'abCXETf',
      currentText: 'CXE',
    },
    {
      records: [
        {
          from_version: 1,
          to_version: 2,
          changes: [
            { range_offset: 4, range_length: 1, text: 'X' },
            { range_offset: 5, range_length: 0, text: 'T' },
          ],
        },
      ],
      current: 'abCDXTf',
      currentText: 'CDX',
    },
    {
      records: [
        {
          from_version: 1,
          to_version: 2,
          changes: [{ range_offset: 3, range_length: 1, text: 'X' }],
        },
        {
          from_version: 2,
          to_version: 3,
          changes: [{ range_offset: 5, range_length: 0, text: 'T' }],
        },
      ],
      current: 'abCXETf',
      currentText: 'CXE',
    },
  ];

  for (const scenario of histories) {
    const current = applyHistory(base, scenario.records);
    assert.equal(current, scenario.current);
    const result = rebaseRange({ start_offset: 2, end_offset: 5 }, scenario.records);
    assert.equal(result.status, 'conflict');
    assert.deepEqual({
      current_range: result.range,
      current_text: current.slice(result.range.start_offset, result.range.end_offset),
    }, {
      current_range: { start_offset: 2, end_offset: 5 },
      current_text: scenario.currentText,
    });
  }
});

test('normalizes replacement line endings to the document EOL without touching other text', () => {
  const base = 'one\r\ntwo\r\n';
  const replacement = normalizeEol('α\nβ\rγ\r\n', '\r\n');
  const result = applyEditsToText(base, [{
    start_offset: 5,
    end_offset: 8,
    replacement_text: replacement,
  }]);
  assert.equal(result, 'one\r\nα\r\nβ\r\nγ\r\n\r\n');
});
