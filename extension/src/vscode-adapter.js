'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BridgeError } = require('./errors');
const { applyEditsToText } = require('./rebase');
const {
  canonicalExistingPath,
  canonicalizeSelector,
  isInsidePath,
  selectDocument,
  validateWindowSelector,
} = require('./routing');

class VscodeAdapter {
  constructor(vscode, { instanceId, windowId, output }) {
    this.vscode = vscode;
    this.instanceId = instanceId;
    this.windowId = windowId;
    this.output = output;
    this.documentStates = new WeakMap();
    this.changeListeners = new Set();
    this.forgetListeners = new Set();
    this.disposables = [];
    this.pendingApplies = new Map();
    this.previewContents = new Map();
    this.previewOrder = [];
    this.previewBytes = 0;
    this.maxPreviewBytes = 64 * 1024 * 1024;
    this.previewEmitter = new vscode.EventEmitter();
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    this.statusItem.name = 'BufferWeave';
    this.applyingCount = 0;
  }

  initialize() {
    for (const document of this.vscode.workspace.textDocuments) {
      this._stateFor(document);
    }
    this.disposables.push(
      this.vscode.workspace.onDidOpenTextDocument((document) => this._stateFor(document)),
      this.vscode.workspace.onDidCloseTextDocument((document) => this._closed(document)),
      this.vscode.workspace.onDidChangeTextDocument((event) => this._changed(event)),
      this.vscode.workspace.registerTextDocumentContentProvider('bufferweave-preview', {
        onDidChange: this.previewEmitter.event,
        provideTextDocumentContent: (uri) => this.previewContents.get(uri.toString()) || '',
      }),
      this.previewEmitter,
      this.statusItem,
    );
    return this.disposables;
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  onDidChange(listener) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  onDidForget(listener) {
    this.forgetListeners.add(listener);
    return { dispose: () => this.forgetListeners.delete(listener) };
  }

  _stateFor(document) {
    let state = this.documentStates.get(document);
    if (!state) {
      state = {
        document_instance_id: crypto.randomUUID(),
        version: document.version,
        text: document.getText(),
      };
      this.documentStates.set(document, state);
    }
    return state;
  }

  _closed(document) {
    const state = this.documentStates.get(document);
    if (!state) {
      return;
    }
    for (const listener of this.forgetListeners) {
      listener(state.document_instance_id);
    }
    this.documentStates.delete(document);
  }

  _changed(event) {
    const document = event.document;
    const state = this._stateFor(document);
    const oldText = state.text;
    const newText = document.getText();
    if (event.contentChanges.length === 0 && oldText === newText) {
      if (document.version > state.version) {
        const payload = {
          document_instance_id: state.document_instance_id,
          from_version: state.version,
          to_version: document.version,
          changes: [],
          source: 'metadata',
          timestamp: new Date().toISOString(),
        };
        for (const listener of this.changeListeners) {
          listener(payload);
        }
      } else if (document.version < state.version) {
        for (const listener of this.changeListeners) {
          listener({ document_instance_id: state.document_instance_id, reset: true });
        }
      }
      state.version = document.version;
      return;
    }
    const changes = event.contentChanges.map((change) => ({
      range_offset: change.rangeOffset,
      range_length: change.rangeLength,
      old_text: oldText.slice(change.rangeOffset, change.rangeOffset + change.rangeLength),
      text: change.text,
      range: {
        start: { line: change.range.start.line, character: change.range.start.character },
        end: { line: change.range.end.line, character: change.range.end.character },
      },
    }));
    let reconstructed;
    try {
      reconstructed = applyEditsToText(
        oldText,
        changes.map((change) => ({
          start_offset: change.range_offset,
          end_offset: change.range_offset + change.range_length,
          replacement_text: change.text,
        })),
      );
    } catch {
      reconstructed = undefined;
    }
    const pendingApply = this.pendingApplies.get(state.document_instance_id);
    const isAgentChange = pendingApply &&
      pendingApply.expected_version === state.version &&
      sameContentChanges(changes, pendingApply.edits);
    if (isAgentChange) {
      pendingApply.applied_version = document.version;
    }
    const source = isAgentChange
      ? 'agent'
      : event.reason === this.vscode.TextDocumentChangeReason?.Undo
        ? 'undo'
        : event.reason === this.vscode.TextDocumentChangeReason?.Redo
          ? 'redo'
          : document.isDirty
            ? 'user_or_extension'
            : 'disk';
    const payload = reconstructed === newText && state.version < document.version
      ? {
          document_instance_id: state.document_instance_id,
          from_version: state.version,
          to_version: document.version,
          changes,
          source,
          timestamp: new Date().toISOString(),
        }
      : {
          document_instance_id: state.document_instance_id,
          reset: true,
          source,
          timestamp: new Date().toISOString(),
        };
    state.text = newText;
    state.version = document.version;
    for (const listener of this.changeListeners) {
      try {
        listener(payload);
      } catch (error) {
        this.output.appendLine(`[history] reset after invalid event: ${error.code || error.name}`);
      }
    }
  }

  async _workspaces() {
    const folders = [];
    for (const folder of this.vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      try {
        const canonicalPath = await canonicalExistingPath(folder.uri.fsPath);
        folders.push({
          name: folder.name,
          path: canonicalPath,
          uri: this.vscode.Uri.file(canonicalPath).toString(),
          index: folder.index,
        });
      } catch {
        // An inaccessible workspace cannot safely authorize file access.
      }
    }
    return folders;
  }

  async identity() {
    const workspaceFolders = await this._workspaces();
    const workspaceFile = this.vscode.workspace.workspaceFile?.scheme === 'file'
      ? this.vscode.workspace.workspaceFile.toString()
      : null;
    const hashInput = JSON.stringify({
      workspace_file: workspaceFile,
      workspace_folders: workspaceFolders.map((folder) => folder.path).sort(),
    });
    return {
      instance_id: this.instanceId,
      window_id: this.windowId,
      editor_name: this.vscode.env.appName,
      editor_version: this.vscode.version,
      workspace_id: crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 24),
      workspace_file: workspaceFile,
      workspace_folders: workspaceFolders,
    };
  }

