'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BridgeError } = require('../src/errors');
const { applyEditsToText } = require('../src/rebase');

function positionAt(text, offset) {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < bounded; index += 1) {
    if (text[index] === '\r' && text[index + 1] === '\n') {
      if (index + 1 < bounded) {
        line += 1;
        index += 1;
        lineStart = index + 1;
      }
    } else if (text[index] === '\n' || text[index] === '\r') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: bounded - lineStart };
}

class FakeAdapter {
  constructor({
    text = 'alpha beta gamma',
    filePath = '/workspace/test.tex',
    eol = '\n',
    dirty = false,
    version = 1,
    windowId = 'window-1',
    workspaceId = 'workspace-1',
    workspacePath = '/workspace',
  } = {}) {
    this.windowId = windowId;
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
    this.instanceId = 'instance-1';
    this.documents = [{
      path: filePath,
      document_uri: pathToFileURL(filePath).href,
      document_instance_id: crypto.randomUUID(),
      text,
      version,
      is_dirty: dirty,
      language_id: path.extname(filePath) === '.tex' ? 'latex' : 'plaintext',
      eol,
      workspace: {
        name: path.basename(workspacePath),
        path: workspacePath,
        uri: pathToFileURL(workspacePath).href,
        index: 0,
      },
      undoStack: [],
      saveCount: 0,
    }];
    this.changeListeners = new Set();
    this.previews = new Map();
    this.previewDelay = 0;
    this.activePreviews = 0;
    this.maxActivePreviews = 0;
    this.maxStoredPreviews = 0;
    this.previewBytes = 0;
    this.maxPreviewBytes = 64 * 1024 * 1024;
    this.previewFailures = 0;
    this.applyDelay = 0;
    this.activeApplies = 0;
    this.maxActiveApplies = 0;
    this.beforeApply = undefined;
    this.afterApply = undefined;
    this.captureFailures = 0;
    this.saveFailures = 0;
    this.savedTexts = [];
    this.beforeSave = undefined;
    this.afterSave = undefined;
  }

  get document() {
    return this.documents[0];
  }

  connect(engine) {
    this.changeListeners.add((event) => engine.recordChange(event));
  }

  async identity() {
    return {
      protocol_version: '3.0',
      instance_id: this.instanceId,
      window_id: this.windowId,
      editor_name: 'Test Editor',
      editor_version: '1.0.0',
      workspace_id: this.workspaceId,
      workspace_file: null,
      workspace_folders: [this.document.workspace],
    };
  }

  async listWorkspaces() {
    return this.identity();
  }

  async listOpenDocuments() {
    const identity = await this.identity();
    return {
      ...identity,
      documents: this.documents.map((document) => this._metadata(document)),
    };
  }

  _metadata(document) {
    return {
      document_uri: document.document_uri,
      path: document.path,
      document_instance_id: document.document_instance_id,
      version: document.version,
      is_dirty: document.is_dirty,
      language_id: document.language_id,
      eol: document.eol,
      workspace: document.workspace,
      instance_id: this.instanceId,
      window_id: this.windowId,
      editor_name: 'Test Editor',
      editor_version: '1.0.0',
      workspace_id: this.workspaceId,
    };
  }

  async capture(params) {
    if (this.captureFailures > 0) {
      this.captureFailures -= 1;
      throw new BridgeError('FAKE_CAPTURE_FAILURE', 'simulated capture failure');
    }
    if (params.window_id && params.window_id !== this.windowId) {
      throw new BridgeError('ROUTING_MISMATCH', 'wrong window');
    }
    if (params.workspace_id && params.workspace_id !== this.workspaceId) {
      throw new BridgeError('ROUTING_MISMATCH', 'wrong workspace');
    }
    const wantedPath = params.path || (params.document_uri
      ? decodeURIComponent(new URL(params.document_uri).pathname)
      : undefined);
    const document = this.documents.find((candidate) => candidate.path === wantedPath);
    if (!document) {
      throw new BridgeError('DOCUMENT_NOT_OPEN', 'not open');
    }
    if (
      params.document_instance_id &&
      params.document_instance_id !== document.document_instance_id
    ) {
      throw new BridgeError('STALE_DOCUMENT', 'document instance changed');
    }
    return {
      ...this._metadata(document),
      handle: document,
      text: document.text,
      positionAt: (offset) => positionAt(document.text, offset),
    };
  }

  _emit(document, fromVersion, changes, source) {
    const event = {
      document_instance_id: document.document_instance_id,
      from_version: fromVersion,
      to_version: document.version,
      changes,
      source,
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.changeListeners) {
      listener(event);
    }
  }

  userEdit(startOffset, endOffset, replacementText, source = 'user_or_extension') {
    const document = this.document;
    const fromVersion = document.version;
    const oldText = document.text.slice(startOffset, endOffset);
    document.text = applyEditsToText(document.text, [{
      start_offset: startOffset,
      end_offset: endOffset,
      replacement_text: replacementText,
    }]);
    document.version += 1;
    document.is_dirty = source !== 'disk';
    this._emit(document, fromVersion, [{
      range_offset: startOffset,
      range_length: endOffset - startOffset,
      old_text: oldText,
      text: replacementText,
    }], source);
  }

