'use strict';

const crypto = require('node:crypto');
const { BridgeError, requireInteger, requireObject, requireString } = require('./errors');
const { DocumentHistories, publicRecord } = require('./history');
const { KeyedQueue } = require('./queue');
const {
  applyEditsToText,
  normalizeEol,
  rebaseRange,
  validateIndependentEdits,
} = require('./rebase');

function documentResult(snapshot, extra = {}) {
  const { handle, text, positionAt, ...metadata } = snapshot;
  return { ...metadata, ...extra };
}

function rangeWithPositions(snapshot, range) {
  return {
    start_offset: range.start_offset,
    end_offset: range.end_offset,
    start: snapshot.positionAt(range.start_offset),
    end: snapshot.positionAt(range.end_offset),
  };
}

function parseRange(value, textLength, name = 'range') {
  const range = requireObject(value, name);
  const start = requireInteger(range.start_offset, `${name}.start_offset`);
  const end = requireInteger(range.end_offset, `${name}.end_offset`);
  if (end < start) {
    throw new BridgeError('INVALID_REQUEST', `${name}.end_offset must be >= start_offset`);
  }
  if (end > textLength) {
    throw new BridgeError('INVALID_REQUEST', `${name} extends past the document`);
  }
  return { start_offset: start, end_offset: end };
}

function parseEditRequest(params, { preview = false } = {}) {
  requireObject(params);
  requireInteger(params.base_version, 'base_version', 1);
  requireString(params.document_instance_id, 'document_instance_id');
  requireString(params.operation_id, 'operation_id', { maxLength: 128 });
  requireString(params.description, 'description', { maxLength: 500 });
  if (typeof params.save_after_apply !== 'boolean') {
    throw new BridgeError('INVALID_REQUEST', 'save_after_apply must be a boolean');
  }
  if (preview && params.save_after_apply) {
    throw new BridgeError('INVALID_REQUEST', 'previewEdits requires save_after_apply=false');
  }
  if (!Array.isArray(params.edits) || params.edits.length === 0) {
    throw new BridgeError('INVALID_REQUEST', 'edits must be a non-empty array');
  }
  if (params.edits.length > 256) {
    throw new BridgeError('INVALID_REQUEST', 'At most 256 edits are allowed in one transaction');
  }
  return params;
}

class LiveBridgeEngine {
  constructor(adapter, {
    maxHistoryRecords = 256,
    maxHistoryBytes = 4 * 1024 * 1024,
    maxPreviews = 8,
    maxPreviewBytes = 16 * 1024 * 1024,
    maxPreviewContentBytes = 64 * 1024 * 1024,
  } = {}) {
    this.adapter = adapter;
    this.histories = new DocumentHistories({
      maxRecords: maxHistoryRecords,
      maxBytes: maxHistoryBytes,
    });
    this.queue = new KeyedQueue();
    this.previews = new Map();
    // A preview opens UI asynchronously, so reserve its slot, stored request,
    // and base-plus-proposed content before awaiting the adapter. This keeps
    // concurrent document queues from all passing the same global limits.
    this.previewReservations = new Map();
    this.previewWaiters = [];
    this.reservedPreviewBytes = 0;
    this.reservedPreviewContentBytes = 0;
    this.maxPreviews = maxPreviews;
    this.previewBytes = 0;
    this.maxPreviewBytes = maxPreviewBytes;
    this.previewContentBytes = 0;
    this.maxPreviewContentBytes = maxPreviewContentBytes;
    this.previewTtlMilliseconds = 15 * 60 * 1000;
    this.operations = new Map();
    this.maxOperations = 512;
  }

  recordChange(event) {
    if (event.reset) {
      this.histories.delete(event.document_instance_id);
      return;
    }
    try {
      this.histories.get(event.document_instance_id).add({
        from_version: event.from_version,
        to_version: event.to_version,
        source: event.source || 'user_or_disk',
        timestamp: event.timestamp || new Date().toISOString(),
        changes: event.changes,
      });
    } catch {
      this.histories.delete(event.document_instance_id);
    }
  }

