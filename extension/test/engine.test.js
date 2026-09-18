'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { LiveBridgeEngine } = require('../src/engine');
const { BridgeError } = require('../src/errors');
const { FakeAdapter } = require('./fake-adapter');

function setup(options) {
  const adapter = new FakeAdapter(options);
  const engine = new LiveBridgeEngine(adapter, {
    maxHistoryRecords: options?.maxHistoryRecords || 256,
    maxHistoryBytes: 1_000_000,
  });
  adapter.connect(engine);
  return { adapter, engine };
}

function selector(adapter) {
  return {
    path: adapter.document.path,
    document_instance_id: adapter.document.document_instance_id,
    window_id: adapter.windowId,
    workspace_id: adapter.workspaceId,
  };
}

function editRequest(adapter, overrides = {}) {
  const text = adapter.document.text;
  const start = text.indexOf('beta');
  return {
    ...selector(adapter),
    operation_id: `operation-${Math.random()}`,
    base_version: adapter.document.version,
    description: 'Replace beta',
    save_after_apply: false,
    edits: [{
      start_offset: start,
      end_offset: start + 4,
      expected_original_text: 'beta',
      replacement_text: 'BETA',
    }],
    ...overrides,
  };
}

test('reads complete unsaved live-buffer text and metadata', async () => {
  const { adapter, engine } = setup({ text: 'saved + unsaved', dirty: true });
  const result = await engine.readDocument({ path: adapter.document.path });
  assert.equal(result.text, 'saved + unsaved');
  assert.equal(result.is_dirty, true);
  assert.equal(result.document_instance_id, adapter.document.document_instance_id);
  assert.equal(result.version, 1);
});

test('applies immediately as one transaction and one undo restores the buffer', async () => {
  const { adapter, engine } = setup();
  const original = adapter.document.text;
  const result = await engine.applyEdits(editRequest(adapter));
  assert.equal(result.status, 'applied');
  assert.equal(adapter.document.text, 'alpha BETA gamma');
  assert.equal(adapter.document.undoStack.length, 1);
  assert.equal(adapter.undo(), true);
  assert.equal(adapter.document.text, original);
  assert.equal(adapter.document.undoStack.length, 0);
});

test('revocation at the editor boundary prevents a queued edit from committing', async () => {
  const { adapter, engine } = setup();
  let authorized = true;
  adapter.beforeApply = () => { authorized = false; };
  const assertAuthorized = () => {
    if (!authorized) {
      throw new BridgeError('PERMISSION_REVOKED', 'revoked');
    }
  };
  await assert.rejects(
    engine.applyEdits(editRequest(adapter), { assertAuthorized }),
    (error) => error?.code === 'PERMISSION_REVOKED',
  );
  assert.equal(adapter.document.text, 'alpha beta gamma');
  assert.equal(adapter.document.version, 1);
});

test('revocation at the save boundary prevents persistence', async () => {
  const { adapter, engine } = setup({ dirty: true });
  let authorized = true;
  adapter.beforeSave = () => { authorized = false; };
  const result = await engine.saveDocument({
    ...selector(adapter),
    operation_id: 'revoked-save',
    expected_version: adapter.document.version,
  }, {
    assertAuthorized: () => {
      if (!authorized) {
        throw new BridgeError('PERMISSION_REVOKED', 'revoked');
      }
    },
  });
  assert.equal(result.status, 'permission_revoked');
  assert.equal(adapter.document.saveCount, 0);
  assert.equal(adapter.document.is_dirty, true);
});

test('rebases over a user edit elsewhere and applies safely', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter);
  adapter.userEdit(0, 0, 'USER ');
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'applied');
  assert.equal(result.rebased, true);
  assert.equal(adapter.document.text, 'USER alpha BETA gamma');
});

test('rejects an overlapping user edit without modifying the newer buffer', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter);
  adapter.userEdit(7, 8, 'X');
  const beforeAttempt = adapter.document.text;
  const versionBeforeAttempt = adapter.document.version;
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'intervening_overlap');
  assert.equal(result.base_text, 'beta');
  assert.equal(result.proposed_replacement, 'BETA');
  assert.equal(adapter.document.text, beforeAttempt);
  assert.equal(adapter.document.version, versionBeforeAttempt);
  assert.ok(result.conflicting_changes[0].old_text);
  assert.equal(result.intervening_changes[0].changes[0].text, undefined);
});

test('retries a version-guard race, then rebases a non-overlapping keystroke', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter);
  adapter.beforeApply = () => adapter.userEdit(0, 0, 'RACE ');
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'applied');
  assert.equal(result.rebased, true);
  assert.equal(adapter.document.text, 'RACE alpha BETA gamma');
});

