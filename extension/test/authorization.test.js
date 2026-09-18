'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACCESS_MODES,
  AUTHORIZATION_NOTICE_VERSION,
  assertMethodAllowed,
  grantMatchesIdentity,
  workspaceGrantIdentity,
} = require('../src/authorization');

function denied(mode, method, params = {}) {
  assert.throws(
    () => assertMethodAllowed(mode, method, params),
    (error) => error?.code === 'PERMISSION_DENIED',
  );
}

test('disabled mode denies every client method', () => {
  denied(ACCESS_MODES.DISABLED, 'readDocument');
  denied(ACCESS_MODES.DISABLED, 'applyEdits');
  denied(ACCESS_MODES.DISABLED, 'saveDocument');
});

test('read mode permits reads and previews but denies edits and saves', () => {
  for (const method of [
    'listWorkspaces',
    'listOpenDocuments',
    'readDocument',
    'getDocumentChanges',
    'previewEdits',
  ]) {
    assert.doesNotThrow(() => assertMethodAllowed(ACCESS_MODES.READ, method));
  }
  denied(ACCESS_MODES.READ, 'applyEdits', { save_after_apply: false });
  denied(ACCESS_MODES.READ, 'saveDocument');
});

test('edit mode permits direct unsaved edits but not saving', () => {
  assert.doesNotThrow(() => assertMethodAllowed(ACCESS_MODES.EDIT, 'applyEdits', {
    save_after_apply: false,
  }));
  denied(ACCESS_MODES.EDIT, 'applyEdits', { save_after_apply: true });
  denied(ACCESS_MODES.EDIT, 'saveDocument');
});

test('save mode permits reads, direct edits, edits with save, and standalone save', () => {
  assert.doesNotThrow(() => assertMethodAllowed(ACCESS_MODES.SAVE, 'readDocument'));
  assert.doesNotThrow(() => assertMethodAllowed(ACCESS_MODES.SAVE, 'applyEdits', {
    save_after_apply: false,
  }));
  assert.doesNotThrow(() => assertMethodAllowed(ACCESS_MODES.SAVE, 'applyEdits', {
    save_after_apply: true,
  }));
  assert.doesNotThrow(() => assertMethodAllowed(ACCESS_MODES.SAVE, 'saveDocument'));
});

test('unknown methods fail closed in every mode', () => {
  denied(ACCESS_MODES.READ, 'futureMutation');
  denied(ACCESS_MODES.EDIT, 'futureMutation');
  denied(ACCESS_MODES.SAVE, 'futureMutation');
});

test('workspace grants are bound to the exact canonical folder set', () => {
  const identity = {
    workspace_id: 'workspace-one',
    workspace_file: '/workspace/project.code-workspace',
    workspace_folders: [{ path: '/workspace/a' }, { path: '/workspace/b' }],
  };
  const grant = {
    mode: ACCESS_MODES.EDIT,
    authorization_notice_version: AUTHORIZATION_NOTICE_VERSION,
    workspace_identity: workspaceGrantIdentity(identity),
  };
  assert.equal(grantMatchesIdentity(grant, {
    ...identity,
    workspace_folders: [...identity.workspace_folders].reverse(),
  }), true);
  assert.equal(grantMatchesIdentity(grant, {
    ...identity,
    workspace_folders: [...identity.workspace_folders, { path: '/workspace/private' }],
  }), false);
  assert.equal(grantMatchesIdentity(grant, {
    ...identity,
    workspace_folders: [{ path: '/workspace/a' }],
  }), false);
  assert.equal(grantMatchesIdentity({
    ...grant,
    authorization_notice_version: AUTHORIZATION_NOTICE_VERSION - 1,
  }, identity), false);
});
