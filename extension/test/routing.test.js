'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  canonicalizeSelector,
  isInsidePath,
  pathFromFileUri,
  selectDocument,
  selectRegistryInstances,
} = require('../src/routing');

test('canonical selector round-trips spaces, Unicode, percent, question and hash', async (context) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cursor-route-'));
  context.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'α space % # ?.tex');
  await fs.promises.writeFile(filePath, 'test');
  const uri = pathToFileURL(filePath).href;
  const selector = await canonicalizeSelector({ path: filePath, document_uri: uri });
  const canonicalPath = await fs.promises.realpath(filePath);
  assert.equal(selector.canonical_path, canonicalPath);
  assert.equal(pathFromFileUri(selector.canonical_uri), canonicalPath);
  assert.match(selector.canonical_uri, /%23/);
  assert.match(selector.canonical_uri, /%3F/);
});

test('rejects relative paths and traversal that resolves outside a workspace', async () => {
  await assert.rejects(() => canonicalizeSelector({ path: '../file.tex' }), {
    code: 'INVALID_REQUEST',
  });
  assert.equal(isInsidePath('/workspace', '/workspace/a.tex'), true);
  assert.equal(isInsidePath('/workspace', '/workspace/../secret/a.tex'), false);
  assert.equal(isInsidePath('/workspace', '/workspace-other/a.tex'), false);
});

test('requires an exact window for ambiguous multi-window routing', () => {
  const records = [
    { window_id: 'one', workspace_id: 'same', workspace_folders: [{ path: '/workspace' }] },
    { window_id: 'two', workspace_id: 'same', workspace_folders: [{ path: '/workspace' }] },
  ];
  assert.throws(() => selectRegistryInstances(records, { workspace_path: '/workspace' }), {
    code: 'AMBIGUOUS_ROUTING',
  });
  assert.equal(selectRegistryInstances(records, { window_id: 'two' })[0].window_id, 'two');
});

test('rejects a stale open-document identity after close and reopen', () => {
  const identity = { window_id: 'window', workspace_id: 'workspace' };
  const documents = [{
    path: '/workspace/a.tex',
    document_instance_id: 'new-instance',
    workspace: { path: '/workspace' },
  }];
  assert.throws(() => selectDocument(documents, {
    canonical_path: '/workspace/a.tex',
    document_instance_id: 'old-instance',
  }, identity), { code: 'STALE_DOCUMENT' });
});
