'use strict';

const { BridgeError } = require('./errors');
const { normalizeChanges } = require('./rebase');

class ChangeHistory {
  constructor({ maxRecords = 256, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.records = [];
    this.bytes = 0;
  }

  clear() {
    this.records = [];
    this.bytes = 0;
  }

  add(record) {
    if (!Number.isSafeInteger(record.from_version) || !Number.isSafeInteger(record.to_version)) {
      throw new BridgeError('INVALID_HISTORY', 'History versions must be integers');
    }
    if (record.to_version <= record.from_version) {
      throw new BridgeError('INVALID_HISTORY', 'History versions must increase');
    }
    const normalized = {
      ...record,
      changes: normalizeChanges(record.changes),
    };
    const last = this.records[this.records.length - 1];
    if (last && last.to_version !== normalized.from_version) {
      this.clear();
    }
    const size = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    normalized._bytes = size;
    this.records.push(normalized);
    this.bytes += size;

    while (this.records.length > this.maxRecords || this.bytes > this.maxBytes) {
      const removed = this.records.shift();
      this.bytes -= removed._bytes;
    }
  }

  between(baseVersion, throughVersion) {
    if (baseVersion === throughVersion) {
      return { status: 'available', records: [] };
    }
    if (baseVersion > throughVersion) {
      return { status: 'future_version', records: [] };
    }

    const firstIndex = this.records.findIndex((record) => record.from_version === baseVersion);
    if (firstIndex < 0) {
      return {
        status: 'stale_version',
        records: [],
        earliest_available_version: this.records[0]?.from_version ?? throughVersion,
      };
    }

    const selected = [];
    let version = baseVersion;
    for (let index = firstIndex; index < this.records.length && version < throughVersion; index += 1) {
      const record = this.records[index];
      if (record.from_version !== version || record.to_version > throughVersion) {
        return {
          status: 'stale_version',
          records: [],
          earliest_available_version: this.records[0]?.from_version ?? throughVersion,
        };
      }
      selected.push(record);
      version = record.to_version;
    }

    if (version !== throughVersion) {
      return {
        status: 'stale_version',
        records: [],
        earliest_available_version: this.records[0]?.from_version ?? throughVersion,
      };
    }
    return { status: 'available', records: selected };
  }
}

class DocumentHistories {
  constructor(options) {
    this.options = options;
    this.histories = new Map();
  }

  get(documentInstanceId) {
    let history = this.histories.get(documentInstanceId);
    if (!history) {
      history = new ChangeHistory(this.options);
      this.histories.set(documentInstanceId, history);
    }
    return history;
  }

  delete(documentInstanceId) {
    this.histories.delete(documentInstanceId);
  }
}

function publicRecord(record) {
  const { _bytes, ...rest } = record;
  return rest;
}

module.exports = { ChangeHistory, DocumentHistories, publicRecord };