test('a version-guard race inside the target becomes a conflict, not a write', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter);
  adapter.beforeApply = () => adapter.userEdit(7, 8, 'x');
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'conflict');
  assert.equal(adapter.document.text, 'alpha bxta gamma');
  assert.equal(adapter.document.undoStack.length, 0);
});

test('reports applied and later current versions distinctly and skips saving newer typing', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter, { save_after_apply: true });
  adapter.afterApply = () => adapter.userEdit(adapter.document.text.length, adapter.document.text.length, '!');
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'applied');
  assert.equal(result.applied_version, 2);
  assert.equal(result.current_version, 3);
  assert.equal(result.save_status, 'skipped_newer_version');
  assert.equal(adapter.document.saveCount, 0);
  assert.equal(adapter.document.text, 'alpha BETA gamma!');
});

test('never turns a committed edit into a no-write error when post-commit capture fails', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter, { operation_id: 'post-commit-capture' });
  adapter.afterApply = () => { adapter.captureFailures = 1; };
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'applied');
  assert.equal(result.current_state_unavailable, true);
  assert.equal(adapter.document.text, 'alpha BETA gamma');
});

test('reports save outcome uncertainty without hiding the committed buffer edit', async () => {
  const { adapter, engine } = setup();
  adapter.saveFailures = 1;
  const result = await engine.applyEdits(editRequest(adapter, {
    operation_id: 'post-commit-save',
    save_after_apply: true,
  }));
  assert.equal(result.status, 'applied');
  assert.equal(result.save_status, 'save_outcome_unknown');
  assert.equal(adapter.document.text, 'alpha BETA gamma');
});

test('two chats editing disjoint ranges from the same version both commit via serialized rebase', async () => {
  const { adapter, engine } = setup({ text: 'one two three' });
  adapter.applyDelay = 10;
  const base = selector(adapter);
  const first = engine.applyEdits({
    ...base,
    operation_id: 'queue-one',
    base_version: 1,
    description: 'First queued edit',
    save_after_apply: false,
    edits: [{
      start_offset: 0,
      end_offset: 3,
      expected_original_text: 'one',
      replacement_text: 'ONE-EXPANDED',
    }],
  });
  const second = engine.applyEdits({
    ...base,
    operation_id: 'queue-two',
    base_version: 1,
    description: 'Second queued edit',
    save_after_apply: false,
    edits: [{
      start_offset: 8,
      end_offset: 13,
      expected_original_text: 'three',
      replacement_text: 'THREE',
    }],
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.status), ['applied', 'applied']);
  assert.deepEqual(results.map((result) => result.rebased), [false, true]);
  assert.deepEqual(results.map((result) => result.previous_version), [1, 2]);
  assert.deepEqual(results.map((result) => result.applied_version), [2, 3]);
  assert.equal(adapter.document.text, 'ONE-EXPANDED two THREE');
  assert.equal(adapter.maxActiveApplies, 1);
  assert.equal(adapter.document.undoStack.length, 2);

  const changes = await engine.getDocumentChanges({
    ...base,
    base_version: 1,
  });
  assert.equal(changes.status, 'available');
  assert.deepEqual(changes.changes.map((record) => record.source), ['agent', 'agent']);

  assert.equal(adapter.undo(), true);
  assert.equal(adapter.document.text, 'ONE-EXPANDED two three');
  assert.equal(adapter.undo(), true);
  assert.equal(adapter.document.text, 'one two three');
});

test('two chats editing the same base range produce one commit and one conflict without a partial write', async () => {
  const { adapter, engine } = setup();
  adapter.applyDelay = 10;
  const common = {
    ...selector(adapter),
    base_version: 1,
    description: 'Competing beta edit',
    save_after_apply: false,
  };
  const makeRequest = (operationId, replacementText) => ({
    ...common,
    operation_id: operationId,
    edits: [{
      start_offset: 6,
      end_offset: 10,
      expected_original_text: 'beta',
      replacement_text: replacementText,
    }],
  });

  const results = await Promise.all([
    engine.applyEdits(makeRequest('chat-a-overlap', 'BETA-A')),
    engine.applyEdits(makeRequest('chat-b-overlap', 'BETA-B')),
  ]);
  const applied = results.filter((result) => result.status === 'applied');
  const conflicts = results.filter((result) => result.status === 'conflict');
  assert.equal(applied.length, 1);
  assert.equal(conflicts.length, 1);
  const winningText = results[0].status === 'applied' ? 'BETA-A' : 'BETA-B';
  const losingText = results[0].status === 'conflict' ? 'BETA-A' : 'BETA-B';
  assert.equal(conflicts[0].reason, 'intervening_overlap');
  assert.equal(conflicts[0].base_text, 'beta');
  assert.equal(conflicts[0].current_text, winningText);
  assert.equal(conflicts[0].proposed_replacement, losingText);
  assert.equal(adapter.document.text, `alpha ${winningText} gamma`);
  assert.equal(adapter.document.version, 2);
  assert.equal(adapter.document.undoStack.length, 1);
  assert.equal(adapter.maxActiveApplies, 1);

  const changes = await engine.getDocumentChanges({
    ...selector(adapter),
    base_version: 1,
  });
  assert.equal(changes.status, 'available');
  assert.equal(changes.changes.length, 1);
  assert.equal(changes.changes[0].source, 'agent');

  assert.equal(adapter.undo(), true);
  assert.equal(adapter.document.text, 'alpha beta gamma');
});