  forgetDocument(documentInstanceId) {
    this.histories.delete(documentInstanceId);
    for (const [previewId, preview] of this.previews) {
      if (preview.params.document_instance_id === documentInstanceId) {
        this._removePreview(previewId);
      }
    }
  }

  async handle(method, rawParams = {}, requestContext = {}) {
    const params = requireObject(rawParams);
    switch (method) {
      case 'listWorkspaces':
        return this.adapter.listWorkspaces();
      case 'listOpenDocuments':
        return this.adapter.listOpenDocuments(params);
      case 'readDocument':
        return this.readDocument(params);
      case 'previewEdits':
        return this.previewEdits(params);
      case 'applyEdits':
        return this.applyEdits(params, requestContext);
      case 'saveDocument':
        return this.saveDocument(params, requestContext);
      case 'getDocumentChanges':
        return this.getDocumentChanges(params);
      default:
        throw new BridgeError('METHOD_NOT_FOUND', `Unknown method: ${method}`);
    }
  }

  async readDocument(params) {
    const snapshot = await this.adapter.capture(params);
    const range = params.range
      ? parseRange(params.range, snapshot.text.length)
      : { start_offset: 0, end_offset: snapshot.text.length };
    return documentResult(snapshot, {
      text: snapshot.text.slice(range.start_offset, range.end_offset),
      range: rangeWithPositions(snapshot, range),
    });
  }

  async _historyFor(snapshot, baseVersion) {
    if (baseVersion > snapshot.version) {
      return {
        status: 'future_version',
        current_version: snapshot.version,
      };
    }
    const history = this.histories
      .get(snapshot.document_instance_id)
      .between(baseVersion, snapshot.version);
    if (history.status !== 'available') {
      return {
        status: history.status,
        base_version: baseVersion,
        current_version: snapshot.version,
        earliest_available_version: history.earliest_available_version,
      };
    }
    return history;
  }

  async _prepare(params, snapshot) {
    const history = await this._historyFor(snapshot, params.base_version);
    if (history.status !== 'available') {
      return history;
    }

    const totalHistoryDelta = history.records.reduce(
      (recordTotal, record) => recordTotal + record.changes.reduce(
        (changeTotal, change) => changeTotal + change.text.length - change.range_length,
        0,
      ),
      0,
    );
    const baseDocumentLength = snapshot.text.length - totalHistoryDelta;
    const normalizedEdits = params.edits.map((rawEdit, index) => {
      const edit = requireObject(rawEdit, `edits[${index}]`);
      const range = parseRange(edit, Number.MAX_SAFE_INTEGER, `edits[${index}]`);
      const expected = requireString(
        edit.expected_original_text,
        `edits[${index}].expected_original_text`,
        { allowEmpty: true },
      );
      const replacement = requireString(
        edit.replacement_text,
        `edits[${index}].replacement_text`,
        { allowEmpty: true },
      );
      if (range.end_offset - range.start_offset !== expected.length) {
        throw new BridgeError(
          'INVALID_REQUEST',
          `edits[${index}] range length must equal expected_original_text UTF-16 length`,
        );
      }
      if (range.end_offset > baseDocumentLength) {
        throw new BridgeError(
          'INVALID_REQUEST',
          `edits[${index}] extends past the base-version document`,
        );
      }
      return {
        ...range,
        expected_original_text: expected,
        replacement_text: normalizeEol(replacement, snapshot.eol),
      };
    });
    validateIndependentEdits(normalizedEdits);

    const rebased = [];
    for (let index = 0; index < normalizedEdits.length; index += 1) {
      const edit = normalizedEdits[index];
      const result = rebaseRange(edit, history.records);
      const currentRange = result.range;
      if (result.status === 'conflict') {
        return this._conflictResult({
          snapshot,
          params,
          edit,
          editIndex: index,
          currentRange,
          reason: 'intervening_overlap',
          records: history.records,
          conflictingRecord: result.record,
          conflictingChanges: result.changes,
        });
      }
      rebased.push({
        ...edit,
        ...currentRange,
        base_range: {
          start_offset: edit.start_offset,
          end_offset: edit.end_offset,
        },
      });
    }
    validateIndependentEdits(rebased);

    for (let index = 0; index < rebased.length; index += 1) {
      const edit = rebased[index];
      if (edit.end_offset > snapshot.text.length) {
        return this._conflictResult({
          snapshot,
          params,
          edit: normalizedEdits[index],
          editIndex: index,
          currentRange: {
            start_offset: Math.min(edit.start_offset, snapshot.text.length),
            end_offset: snapshot.text.length,
          },
          reason: 'range_invalidated',
          records: history.records,
        });
      }
      const actual = snapshot.text.slice(edit.start_offset, edit.end_offset);
      if (actual !== edit.expected_original_text) {
        return this._conflictResult({
          snapshot,
          params,
          edit: normalizedEdits[index],
          editIndex: index,
          currentRange: edit,
          reason: 'expected_text_mismatch',
          records: history.records,
        });
      }
    }
    return {
      status: 'ready',
      records: history.records,
      edits: rebased,
      rebased: params.base_version !== snapshot.version,
    };
  }