  async listWorkspaces() {
    return this.identity();
  }

  async _descriptors() {
    const workspaces = await this._workspaces();
    const openTabUris = this._openTabUris();
    const descriptors = [];
    for (const document of this.vscode.workspace.textDocuments) {
      if (
        document.isClosed ||
        document.uri.scheme !== 'file' ||
        !openTabUris.has(document.uri.toString())
      ) {
        continue;
      }
      let canonicalPath;
      try {
        canonicalPath = await canonicalExistingPath(document.uri.fsPath);
      } catch {
        continue;
      }
      const matchingWorkspaces = workspaces
        .filter((workspace) => isInsidePath(workspace.path, canonicalPath))
        .sort((left, right) => right.path.length - left.path.length);
      const workspace = matchingWorkspaces[0];
      if (!workspace) {
        continue;
      }
      const state = this._stateFor(document);
      descriptors.push({
        handle: document,
        document_uri: this.vscode.Uri.file(canonicalPath).toString(),
        path: canonicalPath,
        document_instance_id: state.document_instance_id,
        version: document.version,
        is_dirty: document.isDirty,
        language_id: document.languageId,
        eol: document.eol === this.vscode.EndOfLine.CRLF ? '\r\n' : '\n',
        workspace,
      });
    }
    return descriptors;
  }