test('two chats inserting at the same base anchor produce one insertion and one structured conflict', async () => {
  const { adapter, engine } = setup({ text: 'abc' });
  adapter.applyDelay = 10;
  const common = {
    ...selector(adapter),
    base_version: 1,
    description: 'Competing insertion',
    save_after_apply: false,
  };
  const makeRequest = (operationId, replacementText) => ({
    ...common,
    operation_id: operationId,
    edits: [{
      start_offset: 1,
      end_offset: 1,
      expected_original_text: '',
      replacement_text: replacementText,
    }],
  });

  const results = await Promise.all([
    engine.applyEdits(makeRequest('chat-a-same-anchor', 'X')),
    engine.applyEdits(makeRequest('chat-b-same-anchor', 'Y')),
  ]);
  const applied = results.filter((result) => result.status === 'applied');
  const conflicts = results.filter((result) => result.status === 'conflict');
  assert.equal(applied.length, 1);
  assert.equal(conflicts.length, 1);
  const winningText = results[0].status === 'applied' ? 'X' : 'Y';
  const losingText = results[0].status === 'conflict' ? 'X' : 'Y';
  assert.equal(conflicts[0].reason, 'intervening_overlap');
  assert.equal(conflicts[0].base_text, '');
  assert.equal(conflicts[0].current_text, winningText);
  assert.equal(conflicts[0].proposed_replacement, losingText);
  assert.equal(conflicts[0].conflicting_changes.length, 1);
  assert.deepEqual(conflicts[0].conflicting_changes[0], {
    range_offset: 1,
    range_length: 0,
    old_text: '',
    text: winningText,
  });
  assert.equal(adapter.document.text, `a${winningText}bc`);
  assert.equal(adapter.document.version, 2);
  assert.equal(adapter.document.undoStack.length, 1);
  assert.equal(adapter.maxActiveApplies, 1);
  assert.equal(adapter.undo(), true);
  assert.equal(adapter.document.text, 'abc');
});

test('an apply-with-save finishes its guarded save before the next chat edit commits', async () => {
  const { adapter, engine } = setup({ text: 'one two three' });
  adapter.applyDelay = 10;
  const base = selector(adapter);
  const first = engine.applyEdits({
    ...base,
    operation_id: 'chat-a-apply-and-save',
    base_version: 1,
    description: 'First chat edit and save',
    save_after_apply: true,
    edits: [{
      start_offset: 0,
      end_offset: 3,
      expected_original_text: 'one',
      replacement_text: 'ONE',
    }],
  });
  const second = engine.applyEdits({
    ...base,
    operation_id: 'chat-b-after-save',
    base_version: 1,
    description: 'Second chat edit',
    save_after_apply: false,
    edits: [{
      start_offset: 8,
      end_offset: 13,
      expected_original_text: 'three',
      replacement_text: 'THREE',
    }],
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 'applied');
  assert.equal(firstResult.save_status, 'saved');
  assert.equal(secondResult.status, 'applied');
  assert.equal(secondResult.rebased, true);
  assert.deepEqual(adapter.savedTexts, ['ONE two three']);
  assert.equal(adapter.document.text, 'ONE two THREE');
  assert.equal(adapter.document.is_dirty, true);
});

test('a standalone save queued behind another chat edit refuses the now-stale version', async () => {
  const { adapter, engine } = setup({ dirty: true });
  adapter.applyDelay = 10;
  const request = editRequest(adapter, { operation_id: 'chat-a-before-save' });
  const saveRequest = {
    ...selector(adapter),
    operation_id: 'chat-b-stale-save',
    expected_version: 1,
  };

  const [applyResult, saveResult] = await Promise.all([
    engine.applyEdits(request),
    engine.saveDocument(saveRequest),
  ]);
  assert.equal(applyResult.status, 'applied');
  assert.equal(saveResult.status, 'stale_version');
  assert.equal(saveResult.current_version, 2);
  assert.equal(adapter.document.text, 'alpha BETA gamma');
  assert.equal(adapter.document.is_dirty, true);
  assert.equal(adapter.document.saveCount, 0);
  assert.deepEqual(adapter.savedTexts, []);
});

test('preview is read-only, confirms with revalidation, and can be rejected', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter, { operation_id: 'preview-one' });
  const preview = await engine.previewEdits(request);
  assert.equal(preview.status, 'preview_ready');
  assert.equal(adapter.document.text, 'alpha beta gamma');
  assert.equal(adapter.previews.get(preview.preview_id).proposedText, 'alpha BETA gamma');
  const applied = await engine.confirmPreview(preview.preview_id);
  assert.equal(applied.status, 'applied');
  assert.equal(adapter.document.text, 'alpha BETA gamma');

  const secondRequest = {
    ...editRequest(adapter, {
      operation_id: 'preview-two',
      base_version: adapter.document.version,
    }),
    edits: [{
      start_offset: 0,
      end_offset: 5,
      expected_original_text: 'alpha',
      replacement_text: 'ALPHA',
    }],
  };
  const second = await engine.previewEdits(secondRequest);
  const rejected = await engine.rejectPreview(second.preview_id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(adapter.document.text, 'alpha BETA gamma');
});

