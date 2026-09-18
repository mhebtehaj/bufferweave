'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const {
  LocalSocketServer,
  MAX_UNIX_SOCKET_PATH_BYTES,
  defaultRegistryDirectory,
  tokenMatches,
} = require('../src/socket-server');

function outputCapture() {
  const lines = [];
  return { lines, appendLine: (line) => lines.push(line) };
}

async function rpc(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    socket.on('error', reject);
    socket.on('end', () => {
      if (!buffer) {
        reject(new Error('socket ended without a response'));
      }
    });
  });
}

async function createServer(registryDirectory, handler, output = outputCapture()) {
  const server = new LocalSocketServer({
    instanceId: 'test-instance',
    windowId: 'test-window',
    registryDirectory,
    handler,
    registryProvider: async () => ({
      editor_name: 'Visual Studio Code',
      editor_version: '1.138.0',
      workspace_id: 'workspace',
      workspace_file: null,
      workspace_folders: [{ name: 'scratch', path: '/tmp/scratch', uri: 'file:///tmp/scratch' }],
    }),
    output,
    heartbeatMilliseconds: 60_000,
    extensionVersion: '0.1.0-test',
    accessModeProvider: () => 'edit',
  });
  await server.start();
  return { server, output };
}

test('uses a production-safe short default Unix socket path in UTF-8 bytes', () => {
  const root = defaultRegistryDirectory();
  const server = new LocalSocketServer({
    instanceId: 'instance',
    windowId: 'window',
    handler: async () => ({}),
    registryProvider: async () => ({
      editor_name: 'Visual Studio Code', editor_version: '1.138.0',
      workspace_id: 'w', workspace_file: null, workspace_folders: [],
    }),
    output: outputCapture(),
  });
  assert.equal(root.startsWith('/tmp/bufferweave-'), true);
  assert.ok(Buffer.byteLength(server.socketPath, 'utf8') <= MAX_UNIX_SOCKET_PATH_BYTES);
  assert.throws(() => new LocalSocketServer({
    instanceId: 'i',
    windowId: 'w',
    registryDirectory: `/tmp/${'é'.repeat(60)}`,
    handler: async () => ({}),
    registryProvider: async () => ({
      editor_name: 'Visual Studio Code', editor_version: '1.138.0',
      workspace_id: 'w', workspace_file: null, workspace_folders: [],
    }),
    output: outputCapture(),
  }), { code: 'SOCKET_PATH_TOO_LONG' });
});

test('writes owner-only registry/socket records and authenticates before diagnostics', async (context) => {
  const registry = await fs.promises.mkdtemp('/tmp/cb-socket-');
  context.after(() => fs.promises.rm(registry, { recursive: true, force: true }));
  const { server } = await createServer(registry, async () => ({ ok: true }));
  context.after(() => server.stop());
  const record = JSON.parse(await fs.promises.readFile(server.registryPath, 'utf8'));
  assert.equal(record.socket_path, server.socketPath);
  assert.equal(record.window_id, 'test-window');
  assert.equal(record.editor_name, 'Visual Studio Code');
  assert.equal(record.editor_version, '1.138.0');
  assert.equal(record.registry_schema_version, 1);
  assert.equal(record.extension_version, '0.1.0-test');
  assert.equal(record.access_mode, 'edit');
  assert.equal(record.capabilities.includes('conflict'), true);
  assert.equal((await fs.promises.stat(registry)).mode & 0o777, 0o700);
  assert.equal((await fs.promises.stat(server.registryPath)).mode & 0o777, 0o600);
  assert.equal((await fs.promises.stat(server.socketPath)).mode & 0o777, 0o600);
  assert.equal(tokenMatches(record.token, server.token), true);

  const unauthenticated = await rpc(server.socketPath, {
    id: 'bad', token: 'wrong', method: 'secretBadMethod', params: 'not-object',
  });
  assert.equal(unauthenticated.error.code, 'UNAUTHENTICATED');
  assert.doesNotMatch(unauthenticated.error.message, /method|params/i);
  const repeated = await Promise.all(Array.from({ length: 20 }, (_, index) => rpc(
    server.socketPath,
    { id: `bad-${index}`, token: 'wrong', method: 'listWorkspaces', params: {} },
  )));
  assert.equal(repeated.every((response) => response.error.code === 'UNAUTHENTICATED'), true);
});

