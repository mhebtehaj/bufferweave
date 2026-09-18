'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { BridgeError } = require('./errors');

function isInsidePath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalExistingPath(input, realpath = fs.promises.realpath) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new BridgeError('INVALID_REQUEST', 'path must be a non-empty local path');
  }
  if (!path.isAbsolute(input)) {
    throw new BridgeError('INVALID_REQUEST', 'path must be absolute');
  }
  try {
    return await realpath(input);
  } catch {
    throw new BridgeError('PATH_NOT_FOUND', `Path does not exist: ${input}`);
  }
}

function pathFromFileUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new BridgeError('INVALID_REQUEST', 'document_uri must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new BridgeError('INVALID_REQUEST', 'document_uri must be a valid file URI');
  }
  if (parsed.protocol !== 'file:') {
    throw new BridgeError('OUTSIDE_WORKSPACE', 'Only file: documents can be accessed');
  }
  return fileURLToPath(parsed);
}

async function canonicalizeSelector(selector, realpath = fs.promises.realpath) {
  const fromPath = selector.path
    ? await canonicalExistingPath(selector.path, realpath)
    : undefined;
  const fromUri = selector.document_uri
    ? await canonicalExistingPath(pathFromFileUri(selector.document_uri), realpath)
    : undefined;
  if (!fromPath && !fromUri) {
    throw new BridgeError('INVALID_REQUEST', 'Provide document_uri or path');
  }
  if (fromPath && fromUri && fromPath !== fromUri) {
    throw new BridgeError('ROUTING_MISMATCH', 'document_uri and path identify different files');
  }
  const workspacePath = selector.workspace_path
    ? await canonicalExistingPath(selector.workspace_path, realpath)
    : undefined;
  return {
    ...selector,
    canonical_path: fromPath || fromUri,
    canonical_uri: pathToFileURL(fromPath || fromUri).href,
    canonical_workspace_path: workspacePath,
  };
}

function validateWindowSelector(selector, identity) {
  if (selector.window_id && selector.window_id !== identity.window_id) {
    throw new BridgeError('ROUTING_MISMATCH', 'The request targets a different editor window');
  }
  if (selector.workspace_id && selector.workspace_id !== identity.workspace_id) {
    throw new BridgeError('ROUTING_MISMATCH', 'The request targets a different workspace');
  }
}

function selectDocument(documents, selector, identity) {
  validateWindowSelector(selector, identity);
  let candidates = documents.filter((document) => document.path === selector.canonical_path);
  if (selector.canonical_workspace_path) {
    candidates = candidates.filter(
      (document) => document.workspace?.path === selector.canonical_workspace_path,
    );
  }
  if (selector.document_instance_id) {
    candidates = candidates.filter(
      (document) => document.document_instance_id === selector.document_instance_id,
    );
  }
  if (candidates.length === 0) {
    const samePath = documents.find((document) => document.path === selector.canonical_path);
    if (
      samePath &&
      selector.document_instance_id &&
      samePath.document_instance_id !== selector.document_instance_id
    ) {
      throw new BridgeError('STALE_DOCUMENT', 'The document was closed, reopened, or the extension restarted', {
        current_document_instance_id: samePath.document_instance_id,
      });
    }
    throw new BridgeError('DOCUMENT_NOT_OPEN', 'The requested file is not open inside this editor workspace');
  }
  if (candidates.length > 1) {
    throw new BridgeError('AMBIGUOUS_ROUTING', 'More than one open document matches this request');
  }
  return candidates[0];
}

function selectRegistryInstances(records, selector = {}) {
  let matches = [...records];
  if (selector.window_id) {
    matches = matches.filter((record) => record.window_id === selector.window_id);
  }
  if (selector.workspace_id) {
    matches = matches.filter((record) => record.workspace_id === selector.workspace_id);
  }
  if (selector.workspace_path) {
    matches = matches.filter((record) =>
      record.workspace_folders.some((folder) => folder.path === selector.workspace_path),
    );
  }
  if (matches.length > 1 && !selector.window_id) {
    throw new BridgeError(
      'AMBIGUOUS_ROUTING',
      'Multiple editor windows match; provide the exact window_id',
      { window_ids: matches.map((record) => record.window_id) },
    );
  }
  return matches;
}

module.exports = {
  canonicalExistingPath,
  canonicalizeSelector,
  isInsidePath,
  pathFromFileUri,
  selectDocument,
  selectRegistryInstances,
  validateWindowSelector,
};