  userBatch(changes, source = 'user_or_extension') {
    const document = this.document;
    const fromVersion = document.version;
    const normalized = changes.map((change) => ({
      ...change,
      old_text: document.text.slice(
        change.range_offset,
        change.range_offset + change.range_length,
      ),
    }));
    document.text = applyEditsToText(document.text, normalized.map((change) => ({
      start_offset: change.range_offset,
      end_offset: change.range_offset + change.range_length,
      replacement_text: change.text,
    })));
    document.version += 1;
    document.is_dirty = source !== 'disk';
    this._emit(document, fromVersion, normalized, source);
  }

  diskEdit(text) {
    const document = this.document;
    this.userEdit(0, document.text.length, text, 'disk');
    document.is_dirty = false;
  }

  async applyVersionedEdits(snapshot, expectedVersion, edits, _description, authorizationGuard) {
    const document = snapshot.handle;
    this.activeApplies += 1;
    this.maxActiveApplies = Math.max(this.maxActiveApplies, this.activeApplies);
    try {
      if (this.applyDelay) {
        await new Promise((resolve) => setTimeout(resolve, this.applyDelay));
      }
      if (this.beforeApply) {
        const hook = this.beforeApply;
        this.beforeApply = undefined;
        hook();
      }
      authorizationGuard?.();
      if (document.version !== expectedVersion) {
        return { applied: false, applied_version: undefined };
      }
      const fromVersion = document.version;
      const before = document.text;
      const changes = edits.map((edit) => ({
        range_offset: edit.start_offset,
        range_length: edit.end_offset - edit.start_offset,
        old_text: before.slice(edit.start_offset, edit.end_offset),
        text: edit.replacement_text,
      }));
      document.undoStack.push(before);
      document.text = applyEditsToText(document.text, edits);
      document.version += 1;
      document.is_dirty = true;
      const appliedVersion = document.version;
      this._emit(document, fromVersion, changes, 'agent');
      if (this.afterApply) {
        const hook = this.afterApply;
        this.afterApply = undefined;
        hook();
      }
      return { applied: true, applied_version: appliedVersion };
    } finally {
      this.activeApplies -= 1;
    }
  }

  undo() {
    const document = this.document;
    const previous = document.undoStack.pop();
    if (previous === undefined) {
      return false;
    }
    const fromVersion = document.version;
    const current = document.text;
    document.text = previous;
    document.version += 1;
    document.is_dirty = true;
    this._emit(document, fromVersion, [{
      range_offset: 0,
      range_length: current.length,
      old_text: current,
      text: previous,
    }], 'undo');
    return true;
  }

  async save(snapshot, expectedVersion = snapshot.version, authorizationGuard) {
    if (this.saveFailures > 0) {
      this.saveFailures -= 1;
      throw new BridgeError('FAKE_SAVE_FAILURE', 'simulated save failure');
    }
    const document = snapshot.handle;
    if (this.beforeSave) {
      const hook = this.beforeSave;
      this.beforeSave = undefined;
      hook();
    }
    authorizationGuard?.();
    if (document.version !== expectedVersion) {
      return false;
    }
    document.saveCount += 1;
    this.savedTexts.push(document.text);
    document.is_dirty = false;
    if (this.afterSave) {
      const hook = this.afterSave;
      this.afterSave = undefined;
      hook();
    }
    return true;
  }

  async showPreview(snapshot, proposedText, description, previewId) {
    this.activePreviews += 1;
    this.maxActivePreviews = Math.max(this.maxActivePreviews, this.activePreviews);
    try {
      const contentBytes = Buffer.byteLength(snapshot.text, 'utf8') +
        Buffer.byteLength(proposedText, 'utf8');
      if (contentBytes > this.maxPreviewBytes || this.previewBytes + contentBytes > this.maxPreviewBytes) {
        throw new BridgeError('PREVIEW_CAPACITY_MISMATCH', 'fake preview capacity exceeded');
      }
      this.previews.set(previewId, {
        proposedText,
        description,
        path: snapshot.path,
        contentBytes,
      });
      this.previewBytes += contentBytes;
      this.maxStoredPreviews = Math.max(this.maxStoredPreviews, this.previews.size);
      if (this.previewDelay) {
        await new Promise((resolve) => setTimeout(resolve, this.previewDelay));
      }
      if (this.previewFailures > 0) {
        this.previewFailures -= 1;
        throw new BridgeError('FAKE_PREVIEW_FAILURE', 'simulated preview failure');
      }
    } finally {
      this.activePreviews -= 1;
    }
  }

  async dismissPreview(previewId) {
    const preview = this.previews.get(previewId);
    if (preview) {
      this.previewBytes -= preview.contentBytes;
      this.previews.delete(previewId);
    }
  }
}

module.exports = { FakeAdapter, positionAt };