test('reject during an in-flight preview confirmation reports applying and cannot remove it', async () => {
  const { adapter, engine } = setup();
  const preview = await engine.previewEdits(editRequest(adapter, {
    operation_id: 'preview-reject-during-confirm',
  }));
  adapter.applyDelay = 20;

  const confirmation = engine.confirmPreview(preview.preview_id);
  const rejection = await engine.rejectPreview(preview.preview_id);
  assert.deepEqual(rejection, {
    status: 'applying',
    preview_id: preview.preview_id,
  });
  assert.equal(engine.previews.has(preview.preview_id), true);
  assert.equal(adapter.previews.has(preview.preview_id), true);
  assert.equal(engine.listPendingPreviews()[0].state, 'applying');

  const applied = await confirmation;
  assert.equal(applied.status, 'applied');
  assert.equal(adapter.document.text, 'alpha BETA gamma');
  assert.equal(adapter.document.undoStack.length, 1);
  assert.equal(engine.previews.has(preview.preview_id), false);
  assert.equal(adapter.previews.has(preview.preview_id), false);
});

test('two simultaneous confirms share one claim, one promise, and one undoable transaction', async () => {
  const { adapter, engine } = setup();
  const preview = await engine.previewEdits(editRequest(adapter, {
    operation_id: 'preview-double-confirm',
  }));
  adapter.applyDelay = 20;

  const first = engine.confirmPreview(preview.preview_id);
  const second = engine.confirmPreview(preview.preview_id);
  assert.strictEqual(second, first);
  assert.equal(engine.listPendingPreviews()[0].state, 'applying');
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(secondResult, firstResult);
  assert.equal(firstResult.status, 'applied');
  assert.equal(adapter.document.text, 'alpha BETA gamma');
  assert.equal(adapter.document.version, 2);
  assert.equal(adapter.document.undoStack.length, 1);
  assert.equal(adapter.maxActiveApplies, 1);
  assert.equal(engine.previews.size, 0);
  assert.equal(adapter.previews.size, 0);
});