  _conflictResult({
    snapshot,
    params,
    edit,
    editIndex,
    currentRange,
    reason,
    records,
    conflictingRecord,
    conflictingChanges,
  }) {
    const start = Math.max(0, Math.min(currentRange.start_offset, snapshot.text.length));
    const end = Math.max(start, Math.min(currentRange.end_offset, snapshot.text.length));
    return documentResult(snapshot, {
      status: 'conflict',
      reason,
      base_version: params.base_version,
      current_version: snapshot.version,
      edit_index: editIndex,
      base_text: edit.expected_original_text,
      current_text: snapshot.text.slice(start, end),
      proposed_replacement: edit.replacement_text,
      base_range: {
        start_offset: edit.start_offset,
        end_offset: edit.end_offset,
      },
      current_range: rangeWithPositions(snapshot, { start_offset: start, end_offset: end }),
      intervening_changes: summarizeRecords(records),
      conflicting_version: conflictingRecord?.to_version,
      conflicting_changes: conflictingChanges,
    });
  }

  async previewEdits(params) {
    parseEditRequest(params, { preview: true });
    const requestBytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
    if (requestBytes > this.maxPreviewBytes) {
      throw new BridgeError('PREVIEW_TOO_LARGE', 'Pending preview edit data exceeds 16 MiB');
    }
    const initial = await this.adapter.capture(params);
    return this.queue.run(initial.document_uri, async () => {
      const snapshot = await this.adapter.capture(params);
      const prepared = await this._prepare(params, snapshot);
      if (prepared.status !== 'ready') {
        return prepared;
      }
      const proposedText = applyEditsToText(snapshot.text, prepared.edits);
      const contentBytes = Buffer.byteLength(snapshot.text, 'utf8') +
        Buffer.byteLength(proposedText, 'utf8');
      const previewId = crypto.randomUUID();
      await this._reservePreview(previewId, requestBytes, contentBytes);
      try {
        await this.adapter.showPreview(snapshot, proposedText, params.description, previewId);
      } catch (error) {
        await Promise.resolve(this.adapter.dismissPreview(previewId)).catch(() => undefined);
        this._releasePreviewReservation(previewId);
        throw error;
      }
      this._releasePreviewReservation(previewId, false);
      this.previews.set(previewId, {
        id: previewId,
        created_at: new Date().toISOString(),
        params: structuredClone(params),
        document_uri: snapshot.document_uri,
        description: params.description,
        state: 'pending',
        bytes: requestBytes,
        content_bytes: contentBytes,
        created_at_milliseconds: Date.now(),
      });
      this.previewBytes += requestBytes;
      this.previewContentBytes += contentBytes;
      this._notifyPreviewWaiters();
      return documentResult(snapshot, {
        status: 'preview_ready',
        preview_id: previewId,
        base_version: params.base_version,
        current_version: snapshot.version,
        rebased: prepared.rebased,
        proposed_ranges: prepared.edits.map((edit) => rangeWithPositions(snapshot, edit)),
      });
    });
  }

  listPendingPreviews() {
    this._prunePreviews();
    return [...this.previews.values()].map((preview) => ({
      preview_id: preview.id,
      document_uri: preview.document_uri,
      description: preview.description,
      created_at: preview.created_at,
      state: preview.claim ? 'applying' : preview.state,
    }));
  }

