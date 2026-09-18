'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'mhebtehaj.bufferweave';

function startMcpClient(scriptPath) {
  const child = spawn(process.env.PYTHON || 'python3', [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let stdout = '';
  let stderr = '';
  let exited = false;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    while (true) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) {
        continue;
      }
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        rejectPending(new Error(`MCP emitted invalid JSON: ${error.message}`));
        continue;
      }
      const waiter = pending.get(response.id);
      if (!waiter) {
        continue;
      }
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      if (response.error) {
        waiter.reject(new Error(`MCP ${response.error.code}: ${response.error.message}`));
      } else {
        waiter.resolve(response.result);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  child.on('error', rejectPending);
  child.on('exit', (code, signal) => {
    exited = true;
    if (pending.size > 0) {
      rejectPending(new Error(
        `MCP exited before responding (code=${code}, signal=${signal}): ${stderr.trim()}`,
      ));
    }
  });

  const send = (message) => new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  return {
    async request(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP method ${method}`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
      });
      try {
        await send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        const waiter = pending.get(id);
        if (waiter) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      }
      return response;
    },
    notify(method, params = {}) {
      return send({ jsonrpc: '2.0', method, params });
    },
    async close() {
      if (exited || child.exitCode !== null) {
        assert.equal(child.exitCode, 0, `MCP exited unsuccessfully: ${stderr.trim()}`);
        return;
      }
      const exit = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('MCP did not stop after stdin closed'));
        }, 5_000);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`MCP exit code=${code}, signal=${signal}: ${stderr.trim()}`));
          }
        });
      });
      child.stdin.end();
      await exit;
    },
  };
}

async function callMcpTool(client, name, args) {
  const result = await client.request('tools/call', { name, arguments: args });
  assert.equal(result.isError, false, result.content?.[0]?.text || `${name} failed`);
  assert.ok(result.structuredContent, `${name} omitted structuredContent`);
  return result.structuredContent;
}

async function initializeMcpClient(client, name) {
  const initialized = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name, version: '1.0.0' },
  });
  assert.equal(initialized.protocolVersion, '2025-06-18');
  await client.notify('notifications/initialized');
  const toolList = await client.request('tools/list');
  const toolNames = new Set(toolList.tools.map((tool) => tool.name));
  assert.equal(toolNames.has('read_live_document'), true);
  assert.equal(toolNames.has('apply_live_edits'), true);
}

async function waitFor(predicate, message, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

async function readRegistry(descriptor) {
  return waitFor(async () => {
    try {
      return JSON.parse(await fs.promises.readFile(descriptor.registry_path, 'utf8'));
    } catch {
      return undefined;
    }
  }, 'bridge registry record');
}

async function rpc(record, method, params, id = crypto.randomUUID()) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(record.socket_path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({
      id, token: record.token, method, params,
    })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      socket.end();
      const response = JSON.parse(buffer.slice(0, newline));
      if (!response.ok) {
        const error = new Error(`${response.error.code}: ${response.error.message}`);
        error.code = response.error.code;
        error.data = response.error.data;
        reject(error);
      } else {
        resolve(response.result);
      }
    });
    socket.on('error', reject);
  });
}

function requestFor(snapshot, operationId, edit, description = 'Development Host edit') {
  return {
    path: snapshot.path,
    document_instance_id: snapshot.document_instance_id,
    window_id: snapshot.window_id,
    workspace_id: snapshot.workspace_id,
    operation_id: operationId,
    base_version: snapshot.version,
    description,
    save_after_apply: false,
    edits: [edit],
  };
}

async function openEditor(filePath) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  return { document, editor };
}

async function executeOrdinaryUndo(document, message) {
  await vscode.window.showTextDocument(document, { preview: false });
  await waitFor(
    () => vscode.window.activeTextEditor?.document === document,
    `${message} active editor`,
  );
  let sawUndoEvent = false;
  const listener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document === document && event.reason === vscode.TextDocumentChangeReason.Undo) {
      sawUndoEvent = true;
    }
  });
  try {
    // A background Electron test window can leave Monaco's hidden textarea as
    // the DOM target without text focus. Status-bar focus moves to a non-input
    // element but keeps this document active, so the public Undo command uses
    // its active-code-editor fallback, which focuses the editor and invokes the
    // normal text-model undo.
    await vscode.commands.executeCommand('workbench.action.focusStatusBar');
    await vscode.commands.executeCommand('undo');
    await waitFor(() => sawUndoEvent, `${message} Undo event`);
  } finally {
    listener.dispose();
  }
}

async function read(record, filePath) {
  return rpc(record, 'readDocument', { path: filePath });
}

async function run() {
  const mcpClients = [];
  try {
    const workspacePath = process.env.BUFFERWEAVE_TEST_WORKSPACE;
    const files = JSON.parse(process.env.BUFFERWEAVE_TEST_FILES);
    assert.ok(workspacePath);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Missing development extension ${EXTENSION_ID}`);
    const api = await extension.activate();
    assert.equal(api.descriptor(), undefined, 'installation must expose no workspace by default');
    await api.setAccessModeForTests('read');
    const readDescriptor = await waitFor(() => api.descriptor(), 'read-only socket descriptor');
    const readRecord = await readRegistry(readDescriptor);
    await assert.rejects(
      rpc(readRecord, 'applyEdits', { save_after_apply: false }),
      (error) => error?.code === 'PERMISSION_DENIED',
    );
    await api.setAccessModeForTests('save');
    let descriptor = await waitFor(() => api.descriptor(), 'extension socket descriptor');
    let record = await readRegistry(descriptor);
    assert.match(record.editor_name, /Visual Studio Code/i);
    assert.equal(record.editor_version, vscode.version);
    assert.notEqual(record.socket_path, readRecord.socket_path);
    assert.notEqual(record.token, readRecord.token);
    assert.equal(fs.existsSync(readRecord.socket_path), false);

    await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspacePath, files.hidden)));
    const initiallyOpen = await rpc(record, 'listOpenDocuments', {});
    assert.equal(
      initiallyOpen.documents.some((document) => document.path.endsWith(files.hidden)),
      false,
    );

    const unsavedPath = path.join(workspacePath, files.unsaved);
    const unsaved = await openEditor(unsavedPath);
    await unsaved.editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'UNSAVED '));
    const mcpScript = path.resolve(__dirname, '../../../..', 'bufferweave_mcp.py');
    assert.equal(fs.existsSync(mcpScript), true, `Missing parent MCP server: ${mcpScript}`);
    const mcp = startMcpClient(mcpScript);
    const secondMcp = startMcpClient(mcpScript);
    mcpClients.push(mcp, secondMcp);
    let snapshot;
    let applied;
    await Promise.all([
      initializeMcpClient(mcp, 'bufferweave-host-test-chat-one'),
      initializeMcpClient(secondMcp, 'bufferweave-host-test-chat-two'),
    ]);

    snapshot = await callMcpTool(mcp, 'read_live_document', {
      path: unsavedPath,
      window_id: record.window_id,
      workspace_id: record.workspace_id,
    });
    assert.match(snapshot.editor_name, /Visual Studio Code/i);
    assert.equal(snapshot.editor_version, vscode.version);
    assert.equal(snapshot.text, 'UNSAVED hello world\n');
    assert.equal(snapshot.is_dirty, true);

    const helloOffset = snapshot.text.indexOf('hello');
    applied = await callMcpTool(mcp, 'apply_live_edits', {
      path: unsavedPath,
      window_id: snapshot.window_id,
      workspace_id: snapshot.workspace_id,
      document_instance_id: snapshot.document_instance_id,
      operation_id: 'host-mcp-undo',
      base_version: snapshot.version,
      description: 'Cross-layer Extension Host edit',
      save_after_apply: false,
      edits: [{
        start_offset: helloOffset,
        end_offset: helloOffset + 5,
        expected_original_text: 'hello',
        replacement_text: 'HELLO',
      }],
    });
    const beforeAgent = 'UNSAVED hello world\n';
    assert.equal(applied.status, 'applied');
    assert.equal(unsaved.document.getText(), 'UNSAVED HELLO world\n');
    await executeOrdinaryUndo(unsaved.document, 'single agent transaction');
    await waitFor(() => unsaved.document.getText() === beforeAgent, 'single undo').catch((error) => {
      throw new Error(
        `${error.message}; actual text after undo was ${JSON.stringify(unsaved.document.getText())}`,
      );
    });

    const rebasePath = path.join(workspacePath, files.rebase);
    const rebase = await openEditor(rebasePath);
    snapshot = await read(record, rebasePath);
    const betaOffset = snapshot.text.indexOf('beta');
    await rebase.editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'USER '));
    applied = await rpc(record, 'applyEdits', requestFor(snapshot, 'host-rebase', {
      start_offset: betaOffset,
      end_offset: betaOffset + 4,
      expected_original_text: 'beta',
      replacement_text: 'BETA',
    }));
    assert.equal(applied.status, 'applied');
    assert.equal(rebase.document.getText(), 'USER alpha BETA gamma\n');

    const conflictPath = path.join(workspacePath, files.conflict);
    const conflictEditor = await openEditor(conflictPath);
    snapshot = await read(record, conflictPath);
    const conflictOffset = snapshot.text.indexOf('beta');
    await conflictEditor.editor.edit((builder) => builder.replace(
      new vscode.Range(
        conflictEditor.document.positionAt(conflictOffset + 1),
        conflictEditor.document.positionAt(conflictOffset + 2),
      ),
      'X',
    ));
    const afterUserConflict = conflictEditor.document.getText();
    const conflict = await rpc(record, 'applyEdits', requestFor(snapshot, 'host-conflict', {
      start_offset: conflictOffset,
      end_offset: conflictOffset + 4,
      expected_original_text: 'beta',
      replacement_text: 'BETA',
    }));
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflictEditor.document.getText(), afterUserConflict);

    const queuePath = path.join(workspacePath, files.queue);
    const queueEditor = await openEditor(queuePath);
    snapshot = await read(record, queuePath);
    const queueBase = {
      path: snapshot.path,
      document_instance_id: snapshot.document_instance_id,
      base_version: snapshot.version,
      description: 'Queued host edit',
      save_after_apply: false,
    };
    const [queueOne, queueTwo] = await Promise.all([
      rpc(record, 'applyEdits', {
        ...queueBase,
        operation_id: 'host-queue-one',
        edits: [{ start_offset: 0, end_offset: 3, expected_original_text: 'one', replacement_text: 'ONE' }],
      }),
      rpc(record, 'applyEdits', {
        ...queueBase,
        operation_id: 'host-queue-two',
        edits: [{ start_offset: 8, end_offset: 13, expected_original_text: 'three', replacement_text: 'THREE' }],
      }),
    ]);
    assert.equal(queueOne.status, 'applied');
    assert.equal(queueTwo.status, 'applied');
    assert.equal(queueEditor.document.getText(), 'ONE two THREE\n');

    const multiNonoverlapPath = path.join(workspacePath, files.multiNonoverlap);
    const multiNonoverlapEditor = await openEditor(multiNonoverlapPath);
    const [firstNonoverlapSnapshot, secondNonoverlapSnapshot] = await Promise.all([
      callMcpTool(mcp, 'read_live_document', {
        path: multiNonoverlapPath,
        window_id: record.window_id,
        workspace_id: record.workspace_id,
      }),
      callMcpTool(secondMcp, 'read_live_document', {
        path: multiNonoverlapPath,
        window_id: record.window_id,
        workspace_id: record.workspace_id,
      }),
    ]);
    assert.equal(firstNonoverlapSnapshot.version, secondNonoverlapSnapshot.version);
    assert.equal(
      firstNonoverlapSnapshot.document_instance_id,
      secondNonoverlapSnapshot.document_instance_id,
    );
    assert.equal(firstNonoverlapSnapshot.text, 'alpha beta gamma\n');
    assert.equal(secondNonoverlapSnapshot.text, firstNonoverlapSnapshot.text);
    const firstNonoverlapOffset = firstNonoverlapSnapshot.text.indexOf('alpha');
    const secondNonoverlapOffset = secondNonoverlapSnapshot.text.indexOf('gamma');
    const [firstNonoverlap, secondNonoverlap] = await Promise.all([
      callMcpTool(mcp, 'apply_live_edits', {
        path: multiNonoverlapPath,
        window_id: firstNonoverlapSnapshot.window_id,
        workspace_id: firstNonoverlapSnapshot.workspace_id,
        document_instance_id: firstNonoverlapSnapshot.document_instance_id,
        base_version: firstNonoverlapSnapshot.version,
        description: 'First independent MCP process edit',
        save_after_apply: false,
        edits: [{
          start_offset: firstNonoverlapOffset,
          end_offset: firstNonoverlapOffset + 5,
          expected_original_text: 'alpha',
          replacement_text: 'ALPHA',
        }],
      }),
      callMcpTool(secondMcp, 'apply_live_edits', {
        path: multiNonoverlapPath,
        window_id: secondNonoverlapSnapshot.window_id,
        workspace_id: secondNonoverlapSnapshot.workspace_id,
        document_instance_id: secondNonoverlapSnapshot.document_instance_id,
        base_version: secondNonoverlapSnapshot.version,
        description: 'Second independent MCP process edit',
        save_after_apply: false,
        edits: [{
          start_offset: secondNonoverlapOffset,
          end_offset: secondNonoverlapOffset + 5,
          expected_original_text: 'gamma',
          replacement_text: 'GAMMA',
        }],
      }),
    ]);
    assert.equal(firstNonoverlap.status, 'applied');
    assert.equal(secondNonoverlap.status, 'applied');
    assert.equal(multiNonoverlapEditor.document.getText(), 'ALPHA beta GAMMA\n');

    const multiOverlapPath = path.join(workspacePath, files.multiOverlap);
    const multiOverlapEditor = await openEditor(multiOverlapPath);
    const [firstOverlapSnapshot, secondOverlapSnapshot] = await Promise.all([
      callMcpTool(mcp, 'read_live_document', {
        path: multiOverlapPath,
        window_id: record.window_id,
        workspace_id: record.workspace_id,
      }),
      callMcpTool(secondMcp, 'read_live_document', {
        path: multiOverlapPath,
        window_id: record.window_id,
        workspace_id: record.workspace_id,
      }),
    ]);
    assert.equal(firstOverlapSnapshot.version, secondOverlapSnapshot.version);
    assert.equal(
      firstOverlapSnapshot.document_instance_id,
      secondOverlapSnapshot.document_instance_id,
    );
    assert.equal(firstOverlapSnapshot.text, 'alpha beta gamma\n');
    assert.equal(secondOverlapSnapshot.text, firstOverlapSnapshot.text);
    const firstOverlapOffset = firstOverlapSnapshot.text.indexOf('beta');
    const secondOverlapOffset = secondOverlapSnapshot.text.indexOf('beta');
    const [firstOverlap, secondOverlap] = await Promise.all([
      callMcpTool(mcp, 'apply_live_edits', {
        path: multiOverlapPath,
        window_id: firstOverlapSnapshot.window_id,
        workspace_id: firstOverlapSnapshot.workspace_id,
        document_instance_id: firstOverlapSnapshot.document_instance_id,
        base_version: firstOverlapSnapshot.version,
        description: 'First overlapping independent MCP process edit',
        save_after_apply: false,
        edits: [{
          start_offset: firstOverlapOffset,
          end_offset: firstOverlapOffset + 4,
          expected_original_text: 'beta',
          replacement_text: 'BETA-ONE',
        }],
      }),
      callMcpTool(secondMcp, 'apply_live_edits', {
        path: multiOverlapPath,
        window_id: secondOverlapSnapshot.window_id,
        workspace_id: secondOverlapSnapshot.workspace_id,
        document_instance_id: secondOverlapSnapshot.document_instance_id,
        base_version: secondOverlapSnapshot.version,
        description: 'Second overlapping independent MCP process edit',
        save_after_apply: false,
        edits: [{
          start_offset: secondOverlapOffset,
          end_offset: secondOverlapOffset + 4,
          expected_original_text: 'beta',
          replacement_text: 'BETA-TWO',
        }],
      }),
    ]);
    assert.deepEqual(
      [firstOverlap.status, secondOverlap.status].sort(),
      ['applied', 'conflict'],
    );
    const winningText = firstOverlap.status === 'applied' ? 'BETA-ONE' : 'BETA-TWO';
    const losingText = firstOverlap.status === 'conflict' ? 'BETA-ONE' : 'BETA-TWO';
    const afterOverlap = `alpha ${winningText} gamma\n`;
    assert.equal(multiOverlapEditor.document.getText(), afterOverlap);
    assert.equal(multiOverlapEditor.document.getText().includes(losingText), false);
    const overlapConflict = firstOverlap.status === 'conflict' ? firstOverlap : secondOverlap;
    assert.equal(overlapConflict.current_text, winningText);
    await executeOrdinaryUndo(
      multiOverlapEditor.document,
      'overlapping multi-client winner transaction',
    );
    await waitFor(
      () => multiOverlapEditor.document.getText() === 'alpha beta gamma\n',
      'one undo after an overlapping multi-client race',
    );

    const previewPath = path.join(workspacePath, files.preview);
    const previewEditor = await openEditor(previewPath);
    snapshot = await read(record, previewPath);
    const previewOffset = snapshot.text.indexOf('target');
    const preview = await rpc(record, 'previewEdits', requestFor(snapshot, 'host-preview', {
      start_offset: previewOffset,
      end_offset: previewOffset + 6,
      expected_original_text: 'target',
      replacement_text: 'TARGET',
    }));
    assert.equal(preview.status, 'preview_ready');
    assert.equal(previewEditor.document.getText(), 'preview target\n');
    applied = await api.confirmPreviewForTests(preview.preview_id);
    assert.equal(applied.status, 'applied');
    assert.equal(previewEditor.document.getText(), 'preview TARGET\n');

    const diskPath = path.join(workspacePath, files.disk);
    const diskEditor = await openEditor(diskPath);
    snapshot = await read(record, diskPath);
    const diskBeta = snapshot.text.indexOf('beta');
    await fs.promises.writeFile(diskPath, 'alpha DISK gamma\n');
    const reloaded = await waitFor(
      () => diskEditor.document.getText() === 'alpha DISK gamma\n',
      'clean document disk reload',
      5_000,
    ).catch(async () => {
      await vscode.window.showTextDocument(diskEditor.document, { preview: false });
      await vscode.commands.executeCommand('workbench.action.files.revert');
      return waitFor(() => diskEditor.document.getText() === 'alpha DISK gamma\n', 'explicit disk reload');
    });
    assert.ok(reloaded);
    const diskConflict = await rpc(record, 'applyEdits', requestFor(snapshot, 'host-disk', {
      start_offset: diskBeta,
      end_offset: diskBeta + 4,
      expected_original_text: 'beta',
      replacement_text: 'BETA',
    }));
    assert.equal(diskConflict.status, 'conflict');
    assert.equal(diskEditor.document.getText(), 'alpha DISK gamma\n');

    const unicodePath = path.join(workspacePath, files.unicode);
    const unicodeEditor = await openEditor(unicodePath);
    snapshot = await read(record, unicodePath);
    assert.equal(snapshot.eol, '\r\n');
    assert.match(snapshot.document_uri, /%23/);
    const unicodeTarget = snapshot.text.indexOf('α + 😀');
    const unicodeRequest = requestFor(snapshot, 'host-unicode', {
      start_offset: unicodeTarget,
      end_offset: unicodeTarget + 'α + 😀'.length,
      expected_original_text: 'α + 😀',
      replacement_text: 'β &= 😀\n  &+ 1',
    });
    unicodeRequest.save_after_apply = true;
    applied = await rpc(record, 'applyEdits', unicodeRequest);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.saved, true);
    assert.equal(applied.save_status, 'saved');
    await waitFor(() => !unicodeEditor.document.isDirty, 'CRLF edit save');
    const savedUnicodeText = '\\begin{align}\r\n  β &= 😀\r\n  &+ 1\r\n\\end{align}\r\n';
    assert.equal(
      unicodeEditor.document.getText(),
      savedUnicodeText,
    );
    assert.deepEqual(
      await fs.promises.readFile(unicodePath),
      Buffer.from(savedUnicodeText, 'utf8'),
    );

    snapshot = await read(record, unicodePath);
    const idempotent = requestFor(snapshot, 'host-idempotent', {
      start_offset: snapshot.text.length,
      end_offset: snapshot.text.length,
      expected_original_text: '',
      replacement_text: '% once\r\n',
    });
    await rpc(record, 'applyEdits', idempotent);
    await rpc(record, 'applyEdits', structuredClone(idempotent));
    assert.equal(unicodeEditor.document.getText().match(/% once/g).length, 1);

    snapshot = await read(record, unicodePath);
    const saveRequest = {
      path: snapshot.path,
      document_instance_id: snapshot.document_instance_id,
      window_id: snapshot.window_id,
      workspace_id: snapshot.workspace_id,
      operation_id: 'host-save-document',
      expected_version: snapshot.version,
    };
    const saved = await rpc(record, 'saveDocument', saveRequest);
    assert.equal(saved.status, 'saved');
    await waitFor(() => !unicodeEditor.document.isDirty, 'standalone document save');
    const finalUnicodeText = `${savedUnicodeText}% once\r\n`;
    assert.deepEqual(
      await fs.promises.readFile(unicodePath),
      Buffer.from(finalUnicodeText, 'utf8'),
    );
    const replayedSave = await rpc(record, 'saveDocument', structuredClone(saveRequest));
    assert.deepEqual(replayedSave, saved);

    const oldSocket = record.socket_path;
    descriptor = await api.restartForTests();
    record = await readRegistry(descriptor);
    assert.notEqual(record.socket_path, oldSocket);
    assert.equal(fs.existsSync(oldSocket), false);
    const postRestart = await rpc(record, 'listWorkspaces', {});
    assert.equal(postRestart.window_id, descriptor.window_id);
    const rediscovered = await callMcpTool(mcp, 'list_editor_workspaces', {});
    assert.equal(
      rediscovered.windows.some((workspace) => workspace.window_id === descriptor.window_id),
      true,
    );
    const postRestartRead = await callMcpTool(mcp, 'read_live_document', {
      path: unicodePath,
      window_id: descriptor.window_id,
      workspace_id: record.workspace_id,
    });
    assert.equal(postRestartRead.text, finalUnicodeText);
    const finalSocket = record.socket_path;
    await api.setAccessModeForTests('disabled');
    assert.equal(api.descriptor(), undefined);
    assert.equal(fs.existsSync(finalSocket), false);
    console.log('BufferWeave Extension Development Host checks passed.');
  } finally {
    let mcpCloseError;
    for (const client of mcpClients) {
      try {
        await client.close();
      } catch (error) {
        mcpCloseError ||= error;
      }
    }
    try {
      await vscode.commands.executeCommand('workbench.action.files.saveAll');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    if (mcpCloseError) {
      throw mcpCloseError;
    }
  }
}

module.exports = { run };