test('replays a mutating response once and rejects same request id with changed params', async (context) => {
  const registry = await fs.promises.mkdtemp('/tmp/cb-replay-');
  context.after(() => fs.promises.rm(registry, { recursive: true, force: true }));
  let applications = 0;
  const output = outputCapture();
  const { server } = await createServer(registry, async (method, params) => {
    applications += 1;
    return {
      method,
      application: applications,
      operation_id: params.operation_id,
      status: 'applied',
      base_version: 4,
      applied_version: 5,
      current_version: 6,
    };
  }, output);
  context.after(() => server.stop());
  const request = {
    id: 'stable-request',
    token: server.token,
    method: 'applyEdits',
    params: { description: 'PRIVATE-CONTENT', operation_id: 'semantic-operation' },
  };
  const first = await rpc(server.socketPath, request);
  const replay = await rpc(server.socketPath, structuredClone(request));
  assert.deepEqual(replay, first);
  assert.equal(applications, 1);
  assert.equal(first.result.operation_id, 'semantic-operation');
  const reused = await rpc(server.socketPath, {
    ...request,
    params: { description: 'different', operation_id: 'semantic-operation' },
  });
  assert.equal(reused.error.code, 'REQUEST_ID_REUSED');
  assert.equal(output.lines.join('\n').includes('PRIVATE-CONTENT'), false);
  assert.equal(output.lines.join('\n').includes(server.token), false);
  assert.match(
    output.lines.join('\n'),
    /method=applyEdits ok status=applied base_version=4 current_version=6 applied_version=5/,
  );
  assert.doesNotMatch(output.lines.join('\n'), /path=|token=/);

  const numeric = await rpc(server.socketPath, {
    id: 1, token: server.token, method: 'applyEdits', params: {},
  });
  assert.equal(numeric.error.code, 'INVALID_REQUEST');
});

test('stop removes discovery state and a fresh server reconnects at a new socket', async (context) => {
  const registry = await fs.promises.mkdtemp('/tmp/cb-restart-');
  context.after(() => fs.promises.rm(registry, { recursive: true, force: true }));
  const first = (await createServer(registry, async () => ({ generation: 1 }))).server;
  const oldSocket = first.socketPath;
  await first.stop();
  assert.equal(fs.existsSync(oldSocket), false);
  assert.equal(fs.existsSync(first.registryPath), false);

  const second = (await createServer(registry, async () => ({ generation: 2 }))).server;
  context.after(() => second.stop());
  assert.notEqual(second.socketPath, oldSocket);
  const response = await rpc(second.socketPath, {
    id: 'after-restart', token: second.token, method: 'listWorkspaces', params: {},
  });
  assert.equal(response.result.generation, 2);
});

test('registry startup failure rolls back the listening socket and record', async (context) => {
  const registry = await fs.promises.mkdtemp('/tmp/cb-rollback-');
  context.after(() => fs.promises.rm(registry, { recursive: true, force: true }));
  const server = new LocalSocketServer({
    instanceId: 'rollback-instance',
    windowId: 'rollback-window',
    registryDirectory: registry,
    handler: async () => ({}),
    registryProvider: async () => { throw new Error('registry unavailable'); },
    output: outputCapture(),
  });
  await assert.rejects(() => server.start(), /registry unavailable/);
  assert.equal(fs.existsSync(server.socketPath), false);
  assert.equal(fs.existsSync(server.registryPath), false);
});
