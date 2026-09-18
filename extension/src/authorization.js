'use strict';

const { BridgeError } = require('./errors');

const ACCESS_MODES = Object.freeze({
  DISABLED: 'disabled',
  READ: 'read',
  EDIT: 'edit',
  SAVE: 'save',
});

// Bump this when the user-facing authorization notice changes materially.
// Stored grants from an older notice are revoked instead of silently carrying
// forward into a different consent model.
const AUTHORIZATION_NOTICE_VERSION = 1;

const READ_METHODS = new Set([
  'listWorkspaces',
  'listOpenDocuments',
  'readDocument',
  'getDocumentChanges',
  'previewEdits',
]);

function assertMethodAllowed(mode, method, params = {}) {
  if (!Object.values(ACCESS_MODES).includes(mode) || mode === ACCESS_MODES.DISABLED) {
    throw new BridgeError('PERMISSION_DENIED', 'This workspace is not exposed to bridge clients.');
  }
  if (READ_METHODS.has(method)) {
    return;
  }
  if (method === 'applyEdits') {
    if (params.save_after_apply && mode !== ACCESS_MODES.SAVE) {
      throw new BridgeError('PERMISSION_DENIED', 'Saving is not allowed for this workspace.');
    }
    if (mode !== ACCESS_MODES.EDIT && mode !== ACCESS_MODES.SAVE) {
      throw new BridgeError('PERMISSION_DENIED', 'Direct editing is not allowed for this workspace.');
    }
    return;
  }
  if (method === 'saveDocument') {
    if (mode !== ACCESS_MODES.SAVE) {
      throw new BridgeError('PERMISSION_DENIED', 'Saving is not allowed for this workspace.');
    }
    return;
  }
  // Method validation remains the engine's responsibility. Do not turn a new,
  // unknown method into an accidental authorization bypass.
  throw new BridgeError('PERMISSION_DENIED', 'This bridge method is not authorized.');
}

function workspaceGrantIdentity(identity) {
  return JSON.stringify({
    workspace_id: identity?.workspace_id || null,
    workspace_file: identity?.workspace_file || null,
    workspace_folders: (identity?.workspace_folders || [])
      .map((folder) => folder.path)
      .sort(),
  });
}

function grantMatchesIdentity(grant, identity) {
  return Boolean(
    grant &&
    typeof grant === 'object' &&
    Object.values(ACCESS_MODES).includes(grant.mode) &&
    grant.mode !== ACCESS_MODES.DISABLED &&
    grant.authorization_notice_version === AUTHORIZATION_NOTICE_VERSION &&
    grant.workspace_identity === workspaceGrantIdentity(identity),
  );
}

module.exports = {
  ACCESS_MODES,
  AUTHORIZATION_NOTICE_VERSION,
  assertMethodAllowed,
  grantMatchesIdentity,
  workspaceGrantIdentity,
};
