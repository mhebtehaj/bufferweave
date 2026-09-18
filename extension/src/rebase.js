'use strict';

const { BridgeError, requireInteger, requireString } = require('./errors');

function changeStart(change) {
  return change.range_offset;
}

function changeEnd(change) {
  return change.range_offset + change.range_length;
}

function normalizeChanges(changes) {
  const normalized = changes.map((change, index) => {
    const start = requireInteger(change.range_offset, `changes[${index}].range_offset`);
    const length = requireInteger(change.range_length, `changes[${index}].range_length`);
    const text = requireString(change.text, `changes[${index}].text`, { allowEmpty: true });
    return { ...change, range_offset: start, range_length: length, text };
  });

  normalized.sort((left, right) => {
    if (left.range_offset !== right.range_offset) {
      return left.range_offset - right.range_offset;
    }
    return left.range_length - right.range_length;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.range_offset < changeEnd(previous)) {
      throw new BridgeError('INVALID_HISTORY', 'A document-change event contains overlapping ranges');
    }
    if (
      current.range_offset === previous.range_offset &&
      (current.range_length === 0 || previous.range_length === 0)
    ) {
      throw new BridgeError('INVALID_HISTORY', 'A document-change event contains ambiguous same-anchor edits');
    }
  }
  return normalized;
}

function isConflict(range, change) {
  const start = range.start_offset;
  const end = range.end_offset;
  const editStart = changeStart(change);
  const editEnd = changeEnd(change);

  if (start === end) {
    if (editStart === editEnd) {
      return editStart === start;
    }
    if (editStart === start) {
      return true;
    }
    return editStart < start && start < editEnd;
  }

  if (editStart === editEnd) {
    return start < editStart && editStart < end;
  }
  return Math.max(start, editStart) < Math.min(end, editEnd);
}

function transformPointAcrossBatch(point, affinity, changes) {
  let deltaBefore = 0;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    const start = changeStart(change);
    const end = changeEnd(change);
    const replacementLength = change.text.length;
    const delta = replacementLength - change.range_length;

    if (point < start) {
      break;
    }
    // A nonempty change ending at this boundary is entirely to its left. Keep
    // scanning because another change may begin or insert at the same anchor.
    if (change.range_length > 0 && point >= end) {
      deltaBefore += delta;
      continue;
    }
    if (start < point && point < end) {
      return start + deltaBefore + (affinity === 'right' ? replacementLength : 0);
    }
    if (point === start) {
      if (affinity === 'left') {
        return point + deltaBefore;
      }
      let anchoredReplacementLength = 0;
      let anchoredIndex = index;
      while (
        anchoredIndex < changes.length &&
        changeStart(changes[anchoredIndex]) === point
      ) {
        anchoredReplacementLength += changes[anchoredIndex].text.length;
        anchoredIndex += 1;
      }
      return point + deltaBefore + anchoredReplacementLength;
    }
    // Only zero-length changes strictly before the point reach here.
    deltaBefore += delta;
  }
  return point + deltaBefore;
}

function rebaseRangeAcrossBatch(range, rawChanges) {
  const changes = normalizeChanges(rawChanges);
  const conflicts = changes.filter((change) => isConflict(range, change));
  const zeroLength = range.start_offset === range.end_offset;
  const mapped = {
    start_offset: transformPointAcrossBatch(range.start_offset, 'right', changes),
    end_offset: transformPointAcrossBatch(
      range.end_offset,
      zeroLength ? 'right' : 'left',
      changes,
    ),
  };

  if (mapped.end_offset < mapped.start_offset) {
    mapped.end_offset = mapped.start_offset;
  }

  // Preserve the normal boundary affinities above, then widen only for text
  // produced by changes that actually conflict with the target. Using left /
  // right affinities for the whole batch would incorrectly absorb otherwise
  // safe insertions at the target's start or end into conflict metadata.
  const conflictRange = { ...mapped };
  if (conflicts.length > 0) {
    const conflictingChanges = new Set(conflicts);
    let deltaBefore = 0;
    for (const change of changes) {
      const outputStart = changeStart(change) + deltaBefore;
      const outputEnd = outputStart + change.text.length;
      if (conflictingChanges.has(change)) {
        conflictRange.start_offset = Math.min(conflictRange.start_offset, outputStart);
        conflictRange.end_offset = Math.max(conflictRange.end_offset, outputEnd);
      }
      deltaBefore += change.text.length - change.range_length;
    }
  }

  return { range: mapped, conflict_range: conflictRange, conflicts };
}

function rebaseRange(range, records) {
  const base = {
    start_offset: requireInteger(range.start_offset, 'range.start_offset'),
    end_offset: requireInteger(range.end_offset, 'range.end_offset'),
  };
  let current = { ...base };
  if (current.end_offset < current.start_offset) {
    throw new BridgeError('INVALID_REQUEST', 'range.end_offset must be >= range.start_offset');
  }

  let firstConflict = null;
  for (const record of records) {
    const result = rebaseRangeAcrossBatch(current, record.changes);
    if (result.conflicts.length > 0 && firstConflict === null) {
      firstConflict = { record, changes: result.conflicts };
    }
    current = result.conflicts.length > 0 ? result.conflict_range : result.range;
  }
  if (firstConflict !== null) {
    return {
      status: 'conflict',
      range: current,
      record: firstConflict.record,
      changes: firstConflict.changes,
    };
  }
  return { status: 'rebased', range: current };
}

function mapRangeEnvelope(range, records) {
  let current = { ...range };
  for (const record of records) {
    const result = rebaseRangeAcrossBatch(current, record.changes);
    current = result.conflicts.length > 0 ? result.conflict_range : result.range;
  }
  return current;
}

function validateIndependentEdits(edits) {
  const sorted = edits
    .map((edit, index) => ({ ...edit, index }))
    .sort((left, right) => {
      if (left.start_offset !== right.start_offset) {
        return left.start_offset - right.start_offset;
      }
      return left.end_offset - right.end_offset;
    });

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const overlaps = current.start_offset < previous.end_offset;
    const duplicateInsertion =
      current.start_offset === previous.start_offset &&
      current.end_offset === current.start_offset &&
      previous.end_offset === previous.start_offset;
    if (overlaps || duplicateInsertion) {
      throw new BridgeError(
        'INVALID_REQUEST',
        `edits[${previous.index}] and edits[${current.index}] overlap or share an insertion anchor`,
      );
    }
  }
}

function applyEditsToText(text, edits) {
  validateIndependentEdits(edits);
  const descending = [...edits].sort((left, right) => {
    if (left.start_offset !== right.start_offset) {
      return right.start_offset - left.start_offset;
    }
    return right.end_offset - left.end_offset;
  });
  let result = text;
  for (const edit of descending) {
    if (edit.end_offset > result.length) {
      throw new BridgeError('INVALID_REQUEST', 'An edit range extends past the document');
    }
    result =
      result.slice(0, edit.start_offset) +
      edit.replacement_text +
      result.slice(edit.end_offset);
  }
  return result;
}

function normalizeEol(text, eol) {
  return text.replace(/\r\n|\r|\n/g, eol);
}

module.exports = {
  applyEditsToText,
  isConflict,
  normalizeChanges,
  normalizeEol,
  mapRangeEnvelope,
  rebaseRange,
  rebaseRangeAcrossBatch,
  transformPointAcrossBatch,
  validateIndependentEdits,
};
