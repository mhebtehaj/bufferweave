'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { BridgeError, requireObject, requireString } = require('./errors');
const { JsonLineDecoder, encodeMessage } = require('./framing');
const { METHODS, PROTOCOL_VERSION } = require('./protocol');

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function defaultRegistryDirectory() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return `/tmp/bufferweave-${uid}`;
}

function registryDirectoryFromEnvironment(environment = process.env) {
  const configured = environment.BUFFERWEAVE_REGISTRY_DIR;
  const registryDirectory = configured || defaultRegistryDirectory();
  if (!path.isAbsolute(registryDirectory)) {
    throw new BridgeError('INVALID_CONFIGURATION', 'BUFFERWEAVE_REGISTRY_DIR must be absolute');
  }
  return path.normalize(registryDirectory);
}

async function ensurePrivateDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new BridgeError('INSECURE_REGISTRY', 'Bridge registry must be a real directory');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new BridgeError('INSECURE_REGISTRY', 'Bridge registry is not owned by this user');
  }
  await fs.promises.chmod(directory, 0o700);
}

function tokenMatches(candidate, expected) {
  const candidateDigest = crypto.createHash('sha256').update(
    typeof candidate === 'string' ? candidate : '',
    'utf8',
  ).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return typeof candidate === 'string' && crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

class LocalSocketServer {
  constructor({
    instanceId,
    windowId,
    handler,
    registryProvider,
    output,
    registryDirectory = registryDirectoryFromEnvironment(),
    heartbeatMilliseconds = 30_000,
    maxMessageBytes = 32 * 1024 * 1024,
    extensionVersion = 'unknown',
    accessModeProvider = () => 'unknown',
  }) {
    this.instanceId = instanceId;
    this.windowId = windowId;
    this.handler = handler;
    this.registryProvider = registryProvider;
    this.output = output;
    this.registryDirectory = registryDirectory;
    this.heartbeatMilliseconds = heartbeatMilliseconds;
    this.maxMessageBytes = maxMessageBytes;
    this.extensionVersion = extensionVersion;
    this.accessModeProvider = accessModeProvider;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.createdAt = new Date().toISOString();
    this.socketPath = path.join(
      registryDirectory,
      `${crypto.randomBytes(6).toString('hex')}.sock`,
    );
    if (Buffer.byteLength(this.socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new BridgeError(
        'SOCKET_PATH_TOO_LONG',
        `Unix socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes; use a shorter BUFFERWEAVE_REGISTRY_DIR`,
      );
    }
    this.registryPath = path.join(registryDirectory, `${instanceId}.json`);
    this.connections = new Set();
    this.server = undefined;
    this.heartbeat = undefined;
    this.registryWrite = Promise.resolve();
    this.started = false;
    this.responses = new Map();
    this.maxResponses = 512;
    this.maxCachedResponseBytes = 1024 * 1024;
  }

  async start() {
    if (process.platform === 'win32') {
      throw new BridgeError('UNSUPPORTED_PLATFORM', 'Wire protocol 3.0 requires a Unix-domain socket');
    }
    if (this.started) {
      return this.descriptor();
    }
    await ensurePrivateDirectory(this.registryDirectory);
    await fs.promises.rm(this.socketPath, { force: true });
    this.server = net.createServer((connection) => this._connection(connection));
    this.server.on('error', (error) => {
      this.output.appendLine(`[socket] ${error.code || error.name}`);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.socketPath);
    });
    await fs.promises.chmod(this.socketPath, 0o600);
    this.started = true;
    try {
      await this.updateRegistry();
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.heartbeat = setInterval(() => {
      this.updateRegistry().catch((error) => {
        this.output.appendLine(`[registry] heartbeat failed: ${error.code || error.name}`);
      });
    }, this.heartbeatMilliseconds);
    this.heartbeat.unref?.();
    return this.descriptor();
  }

  descriptor() {
    return {
      protocol_version: PROTOCOL_VERSION,
      registry_schema_version: 1,
      extension_version: this.extensionVersion,
      access_mode: this.accessModeProvider(),
      capabilities: ['read', 'preview', 'edit', 'save', 'rebase', 'conflict'],
      instance_id: this.instanceId,
      window_id: this.windowId,
      socket_path: this.socketPath,
      registry_path: this.registryPath,
    };
  }

  updateRegistry() {
    this.registryWrite = this.registryWrite.catch(() => undefined).then(async () => {
      if (!this.started) {
        return;
      }
      const workspace = await this.registryProvider();
      const record = {
        protocol_version: PROTOCOL_VERSION,
        registry_schema_version: 1,
        extension_version: this.extensionVersion,
        access_mode: this.accessModeProvider(),
        capabilities: ['read', 'preview', 'edit', 'save', 'rebase', 'conflict'],
        instance_id: this.instanceId,
        window_id: this.windowId,
        pid: process.pid,
        socket_path: this.socketPath,
        token: this.token,
        editor_name: workspace.editor_name,
        editor_version: workspace.editor_version,
        workspace_id: workspace.workspace_id,
        workspace_folders: workspace.workspace_folders,
        workspace_file: workspace.workspace_file,
        created_at: this.createdAt,
        updated_at: new Date().toISOString(),
      };
      const temporaryPath = `${this.registryPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.promises.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      try {
        await fs.promises.rename(temporaryPath, this.registryPath);
        await fs.promises.chmod(this.registryPath, 0o600);
      } finally {
        await fs.promises.rm(temporaryPath, { force: true });
      }
    });
    return this.registryWrite;
  }

  _connection(connection) {
    this.connections.add(connection);
    const decoder = new JsonLineDecoder({ maxBytes: this.maxMessageBytes });
    connection.on('close', () => this.connections.delete(connection));
    connection.on('error', () => undefined);
    connection.on('data', (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch {
        connection.end(encodeMessage({
          id: null,
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        }));
        return;
      }
      for (const message of messages) {
        this._handleMessage(connection, message);
      }
    });
  }

  async _handleMessage(connection, message) {
    const id = message && typeof message === 'object' ? (message.id ?? null) : null;
    if (!message || typeof message !== 'object' || !tokenMatches(message.token, this.token)) {
      connection.end(encodeMessage({
        id,
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      }));
      return;
    }

    let method = 'unknown';
    try {
      requireObject(message, 'request');
      if (
        typeof message.id !== 'string' ||
        message.id.length === 0 ||
        [...message.id].length > 128
      ) {
        throw new BridgeError('INVALID_REQUEST', 'id must be a globally unique string of 1-128 characters');
      }
      method = requireString(message.method, 'method');
      if (!METHODS.includes(method)) {
        throw new BridgeError('METHOD_NOT_FOUND', `Unknown method: ${method}`);
      }
      const params = message.params === undefined ? {} : requireObject(message.params);
      const cacheResponse = method === 'applyEdits' || method === 'saveDocument' || method === 'previewEdits';
      const requestKey = message.id;
      const fingerprint = crypto.createHash('sha256')
        .update(canonicalFingerprint({ method, params }))
        .digest('hex');
      if (cacheResponse) {
        const existing = this.responses.get(requestKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new BridgeError(
              'REQUEST_ID_REUSED',
              'The request id was already used with different method or parameters',
            );
          }
          connection.write(encodeMessage(await existing.promise));
          return;
        }
      }
      const startedAt = Date.now();
      const effectiveParams = {
        ...params,
        operation_id: params.operation_id ?? String(message.id),
      };
      const promise = Promise.resolve()
        .then(() => this.handler(method, effectiveParams))
        .then((result) => {
          this.output.appendLine(
            `[request] method=${method} ok${scalarResultMetadata(result)} duration_ms=${Date.now() - startedAt}`,
          );
          return { id, ok: true, result };
        })
        .catch((error) => {
          const bridgeError = error instanceof BridgeError
            ? error
            : new BridgeError('INTERNAL_ERROR', 'The live bridge request failed');
          const responseError = { code: bridgeError.code, message: bridgeError.message };
          if (bridgeError.data !== undefined) {
            responseError.data = bridgeError.data;
          }
          this.output.appendLine(
            `[request] method=${method} error=${bridgeError.code} duration_ms=${Date.now() - startedAt}`,
          );
          return { id, ok: false, error: responseError };
        });
      if (cacheResponse) {
        const entry = { fingerprint, promise, settled: false, created_at: Date.now() };
        this.responses.set(requestKey, entry);
        promise.then(
          (response) => {
            entry.settled = true;
            if (Buffer.byteLength(JSON.stringify(response), 'utf8') > this.maxCachedResponseBytes) {
              this.responses.delete(requestKey);
            }
            this._pruneResponses();
          },
          () => {
            entry.settled = true;
            this.responses.delete(requestKey);
          },
        );
        this._pruneResponses();
      }
      connection.write(encodeMessage(await promise));
    } catch (error) {
      const bridgeError = error instanceof BridgeError
        ? error
        : new BridgeError('INTERNAL_ERROR', 'The live bridge request failed');
      const responseError = { code: bridgeError.code, message: bridgeError.message };
      if (bridgeError.data !== undefined) {
        responseError.data = bridgeError.data;
      }
      connection.write(encodeMessage({ id, ok: false, error: responseError }));
      this.output.appendLine(`[request] method=${method} error=${bridgeError.code}`);
    }
  }

  _pruneResponses() {
    const expiry = Date.now() - 30 * 60 * 1000;
    for (const [key, entry] of this.responses) {
      if (entry.settled && entry.created_at < expiry) {
        this.responses.delete(key);
      }
    }
    while (this.responses.size > this.maxResponses) {
      const removable = [...this.responses].find(([, entry]) => entry.settled);
      if (!removable) {
        break;
      }
      this.responses.delete(removable[0]);
    }
  }

  async stop() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.started = false;
    await this.registryWrite.catch(() => undefined);
    for (const connection of this.connections) {
      connection.destroy();
    }
    this.connections.clear();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await Promise.all([
      fs.promises.rm(this.registryPath, { force: true }),
      fs.promises.rm(this.socketPath, { force: true }),
    ]);
  }
}

function canonicalFingerprint(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalFingerprint).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalFingerprint(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function scalarResultMetadata(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return '';
  }
  const fields = [];
  if (typeof result.status === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.status)) {
    fields.push(`status=${result.status}`);
  }
  for (const name of ['base_version', 'current_version', 'applied_version']) {
    if (Number.isSafeInteger(result[name]) && result[name] >= 0) {
      fields.push(`${name}=${result[name]}`);
    }
  }
  return fields.length > 0 ? ` ${fields.join(' ')}` : '';
}

module.exports = {
  LocalSocketServer,
  MAX_UNIX_SOCKET_PATH_BYTES,
  defaultRegistryDirectory,
  ensurePrivateDirectory,
  registryDirectoryFromEnvironment,
  tokenMatches,
  canonicalFingerprint,
  scalarResultMetadata,
};