test('a conflicting confirm releases its claim but remains visibly non-retryable until rejected', async () => {
  const { adapter, engine } = setup();
  const preview = await engine.previewEdits(editRequest(adapter, {
    operation_id: 'preview-conflict-claim-release',
  }));
  adapter.userEdit(7, 8, 'X');

  const firstResult = await engine.confirmPreview(preview.preview_id);
  assert.equal(firstResult.status, 'conflict');
  assert.equal(firstResult.preview_state, 'conflict');
  assert.equal(engine.previews.has(preview.preview_id), true);
  assert.equal(adapter.previews.has(preview.preview_id), true);
  assert.equal(engine.previews.get(preview.preview_id).claim, undefined);
  assert.equal(engine.listPendingPreviews()[0].state, 'conflict');
  assert.equal(adapter.document.text, 'alpha bXta gamma');
  assert.equal(adapter.document.undoStack.length, 0);

  const secondResult = await engine.confirmPreview(preview.preview_id);
  assert.strictEqual(secondResult, firstResult);
  assert.equal(adapter.document.text, 'alpha bXta gamma');
  assert.equal(adapter.document.undoStack.length, 0);

  const rejected = await engine.rejectPreview(preview.preview_id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(engine.previews.has(preview.preview_id), false);
  assert.equal(adapter.previews.has(preview.preview_id), false);
});

test('TTL pruning and admission eviction cannot remove an applying preview', async () => {
  const adapter = new FakeAdapter({ filePath: '/workspace/applying-preview-0.tex' });
  const firstDocument = adapter.document;
  const secondDocument = {
    ...firstDocument,
    path: '/workspace/applying-preview-1.tex',
    document_uri: 'file:///workspace/applying-preview-1.tex',
    document_instance_id: 'applying-preview-document-1',
    undoStack: [],
    saveCount: 0,
  };
  adapter.documents.push(secondDocument);
  const engine = new LiveBridgeEngine(adapter, {
    maxHistoryBytes: 1_000_000,
    maxPreviews: 1,
  });
  adapter.connect(engine);
  const requestFor = (document, operationId, replacementText) => ({
    path: document.path,
    document_instance_id: document.document_instance_id,
    window_id: adapter.windowId,
    workspace_id: adapter.workspaceId,
    operation_id: operationId,
    base_version: 1,
    description: operationId,
    save_after_apply: false,
    edits: [{
      start_offset: 6,
      end_offset: 10,
      expected_original_text: 'beta',
      replacement_text: replacementText,
    }],
  });

  const firstPreview = await engine.previewEdits(requestFor(
    firstDocument,
    'applying-preview-first',
    'BETA-ONE',
  ));
  engine.previews.get(firstPreview.preview_id).created_at_milliseconds = 0;
  adapter.applyDelay = 30;
  const confirmation = engine.confirmPreview(firstPreview.preview_id);

  const listedDuringApply = engine.listPendingPreviews();
  assert.equal(listedDuringApply.length, 1);
  assert.equal(listedDuringApply[0].state, 'applying');
  assert.equal(engine.previews.has(firstPreview.preview_id), true);
  assert.equal(adapter.previews.has(firstPreview.preview_id), true);

  let secondSettled = false;
  const secondPreviewPromise = engine.previewEdits(requestFor(
    secondDocument,
    'applying-preview-second',
    'BETA-TWO',
  ));
  secondPreviewPromise.then(
    () => { secondSettled = true; },
    () => { secondSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  assert.equal(engine.previews.has(firstPreview.preview_id), true);
  assert.equal(adapter.previews.has(firstPreview.preview_id), true);

  const [applied, secondPreview] = await Promise.all([confirmation, secondPreviewPromise]);
  assert.equal(applied.status, 'applied');
  assert.equal(secondPreview.status, 'preview_ready');
  assert.equal(engine.previews.has(firstPreview.preview_id), false);
  assert.equal(adapter.previews.has(firstPreview.preview_id), false);
  assert.equal(engine.previews.has(secondPreview.preview_id), true);
  assert.equal(adapter.previews.has(secondPreview.preview_id), true);
  assert.equal(engine.listPendingPreviews()[0].state, 'pending');
});

test('concurrent previews across documents never exceed the global preview count', async () => {
  const adapter = new FakeAdapter({ text: 'target', filePath: '/workspace/preview-0.tex' });
  adapter.documents = Array.from({ length: 12 }, (_, index) => ({
    ...adapter.document,
    path: `/workspace/preview-${index}.tex`,
    document_uri: `file:///workspace/preview-${index}.tex`,
    document_instance_id: `preview-document-${index}`,
    undoStack: [],
    saveCount: 0,
  }));
  adapter.previewDelay = 10;
  const engine = new LiveBridgeEngine(adapter, {
    maxHistoryBytes: 1_000_000,
    maxPreviews: 3,
  });
  adapter.connect(engine);

  const requests = adapter.documents.map((document, index) => ({
    path: document.path,
    document_instance_id: document.document_instance_id,
    window_id: adapter.windowId,
    workspace_id: adapter.workspaceId,
    operation_id: `concurrent-preview-${index}`,
    base_version: document.version,
    description: `Concurrent preview ${index}`,
    save_after_apply: false,
    edits: [{
      start_offset: 0,
      end_offset: 6,
      expected_original_text: 'target',
      replacement_text: 'TARGET',
    }],
  }));
  const results = await Promise.all(requests.map((request) => engine.previewEdits(request)));

  assert.equal(results.every((result) => result.status === 'preview_ready'), true);
  assert.equal(engine.previews.size, 3);
  assert.equal(engine.previewReservations.size, 0);
  assert.equal(engine.reservedPreviewBytes, 0);
  assert.equal(engine.reservedPreviewContentBytes, 0);
  assert.equal(adapter.previews.size, 3);
  assert.deepEqual(
    [...engine.previews.keys()].sort(),
    [...adapter.previews.keys()].sort(),
  );
  assert.equal(adapter.maxActivePreviews, 3);
  assert.ok(adapter.maxStoredPreviews <= 3);
});

test('concurrent preview reservations enforce the global request-byte cap', async () => {
  const adapter = new FakeAdapter({ text: 'target', filePath: '/workspace/bytes-0.tex' });
  adapter.documents = Array.from({ length: 6 }, (_, index) => ({
    ...adapter.document,
    path: `/workspace/bytes-${index}.tex`,
    document_uri: `file:///workspace/bytes-${index}.tex`,
    document_instance_id: `bytes-document-${index}`,
    undoStack: [],
    saveCount: 0,
  }));
  adapter.previewDelay = 10;
  const requests = adapter.documents.map((document, index) => ({
    path: document.path,
    document_instance_id: document.document_instance_id,
    window_id: adapter.windowId,
    workspace_id: adapter.workspaceId,
    operation_id: `byte-preview-${index}`,
    base_version: document.version,
    description: `Byte preview ${index}`,
    save_after_apply: false,
    edits: [{
      start_offset: 0,
      end_offset: 6,
      expected_original_text: 'target',
      replacement_text: 'TARGET',
    }],
  }));
  const requestBytes = Buffer.byteLength(JSON.stringify(requests[0]), 'utf8');
  assert.equal(
    requests.every((request) => Buffer.byteLength(JSON.stringify(request), 'utf8') === requestBytes),
    true,
  );
  const maxPreviewBytes = requestBytes * 2;
  const engine = new LiveBridgeEngine(adapter, {
    maxHistoryBytes: 1_000_000,
    maxPreviews: 10,
    maxPreviewBytes,
  });
  adapter.connect(engine);

  const results = await Promise.all(requests.map((request) => engine.previewEdits(request)));

  assert.equal(results.every((result) => result.status === 'preview_ready'), true);
  assert.equal(engine.previews.size, 2);
  assert.equal(engine.previewBytes, maxPreviewBytes);
  assert.equal(engine.previewReservations.size, 0);
  assert.equal(engine.reservedPreviewBytes, 0);
  assert.equal(engine.reservedPreviewContentBytes, 0);
  assert.equal(adapter.previews.size, 2);
  assert.deepEqual(
    [...engine.previews.keys()].sort(),
    [...adapter.previews.keys()].sort(),
  );
  assert.equal(adapter.maxActivePreviews, 2);
  assert.ok(adapter.maxStoredPreviews <= 2);
});

test('concurrent large previews enforce content bytes and keep engine and adapter sets aligned', async () => {
  const largeText = 'x'.repeat(2048);
  const adapter = new FakeAdapter({ text: largeText, filePath: '/workspace/content-0.tex' });
  adapter.documents = Array.from({ length: 6 }, (_, index) => ({
    ...adapter.document,
    path: `/workspace/content-${index}.tex`,
    document_uri: `file:///workspace/content-${index}.tex`,
    document_instance_id: `content-document-${index}`,
    undoStack: [],
    saveCount: 0,
  }));
  adapter.previewDelay = 10;
  const contentBytesPerPreview = Buffer.byteLength(largeText, 'utf8') * 2;
  const maxPreviewContentBytes = contentBytesPerPreview * 2;
  adapter.maxPreviewBytes = maxPreviewContentBytes;
  const engine = new LiveBridgeEngine(adapter, {
    maxHistoryBytes: 1_000_000,
    maxPreviews: 10,
    maxPreviewContentBytes,
  });
  adapter.connect(engine);
  const requests = adapter.documents.map((document, index) => ({
    path: document.path,
    document_instance_id: document.document_instance_id,
    window_id: adapter.windowId,
    workspace_id: adapter.workspaceId,
    operation_id: `content-preview-${index}`,
    base_version: document.version,
    description: `Content preview ${index}`,
    save_after_apply: false,
    edits: [{
      start_offset: 0,
      end_offset: 1,
      expected_original_text: 'x',
      replacement_text: 'y',
    }],
  }));

  const results = await Promise.all(requests.map((request) => engine.previewEdits(request)));

  assert.equal(results.every((result) => result.status === 'preview_ready'), true);
  assert.equal(engine.previews.size, 2);
  assert.equal(engine.previewContentBytes, maxPreviewContentBytes);
  assert.equal(engine.previewReservations.size, 0);
  assert.equal(engine.reservedPreviewContentBytes, 0);
  assert.equal(adapter.previews.size, 2);
  assert.equal(adapter.previewBytes, maxPreviewContentBytes);
  assert.deepEqual(
    [...engine.previews.keys()].sort(),
    [...adapter.previews.keys()].sort(),
  );
  assert.equal(adapter.maxActivePreviews, 2);
  assert.ok(adapter.maxStoredPreviews <= 2);
});

test('oversized preview content fails before adapter allocation without leaking a reservation', async () => {
  const adapter = new FakeAdapter({ text: 'x'.repeat(60) });
  const engine = new LiveBridgeEngine(adapter, {
    maxHistoryBytes: 1_000_000,
    maxPreviewContentBytes: 100,
  });
  adapter.connect(engine);
  const request = {
    ...selector(adapter),
    operation_id: 'oversized-preview-content',
    base_version: 1,
    description: 'Oversized preview content',
    save_after_apply: false,
    edits: [{
      start_offset: 0,
      end_offset: 1,
      expected_original_text: 'x',
      replacement_text: 'y',
    }],
  };

  await assert.rejects(() => engine.previewEdits(request), { code: 'PREVIEW_TOO_LARGE' });
  assert.equal(engine.previews.size, 0);
  assert.equal(engine.previewReservations.size, 0);
  assert.equal(engine.previewBytes, 0);
  assert.equal(engine.previewContentBytes, 0);
  assert.equal(engine.reservedPreviewBytes, 0);
  assert.equal(engine.reservedPreviewContentBytes, 0);
  assert.equal(adapter.previews.size, 0);
  assert.equal(adapter.previewBytes, 0);
});

test('preview adapter failure cleans both authoritative state and allocated UI content', async () => {
  const adapter = new FakeAdapter({ text: 'target' });
  adapter.previewFailures = 1;
  const engine = new LiveBridgeEngine(adapter, { maxHistoryBytes: 1_000_000 });
  adapter.connect(engine);
  const request = {
    ...selector(adapter),
    operation_id: 'failed-preview-allocation',
    base_version: 1,
    description: 'Fail preview after allocation',
    save_after_apply: false,
    edits: [{
      start_offset: 0,
      end_offset: 6,
      expected_original_text: 'target',
      replacement_text: 'TARGET',
    }],
  };

  await assert.rejects(() => engine.previewEdits(request), { code: 'FAKE_PREVIEW_FAILURE' });
  assert.equal(engine.previews.size, 0);
  assert.equal(engine.previewReservations.size, 0);
  assert.equal(engine.previewBytes, 0);
  assert.equal(engine.previewContentBytes, 0);
  assert.equal(engine.reservedPreviewBytes, 0);
  assert.equal(engine.reservedPreviewContentBytes, 0);
  assert.equal(adapter.previews.size, 0);
  assert.equal(adapter.previewBytes, 0);
});

test('preview refuses save-after-apply and never mutates', async () => {
  const { adapter, engine } = setup();
  await assert.rejects(
    () => engine.previewEdits(editRequest(adapter, { save_after_apply: true })),
    { code: 'INVALID_REQUEST' },
  );
  assert.equal(adapter.document.text, 'alpha beta gamma');
  assert.equal(adapter.document.saveCount, 0);
});

test('idempotent apply replay cannot duplicate an insertion and conflicting reuse fails', async () => {
  const { adapter, engine } = setup({ text: 'abc' });
  const request = {
    ...selector(adapter),
    operation_id: 'stable-insertion-id',
    base_version: 1,
    description: 'Insert once',
    save_after_apply: false,
    edits: [{
      start_offset: 1,
      end_offset: 1,
      expected_original_text: '',
      replacement_text: 'X',
    }],
  };
  const first = await engine.applyEdits(request);
  const replay = await engine.applyEdits(structuredClone(request));
  assert.strictEqual(replay, first);
  assert.equal(adapter.document.text, 'aXbc');
  assert.throws(
    () => engine.applyEdits({ ...request, description: 'Different request' }),
    { code: 'OPERATION_ID_REUSED' },
  );
});

test('simultaneous different requests reusing one global operation id fail closed before a second commit', async () => {
  const { adapter, engine } = setup();
  adapter.applyDelay = 10;
  const common = {
    ...selector(adapter),
    operation_id: 'globally-colliding-operation-id',
    base_version: 1,
    save_after_apply: false,
  };
  const requests = [
    {
      ...common,
      description: 'First payload',
      edits: [{
        start_offset: 0,
        end_offset: 5,
        expected_original_text: 'alpha',
        replacement_text: 'ALPHA',
      }],
    },
    {
      ...common,
      description: 'Second payload',
      edits: [{
        start_offset: 11,
        end_offset: 16,
        expected_original_text: 'gamma',
        replacement_text: 'GAMMA',
      }],
    },
  ];

  const outcomes = await Promise.allSettled(requests.map(
    (request) => Promise.resolve().then(() => engine.applyEdits(request)),
  ));
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.status, 'applied');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'OPERATION_ID_REUSED');
  assert.match(rejected[0].reason.message, /different request/);
  assert.equal(adapter.document.text, 'ALPHA beta gamma');
  assert.equal(adapter.document.version, 2);
  assert.equal(adapter.document.undoStack.length, 1);
  assert.equal(adapter.maxActiveApplies, 1);
});

test('save is version checked and idempotent without erasing change history', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter);
  await engine.applyEdits(request);
  const saveRequest = {
    ...selector(adapter),
    operation_id: 'save-once',
    expected_version: adapter.document.version,
  };
  const first = await engine.saveDocument(saveRequest);
  const replay = await engine.saveDocument(structuredClone(saveRequest));
  assert.strictEqual(replay, first);
  assert.equal(adapter.document.saveCount, 1);
  const changes = await engine.getDocumentChanges({
    ...selector(adapter),
    base_version: 1,
  });
  assert.equal(changes.status, 'available');
  assert.equal(changes.changes.length, 1);
});

