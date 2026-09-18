'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');
const { BridgeError } = require('./errors');
const {
  ACCESS_MODES,
  AUTHORIZATION_NOTICE_VERSION,
  assertMethodAllowed,
  grantMatchesIdentity,
  workspaceGrantIdentity,
} = require('./authorization');
const { LiveBridgeEngine } = require('./engine');
const { LocalSocketServer } = require('./socket-server');
const { VscodeAdapter } = require('./vscode-adapter');

let activeController;
const ACCESS_STATE_KEY = 'bufferWeave.accessMode';

class BridgeController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('BufferWeave', { log: true });
    this.instanceId = crypto.randomUUID();
    this.windowId = crypto.randomUUID();
    this.adapter = new VscodeAdapter(vscode, {
      instanceId: this.instanceId,
      windowId: this.windowId,
      output: this.output,
    });
    const configuration = vscode.workspace.getConfiguration('bufferWeave');
    this.engine = new LiveBridgeEngine(this.adapter, {
      maxHistoryRecords: configuration.get('historyLimit', 256),
      maxHistoryBytes: configuration.get('historyBytes', 4 * 1024 * 1024),
    });
    this.server = undefined;
    this.disposables = [];
    this.authorizationGeneration = 0;
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    this.statusItem.command = 'bufferWeave.showStatus';
  }

  async initialize() {
    this.adapter.initialize();
    this.disposables.push(
      this.adapter.onDidChange((event) => this.engine.recordChange(event)),
      this.adapter.onDidForget((documentInstanceId) => this.engine.forgetDocument(documentInstanceId)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.setAccessMode(ACCESS_MODES.DISABLED).catch((error) => {
          this.output.appendLine(`[authorization] workspace change revocation failed: ${error.code || error.name}`);
        });
      }),
      vscode.commands.registerCommand('bufferWeave.applyPreview', () => this.applyPreviewCommand()),
      vscode.commands.registerCommand('bufferWeave.rejectPreview', () => this.rejectPreviewCommand()),
      vscode.commands.registerCommand('bufferWeave.showStatus', () => this.showStatusCommand()),
      vscode.commands.registerCommand('bufferWeave.grantRead', () => this.grantReadCommand()),
      vscode.commands.registerCommand('bufferWeave.grantEdit', () => this.grantEditCommand()),
      vscode.commands.registerCommand('bufferWeave.grantSave', () => this.grantSaveCommand()),
      vscode.commands.registerCommand('bufferWeave.revokeAccess', () => this.revokeAccessCommand()),
      this.statusItem,
      this.output,
    );

    await this.validateStoredGrant();
    await this.refreshServerState();
    this.statusItem.show();
  }

  accessMode() {
    const grant = this.context.workspaceState.get(ACCESS_STATE_KEY);
    return grant && typeof grant === 'object' && Object.values(ACCESS_MODES).includes(grant.mode)
      ? grant.mode
      : ACCESS_MODES.DISABLED;
  }

  async validateStoredGrant() {
    const grant = this.context.workspaceState.get(ACCESS_STATE_KEY);
    if (this.accessMode() === ACCESS_MODES.DISABLED) {
      return;
    }
    const identity = await this.adapter.identity();
    if (!grantMatchesIdentity(grant, identity)) {
      this.authorizationGeneration += 1;
      await this.context.workspaceState.update(ACCESS_STATE_KEY, undefined);
      this.output.appendLine('[authorization] revoked because the workspace identity or authorization notice changed');
    }
  }

  updateStatusItem() {
    const mode = this.accessMode();
    this.statusItem.text = this.server
      ? `$(shield) Live Bridge: ${mode}`
      : '$(shield) Live Bridge: off';
    this.statusItem.tooltip = this.server
      ? `BufferWeave access for this workspace: ${mode}`
      : 'BufferWeave is not exposing this workspace';
  }

  async refreshServerState() {
    if (!vscode.workspace.isTrusted) {
      await this.stopServer();
      this.output.appendLine('[state] disabled because this workspace is not trusted');
      this.updateStatusItem();
      return false;
    }
    if (this.accessMode() === ACCESS_MODES.DISABLED) {
      await this.stopServer();
      this.output.appendLine('[state] disabled until explicitly enabled for this workspace');
      this.updateStatusItem();
      return false;
    }
    await this.startServer();
    this.updateStatusItem();
    return true;
  }

  async handleRequest(method, params) {
    const mode = this.accessMode();
    assertMethodAllowed(mode, method, params);
    const generation = this.authorizationGeneration;
    const assertAuthorized = () => {
      if (generation !== this.authorizationGeneration) {
        throw new BridgeError('PERMISSION_REVOKED', 'Workspace access changed before the operation could commit.');
      }
      assertMethodAllowed(this.accessMode(), method, params);
    };
    return this.engine.handle(method, params, { assertAuthorized });
  }

  async startServer() {
    if (this.server) {
      return this.server.descriptor();
    }
    const server = new LocalSocketServer({
      instanceId: this.instanceId,
      windowId: this.windowId,
      handler: (method, params) => this.handleRequest(method, params),
      registryProvider: () => this.adapter.identity(),
      output: this.output,
      extensionVersion: this.context.extension?.packageJSON?.version || 'unknown',
      accessModeProvider: () => this.accessMode(),
    });
    this.server = server;
    try {
      await server.start();
    } catch (error) {
      this.server = undefined;
      await server.stop().catch(() => undefined);
      throw error;
    }
    this.output.appendLine(`[startup] ready window_id=${this.windowId}`);
    return server.descriptor();
  }

  async stopServer() {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await server.stop();
      this.output.appendLine('[shutdown] local bridge stopped');
    }
  }

  async restartServerForTests() {
    await this.stopServer();
    return this.startServer();
  }

  async _choosePreview(placeHolder) {
    const previews = this.engine.listPendingPreviews();
    if (previews.length === 0) {
      await vscode.window.showInformationMessage('There are no pending Codex edit previews.');
      return undefined;
    }
    if (previews.length === 1) {
      return previews[0];
    }
    return vscode.window.showQuickPick(
      previews.map((preview) => ({
        label: preview.description,
        description: preview.document_uri,
        preview,
      })),
      { placeHolder },
    ).then((picked) => picked?.preview);
  }

  async applyPreviewCommand() {
    const preview = await this._choosePreview('Choose the Codex preview to apply');
    if (!preview) {
      return;
    }
    try {
      const result = await this.engine.confirmPreview(preview.preview_id);
      if (result.status === 'applied') {
        await vscode.window.showInformationMessage('Applied the Codex preview as one undoable edit.');
      } else {
        await vscode.window.showWarningMessage(
          `The preview was not applied (${result.status}); reread and resolve the newer document.`,
        );
      }
      return result;
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not apply preview: ${safeErrorMessage(error)}`);
      return undefined;
    }
  }

  async rejectPreviewCommand() {
    const preview = await this._choosePreview('Choose the Codex preview to reject');
    if (!preview) {
      return;
    }
    const result = await this.engine.rejectPreview(preview.preview_id);
    if (result.status === 'rejected') {
      await vscode.window.showInformationMessage('Rejected the Codex preview.');
    } else if (result.status === 'applying') {
      await vscode.window.showWarningMessage(
        'This Codex preview is already being applied, so it was not rejected.',
      );
    } else {
      await vscode.window.showInformationMessage('The Codex preview is no longer pending.');
    }
    return result;
  }

  async showStatusCommand() {
    if (!this.server) {
      const reason = !vscode.workspace.isTrusted
        ? 'the workspace is not trusted'
        : 'access has not been granted for this workspace';
      await vscode.window.showInformationMessage(`BufferWeave is not listening because ${reason}.`);
      return;
    }
    const identity = await this.adapter.identity();
    await vscode.window.showInformationMessage(
      `BufferWeave is ready for ${identity.workspace_folders.length} workspace folder(s) with ${this.accessMode()} access.`,
    );
  }

  async _canGrantAccess() {
    if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
      await vscode.window.showWarningMessage('Open a local workspace before enabling BufferWeave.');
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage('Trust this workspace before enabling BufferWeave.');
      return false;
    }
    return true;
  }

  async setAccessMode(mode) {
    if (!Object.values(ACCESS_MODES).includes(mode)) {
      throw new BridgeError('INVALID_ACCESS_MODE', 'Unknown workspace access mode.');
    }
    this.authorizationGeneration += 1;
    await this.stopServer();
    const grant = mode === ACCESS_MODES.DISABLED
      ? undefined
      : {
          mode,
          authorization_notice_version: AUTHORIZATION_NOTICE_VERSION,
          workspace_identity: workspaceGrantIdentity(await this.adapter.identity()),
        };
    await this.context.workspaceState.update(ACCESS_STATE_KEY, grant);
    await this.refreshServerState();
    this.output.appendLine(`[authorization] workspace access changed to ${mode}`);
    return mode;
  }

  async grantReadCommand() {
    if (!await this._canGrantAccess()) {
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      'A quick beta note: this human-directed project was developed with substantial AI assistance. Allow local bridge clients to read open files, including unsaved text, and prepare previews in this workspace? Tool results may be passed to the model or service configured by your client. Access stays enabled on this machine until revoked.',
      { modal: true },
      'Enable Read and Preview',
    );
    if (choice !== 'Enable Read and Preview') {
      return false;
    }
    await this.setAccessMode(ACCESS_MODES.READ);
    await vscode.window.showInformationMessage('BufferWeave may read and preview open files in this workspace.');
    return true;
  }

  async grantEditCommand() {
    if (!await this._canGrantAccess()) {
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      'A quick beta note: this human-directed project was developed with substantial AI assistance. Allow local bridge clients to read unsaved text and change open buffers in this workspace? Tool results may be passed to the model or service configured by your client. Changes remain unsaved by default. Access stays enabled on this machine until revoked.',
      { modal: true },
      'Allow Direct Edits',
    );
    if (choice !== 'Allow Direct Edits') {
      return false;
    }
    await this.setAccessMode(ACCESS_MODES.EDIT);
    await vscode.window.showInformationMessage('BufferWeave may read, preview, and edit open buffers in this workspace.');
    return true;
  }

  async grantSaveCommand() {
    if (!await this._canGrantAccess()) {
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      'A quick beta note: this human-directed project was developed with substantial AI assistance. Allow local bridge clients to read, edit, and save in this workspace? Tool results may be passed to the model or service configured by your client. Saving writes the entire current buffer, including your unsaved changes, to disk. Access stays enabled on this machine until revoked.',
      { modal: true },
      'Allow Saving',
    );
    if (choice !== 'Allow Saving') {
      return false;
    }
    await this.setAccessMode(ACCESS_MODES.SAVE);
    await vscode.window.showInformationMessage('BufferWeave may read, preview, edit, and save in this workspace.');
    return true;
  }

  async revokeAccessCommand() {
    await this.setAccessMode(ACCESS_MODES.DISABLED);
    await vscode.window.showInformationMessage('BufferWeave access was revoked for this workspace.');
    return true;
  }

  descriptor() {
    return this.server?.descriptor();
  }

  async dispose() {
    await this.stopServer();
    this.adapter.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

function safeErrorMessage(error) {
  if (error instanceof BridgeError) {
    return `${error.code}: ${error.message}`;
  }
  return 'internal bridge error';
}

async function activate(context) {
  activeController = new BridgeController(context);
  await activeController.initialize();
  if (
    context.extensionMode !== vscode.ExtensionMode.Test ||
    !process.env.BUFFERWEAVE_TEST_WORKSPACE
  ) {
    return {};
  }
  return {
    descriptor: () => activeController?.descriptor(),
    pendingPreviews: () => activeController?.engine.listPendingPreviews() || [],
    restartForTests: () => activeController?.restartServerForTests(),
    stopForTests: () => activeController?.stopServer(),
    setAccessModeForTests: (mode) => activeController?.setAccessMode(mode),
    confirmPreviewForTests: (previewId) => activeController?.engine.confirmPreview(previewId),
  };
}

async function deactivate() {
  const controller = activeController;
  activeController = undefined;
  await controller?.dispose();
}

module.exports = { activate, deactivate, BridgeController, ACCESS_MODES };
