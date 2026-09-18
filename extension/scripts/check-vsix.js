'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'bufferweave.vsix');
const prose = (contents) => contents.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
assert.ok(fs.existsSync(archive), 'VSIX was not created');

function unzip(args) {
  const result = spawnSync('unzip', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

const files = unzip(['-Z1', archive]).trim().split('\n').filter(Boolean);
const allowed = [
  /^extension\.vsixmanifest$/,
  /^\[Content_Types\]\.xml$/,
  /^extension\/(LICENSE\.txt|package\.json|readme\.md)$/,
  /^extension\/src\/[a-z0-9-]+\.js$/,
];
for (const file of files) {
  assert.ok(allowed.some((pattern) => pattern.test(file)), `Unexpected VSIX file: ${file}`);
}

const embeddedManifest = JSON.parse(unzip(['-p', archive, 'extension/package.json']));
const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(embeddedManifest.name, sourceManifest.name);
assert.equal(embeddedManifest.version, sourceManifest.version);
assert.equal(embeddedManifest.publisher, sourceManifest.publisher);
assert.equal(embeddedManifest.repository.url, 'https://github.com/mhebtehaj/bufferweave.git');
assert.equal(embeddedManifest.preview, true);

const embeddedReadme = unzip(['-p', archive, 'extension/readme.md']);
assert.match(embeddedReadme, /A quick beta note\./);
assert.match(prose(embeddedReadme), /code was written with AI assistance, under human direction and review/);

const textPayload = files
  .filter((file) => file.startsWith('extension/') && /\.(js|json|md|txt)$/.test(file))
  .map((file) => unzip(['-p', archive, file]))
  .join('\n');
for (const forbidden of [
  '/Users/',
  'Documents/CONNECTIONS',
  'Library/Application Support',
  'BEGIN OPENSSH PRIVATE KEY',
]) {
  assert.equal(textPayload.includes(forbidden), false, `VSIX contains forbidden text: ${forbidden}`);
}

process.stdout.write(`Validated ${files.length} allowlisted VSIX files.\n`);