  _openTabUris() {
    const uris = new Set(
      this.vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()),
    );
    for (const group of this.vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (this.vscode.TabInputText && input instanceof this.vscode.TabInputText) {
          uris.add(input.uri.toString());
        } else if (
          this.vscode.TabInputTextDiff &&
          input instanceof this.vscode.TabInputTextDiff
        ) {
          uris.add(input.original.toString());
          uris.add(input.modified.toString());
        }
      }
    }
    return uris;
  }

  async listOpenDocuments(params = {}) {
    const identity = await this.identity();
    validateWindowSelector(params, identity);
    let documents = await this._descriptors();
    if (params.workspace_path) {
      const canonicalWorkspace = await canonicalExistingPath(params.workspace_path);
      documents = documents.filter((document) => document.workspace.path === canonicalWorkspace);
    }
    return {
      ...identity,
      documents: documents.map(({ handle, ...metadata }) => ({
        ...metadata,
        instance_id: identity.instance_id,
        window_id: identity.window_id,
        editor_name: identity.editor_name,
        editor_version: identity.editor_version,
        workspace_id: identity.workspace_id,
      })),
    };
  }

  async capture(params) {
    const identity = await this.identity();
    const selector = await canonicalizeSelector(params);
    const descriptor = selectDocument(await this._descriptors(), selector, identity);
    const document = descriptor.handle;
    const text = document.getText();
    return {
      ...descriptor,
      window_id: identity.window_id,
      editor_name: identity.editor_name,
      editor_version: identity.editor_version,
      workspace_id: identity.workspace_id,
      version: document.version,
      is_dirty: document.isDirty,
      text,
      positionAt: (offset) => {
        const position = document.positionAt(offset);
        return { line: position.line, character: position.character };
      },
    };
  }

  _showApplying(description) {
    this.applyingCount += 1;
    this.statusItem.text = '$(sync~spin) Codex applying live edit';
    this.statusItem.tooltip = description;
    this.statusItem.show();
  }

  _hideApplying() {
    this.applyingCount -= 1;
    if (this.applyingCount <= 0) {
      this.applyingCount = 0;
      this.statusItem.hide();
    }
  }

  async applyVersionedEdits(snapshot, expectedVersion, edits, description, authorizationGuard) {
    const document = snapshot.handle;
    if (document.isClosed || document.version !== expectedVersion) {
      return { applied: false, applied_version: undefined };
    }
    let editor = this.vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document === document,
    );
    if (!editor) {
      editor = await this.vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: true,
      });
    }
    if (document.version !== expectedVersion || editor.document !== document) {
      return { applied: false, applied_version: undefined };
    }
    authorizationGuard?.();

    const instanceId = snapshot.document_instance_id;
    const pendingApply = {
      expected_version: expectedVersion,
      edits: edits.map((edit) => ({
        start_offset: edit.start_offset,
        end_offset: edit.end_offset,
        replacement_text: edit.replacement_text,
      })),
      applied_version: undefined,
    };
    this.pendingApplies.set(instanceId, pendingApply);
    this._showApplying(description);
    let callbackVersion;
    try {
      let applied;
      try {
        applied = await editor.edit(
          (builder) => {
            authorizationGuard?.();
            callbackVersion = document.version;
            if (callbackVersion !== expectedVersion) {
              return;
            }
            for (const edit of edits) {
              builder.replace(
                new this.vscode.Range(
                  document.positionAt(edit.start_offset),
                  document.positionAt(edit.end_offset),
                ),
                edit.replacement_text,
              );
            }
          },
          { undoStopBefore: true, undoStopAfter: true },
        );
      } catch (error) {
        if (pendingApply.applied_version !== undefined) {
          return {
            applied: true,
            applied_version: pendingApply.applied_version,
            warning: 'editor_edit_rejected_after_change_event',
          };
        }
        throw error;
      }
      const succeeded = callbackVersion === expectedVersion && applied;
      return {
        applied: succeeded,
        applied_version: succeeded ? (pendingApply.applied_version ?? null) : undefined,
      };
    } finally {
      this._hideApplying();
      if (this.pendingApplies.get(instanceId) === pendingApply) {
        this.pendingApplies.delete(instanceId);
      }
    }
  }

  async save(snapshot, expectedVersion = snapshot.version, authorizationGuard) {
    if (snapshot.handle.isClosed || snapshot.handle.version !== expectedVersion) {
      return false;
    }
    authorizationGuard?.();
    return snapshot.handle.save();
  }

  async showPreview(snapshot, proposedText, description, previewId) {
    const size = Buffer.byteLength(snapshot.text, 'utf8') + Buffer.byteLength(proposedText, 'utf8');
    if (size > this.maxPreviewBytes) {
      throw new BridgeError('PREVIEW_TOO_LARGE', 'The two-document preview exceeds 64 MiB');
    }
    if (this.previewOrder.length >= 32 || this.previewBytes + size > this.maxPreviewBytes) {
      throw new BridgeError(
        'PREVIEW_CAPACITY_MISMATCH',
        'The preview adapter capacity does not match the engine reservation',
      );
    }
    const fileName = path.basename(snapshot.path).replace(/[^a-zA-Z0-9._-]/g, '_');
    const baseUri = this.vscode.Uri.parse(
      `bufferweave-preview:/base/${fileName}?preview_id=${encodeURIComponent(previewId)}`,
    );
    const proposedUri = this.vscode.Uri.parse(
      `bufferweave-preview:/proposed/${fileName}?preview_id=${encodeURIComponent(previewId)}`,
    );
    this.previewContents.set(baseUri.toString(), snapshot.text);
    this.previewContents.set(proposedUri.toString(), proposedText);
    this.previewOrder.push({
      previewId,
      uris: [baseUri.toString(), proposedUri.toString()],
      size,
      createdAt: Date.now(),
    });
    this.previewBytes += size;
    await this.vscode.commands.executeCommand(
      'vscode.diff',
      baseUri,
      proposedUri,
      `Codex preview: ${description}`,
      { preview: true },
    );
  }

  async dismissPreview(previewId) {
    this._removePreviewContent(previewId, true);
  }

  _removePreviewContent(previewId, fire = false) {
    const index = this.previewOrder.findIndex((entry) => entry.previewId === previewId);
    const match = index >= 0 ? this.previewOrder[index] : undefined;
    if (match) {
      this.previewOrder.splice(index, 1);
      this.previewBytes -= match.size;
      for (const uri of match.uris) {
        this.previewContents.delete(uri);
        if (fire) {
          this.previewEmitter.fire(this.vscode.Uri.parse(uri));
        }
      }
    }
  }
}

function sameContentChanges(actual, expectedEdits) {
  if (actual.length !== expectedEdits.length) {
    return false;
  }
  const normalize = (entries, actualChanges) => entries
    .map((entry) => actualChanges
      ? {
          start_offset: entry.range_offset,
          end_offset: entry.range_offset + entry.range_length,
          replacement_text: entry.text,
        }
      : entry)
    .sort((left, right) =>
      left.start_offset - right.start_offset || left.end_offset - right.end_offset,
    );
  const normalizedActual = normalize(actual, true);
  const normalizedExpected = normalize(expectedEdits, false);
  return normalizedActual.every((entry, index) => {
    const expected = normalizedExpected[index];
    return entry.start_offset === expected.start_offset &&
      entry.end_offset === expected.end_offset &&
      entry.replacement_text === expected.replacement_text;
  });
}

module.exports = { VscodeAdapter, sameContentChanges };