  confirmPreview(previewId) {
    const preview = this.previews.get(previewId);
    if (!preview) {
      return Promise.reject(new BridgeError('PREVIEW_NOT_FOUND', 'The preview no longer exists'));
    }
    if (preview.claim) {
      return preview.claim.promise;
    }
    // A settled non-applied confirmation is not retryable: applyEdits caches
    // its outcome by operation_id. Keep the preview visible for inspection and
    // explicit rejection, but return the same outcome instead of suggesting a
    // fresh attempt could commit it.
    if (preview.settled_result) {
      return Promise.resolve(preview.settled_result);
    }
    if (preview.settled_error) {
      return Promise.reject(preview.settled_error);
    }

    // Claim synchronously, before the first await. Reject, TTL pruning, and
    // capacity eviction all treat this claim as authoritative.
    const claim = { promise: undefined };
    preview.claim = claim;
    preview.state = 'applying';
    claim.promise = this._confirmClaimedPreview(previewId, preview, claim);
    return claim.promise;
  }

  async _confirmClaimedPreview(previewId, preview, claim) {
    try {
      const result = await this.applyEdits(preview.params);
      if (result.status === 'applied') {
        this._removePreview(previewId, false, { allowApplying: true });
        // The buffer commit is authoritative. A preview-UI cleanup failure
        // must not turn that committed edit into an apparent failure.
        await Promise.resolve(this.adapter.dismissPreview(previewId)).catch(() => undefined);
        return result;
      }

      if (this.previews.get(previewId) === preview) {
        preview.state = result.status;
        preview.settled_result = {
          ...result,
          preview_id: previewId,
          preview_state: result.status,
        };
        return preview.settled_result;
      }
      return result;
    } catch (error) {
      if (this.previews.get(previewId) === preview) {
        preview.state = 'failed';
        preview.settled_error = error;
      }
      throw error;
    } finally {
      if (this.previews.get(previewId) === preview && preview.claim === claim) {
        preview.claim = undefined;
        this._notifyPreviewWaiters();
      }
    }
  }

  async rejectPreview(previewId) {
    const preview = this.previews.get(previewId);
    if (!preview) {
      return { status: 'not_found', preview_id: previewId };
    }
    if (preview.claim) {
      return { status: 'applying', preview_id: previewId };
    }
    const existed = this._removePreview(previewId, false);
    if (existed) {
      await this.adapter.dismissPreview(previewId);
    }
    return { status: existed ? 'rejected' : 'not_found', preview_id: previewId };
  }

  _removePreview(previewId, dismiss = true, { allowApplying = false } = {}) {
    const preview = this.previews.get(previewId);
    if (!preview) {
      return false;
    }
    if (preview.claim && !allowApplying) {
      return false;
    }
    this.previews.delete(previewId);
    this.previewBytes -= preview.bytes || 0;
    this.previewContentBytes -= preview.content_bytes || 0;
    this._notifyPreviewWaiters();
    if (dismiss) {
      Promise.resolve(this.adapter.dismissPreview(previewId)).catch(() => undefined);
    }
    return true;
  }

  async _reservePreview(previewId, bytes, contentBytes) {
    if (contentBytes > this.maxPreviewContentBytes) {
      throw new BridgeError('PREVIEW_TOO_LARGE', 'The two-document preview exceeds 64 MiB');
    }
    while (true) {
      this._prunePreviews();
      const count = this.previews.size + this.previewReservations.size;
      const totalBytes = this.previewBytes + this.reservedPreviewBytes + bytes;
      const totalContentBytes = this.previewContentBytes +
        this.reservedPreviewContentBytes + contentBytes;
      if (
        count < this.maxPreviews &&
        totalBytes <= this.maxPreviewBytes &&
        totalContentBytes <= this.maxPreviewContentBytes
      ) {
        this.previewReservations.set(previewId, { bytes, content_bytes: contentBytes });
        this.reservedPreviewBytes += bytes;
        this.reservedPreviewContentBytes += contentBytes;
        return;
      }
      const oldestRemovablePreview = [...this.previews]
        .find(([, preview]) => !preview.claim);
      if (oldestRemovablePreview !== undefined) {
        this._removePreview(oldestRemovablePreview[0]);
        continue;
      }
      await new Promise((resolve) => this.previewWaiters.push(resolve));
    }
  }