test('standalone save reports uncertain save and unavailable post-save state structurally', async () => {
  const first = setup({ dirty: true });
  first.adapter.saveFailures = 1;
  const uncertain = await first.engine.saveDocument({
    ...selector(first.adapter),
    operation_id: 'standalone-save-throws',
    expected_version: first.adapter.document.version,
  });
  assert.equal(uncertain.status, 'save_outcome_unknown');

  const second = setup({ dirty: true });
  second.adapter.afterSave = () => { second.adapter.captureFailures = 1; };
  const saved = await second.engine.saveDocument({
    ...selector(second.adapter),
    operation_id: 'standalone-recapture-throws',
    expected_version: second.adapter.document.version,
  });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.current_state_unavailable, true);
  assert.equal(second.adapter.document.saveCount, 1);
});

test('a disk change is tracked and causes overlap rejection', async () => {
  const { adapter, engine } = setup();
  const request = editRequest(adapter);
  adapter.diskEdit('alpha disk gamma');
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'conflict');
  assert.equal(adapter.document.text, 'alpha disk gamma');
  assert.equal(adapter.document.is_dirty, false);
});

test('preserves CRLF and handles multiline LaTeX and astral Unicode offsets', async () => {
  const text = '\\begin{align}\r\n  α + 😀\r\n\\end{align}\r\n';
  const { adapter, engine } = setup({ text, eol: '\r\n' });
  const target = text.indexOf('α + 😀');
  const result = await engine.applyEdits({
    ...selector(adapter),
    operation_id: 'unicode-crlf',
    base_version: 1,
    description: 'Edit multiline Unicode LaTeX',
    save_after_apply: false,
    edits: [{
      start_offset: target,
      end_offset: target + 'α + 😀'.length,
      expected_original_text: 'α + 😀',
      replacement_text: 'β &= 😀\n  &+ 1',
    }],
  });
  assert.equal(result.status, 'applied');
  assert.equal(
    adapter.document.text,
    '\\begin{align}\r\n  β &= 😀\r\n  &+ 1\r\n\\end{align}\r\n',
  );
  assert.equal(adapter.document.text.includes('\n') && !adapter.document.text.includes('\r\n'), false);
});

test('rejects stale document instance and unavailable history', async () => {
  const { adapter, engine } = setup({ maxHistoryRecords: 1 });
  await assert.rejects(
    () => engine.readDocument({
      path: adapter.document.path,
      document_instance_id: 'old-instance',
    }),
    { code: 'STALE_DOCUMENT' },
  );
  const request = editRequest(adapter);
  adapter.userEdit(0, 0, 'a');
  adapter.userEdit(0, 0, 'b');
  const result = await engine.applyEdits(request);
  assert.equal(result.status, 'stale_version');
});

test('rejects a base range beyond the historical base document length', async () => {
  const { adapter, engine } = setup({ text: 'abc' });
  adapter.userEdit(3, 3, 'later');
  const request = {
    ...selector(adapter),
    operation_id: 'bad-base-range',
    base_version: 1,
    description: 'Impossible base range',
    save_after_apply: false,
    edits: [{
      start_offset: 3,
      end_offset: 8,
      expected_original_text: 'later',
      replacement_text: 'x',
    }],
  };
  await assert.rejects(() => engine.applyEdits(request), { code: 'INVALID_REQUEST' });
});