  _releasePreviewReservation(previewId, notify = true) {
    const reservation = this.previewReservations.get(previewId);
    if (reservation === undefined) {
      return false;
    }
    this.previewReservations.delete(previewId);
    this.reservedPreviewBytes -= reservation.bytes;
    this.reservedPreviewContentBytes -= reservation.content_bytes;
    if (notify) {
      this._notifyPreviewWaiters();
    }
    return true;
  }

  _notifyPreviewWaiters() {
    for (const resolve of this.previewWaiters.splice(0)) {
      resolve();
    }
  }

  _prunePreviews() {
    const expiry = Date.now() - this.previewTtlMilliseconds;
    for (const [previewId, preview] of this.previews) {
      if (preview.created_at_milliseconds < expiry) {
        this._removePreview(previewId);
      }
    }
  }

  applyEdits(params, requestContext = {}) {
    parseEditRequest(params);
    return this._idempotent('apply', params, () => this._applyEdits(params, requestContext));
  }

  _idempotent(kind, params, operation) {
    const fingerprint = crypto.createHash('sha256').update(stableStringify(params)).digest('hex');
    const operationKey = `${kind}:${params.operation_id}`;
    const existing = this.operations.get(operationKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new BridgeError(
          'OPERATION_ID_REUSED',
          'operation_id was already used with a different request',
        );
      }
      return existing.promise;
    }
    const entry = {
      fingerprint,
      promise: Promise.resolve().then(operation),
      settled: false,
      created_at: Date.now(),
    };
    this.operations.set(operationKey, entry);
    entry.promise.then(
      () => { entry.settled = true; this._pruneOperations(); },
      () => { entry.settled = true; this._pruneOperations(); },
    );
    this._pruneOperations();
    const { promise } = entry;
    return promise;
  }

  _pruneOperations() {
    const expiry = Date.now() - 30 * 60 * 1000;
    for (const [key, entry] of this.operations) {
      if (entry.settled && entry.created_at < expiry) {
        this.operations.delete(key);
      }
    }
    while (this.operations.size > this.maxOperations) {
      const removable = [...this.operations].find(([, entry]) => entry.settled);
      if (!removable) {
        break;
      }
      this.operations.delete(removable[0]);
    }
  }

  async _applyEdits(params, requestContext = {}) {
    const initial = await this.adapter.capture(params);
    return this.queue.run(initial.document_uri, async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const snapshot = await this.adapter.capture(params);
        const prepared = await this._prepare(params, snapshot);
        if (prepared.status !== 'ready') {
          return prepared;
        }
        const application = await this.adapter.applyVersionedEdits(
          snapshot,
          snapshot.version,
          prepared.edits,
          params.description,
          requestContext.assertAuthorized,
        );
        if (!application.applied) {
          continue;
        }
        const appliedRanges = prepared.edits.map((edit) => ({
          base_range: edit.base_range,
          applied_range: rangeWithPositions(snapshot, edit),
        }));
        let updated;
        try {
          updated = await this.adapter.capture(params);
        } catch {
          return documentResult(snapshot, {
            status: 'applied',
            version: application.applied_version,
            base_version: params.base_version,
            previous_version: snapshot.version,
            applied_version: application.applied_version,
            current_version: null,
            current_state_unavailable: true,
            rebased: prepared.rebased,
            saved: false,
            save_status: params.save_after_apply ? 'skipped_current_state_unavailable' : 'not_requested',
            applied_ranges: appliedRanges,
          });
        }
        let saved = false;
        let saveStatus = 'not_requested';
        if (params.save_after_apply) {
          if (updated.version === application.applied_version) {
            try {
              saved = await this.adapter.save(
                updated,
                updated.version,
                requestContext.assertAuthorized,
              );
              saveStatus = saved ? 'saved' : 'save_failed';
            } catch (error) {
              saveStatus = error?.code === 'PERMISSION_REVOKED'
                ? 'skipped_permission_revoked'
                : 'save_outcome_unknown';
            }
            try {
              updated = await this.adapter.capture(params);
            } catch {
              return documentResult(updated, {
                status: 'applied',
                base_version: params.base_version,
                previous_version: snapshot.version,
                applied_version: application.applied_version,
                current_version: null,
                current_state_unavailable: true,
                rebased: prepared.rebased,
                saved,
                save_status: saveStatus,
                applied_ranges: appliedRanges,
              });
            }
          } else {
            saveStatus = 'skipped_newer_version';
          }
        }
        return documentResult(updated, {
          status: 'applied',
          base_version: params.base_version,
          previous_version: snapshot.version,
          applied_version: application.applied_version,
          current_version: updated.version,
          rebased: prepared.rebased,
          saved,
          save_status: saveStatus,
          applied_ranges: appliedRanges,
        });
      }
      const current = await this.adapter.capture(params);
      return documentResult(current, {
        status: 'version_race',
        base_version: params.base_version,
        current_version: current.version,
      });
    });
  }

  async saveDocument(params, requestContext = {}) {
    requireString(params.document_instance_id, 'document_instance_id');
    requireString(params.operation_id, 'operation_id', { maxLength: 128 });
    requireInteger(params.expected_version, 'expected_version', 1);
    return this._idempotent('save', params, () => this._saveDocument(params, requestContext));
  }

  async _saveDocument(params, requestContext = {}) {
    const initial = await this.adapter.capture(params);
    return this.queue.run(initial.document_uri, async () => {
      let snapshot = await this.adapter.capture(params);
      if (snapshot.version !== params.expected_version) {
        return documentResult(snapshot, {
          status: 'stale_version',
          expected_version: params.expected_version,
          current_version: snapshot.version,
        });
      }
      let saved;
      try {
        saved = await this.adapter.save(
          snapshot,
          params.expected_version,
          requestContext.assertAuthorized,
        );
      } catch (error) {
        if (error?.code === 'PERMISSION_REVOKED') {
          return documentResult(snapshot, {
            status: 'permission_revoked',
            expected_version: params.expected_version,
            current_version: snapshot.version,
          });
        }
        return documentResult(snapshot, {
          status: 'save_outcome_unknown',
          expected_version: params.expected_version,
          current_version: snapshot.version,
        });
      }
      try {
        snapshot = await this.adapter.capture(params);
      } catch {
        return documentResult(snapshot, {
          status: saved ? 'saved' : 'save_failed',
          expected_version: params.expected_version,
          current_version: null,
          current_state_unavailable: true,
        });
      }
      return documentResult(snapshot, {
        status: saved ? 'saved' : 'save_failed',
        expected_version: params.expected_version,
        current_version: snapshot.version,
      });
    });
  }

  async getDocumentChanges(params) {
    requireString(params.document_instance_id, 'document_instance_id');
    const baseVersion = requireInteger(params.base_version, 'base_version', 1);
    const snapshot = await this.adapter.capture(params);
    const throughVersion = params.through_version === undefined
      ? snapshot.version
      : requireInteger(params.through_version, 'through_version', baseVersion);
    if (throughVersion > snapshot.version) {
      throw new BridgeError('INVALID_REQUEST', 'through_version is newer than the document');
    }
    const history = this.histories
      .get(snapshot.document_instance_id)
      .between(baseVersion, throughVersion);
    return documentResult(snapshot, {
      status: history.status,
      base_version: baseVersion,
      through_version: throughVersion,
      current_version: snapshot.version,
      earliest_available_version: history.earliest_available_version,
      changes: history.records.map(publicRecord),
    });
  }
}

function summarizeRecords(records) {
  return records.map((record) => ({
    from_version: record.from_version,
    to_version: record.to_version,
    source: record.source,
    timestamp: record.timestamp,
    changes: record.changes.map((change) => ({
      range_offset: change.range_offset,
      range_length: change.range_length,
      inserted_length: change.text.length,
    })),
  }));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  LiveBridgeEngine,
  parseEditRequest,
  parseRange,
  rangeWithPositions,
  stableStringify,
  summarizeRecords,
};
