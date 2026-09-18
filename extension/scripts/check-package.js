'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(root, '..');
const prose = (contents) => contents.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.main, './src/extension.js');
assert.equal(manifest.name, 'bufferweave');
assert.equal(manifest.publisher, 'mhebtehaj');
assert.equal(manifest.repository.url, 'https://github.com/mhebtehaj/bufferweave.git');
assert.equal(manifest.preview, true, 'the extension must remain visibly marked as beta/preview');
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
assert.equal(manifest.contributes.configuration.properties['bufferWeave.enabled'], undefined);
assert.ok(manifest.contributes.commands.some((item) => item.command === 'bufferWeave.grantRead'));
assert.ok(manifest.contributes.commands.some((item) => item.command === 'bufferWeave.revokeAccess'));
assert.ok(fs.existsSync(path.join(root, manifest.main)));
const extensionReadme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert.match(extensionReadme, /A quick beta note\./);
assert.match(prose(extensionReadme), /code was written with AI assistance, under human direction and review/);

const repositoryReadme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
const disclaimer = fs.readFileSync(path.join(repositoryRoot, 'DISCLAIMER.md'), 'utf8');
const installer = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'install-local'), 'utf8');
const releaseIntro = fs.readFileSync(
  path.join(repositoryRoot, '.github', 'release-notes-intro.md'),
  'utf8',
);
for (const [name, contents] of [
  ['repository README', repositoryReadme],
  ['disclaimer', disclaimer],
  ['installer', installer],
  ['release notes intro', releaseIntro],
]) {
  assert.match(contents, /beta/i, `${name} must identify the beta`);
  assert.match(prose(contents), /AI assistance/i, `${name} must disclose AI-assisted development`);
}
assert.match(disclaimer, /accept no\s+responsibility/);

const pythonServer = fs.readFileSync(path.join(repositoryRoot, 'bufferweave_mcp.py'), 'utf8');
const pythonClient = fs.readFileSync(path.join(repositoryRoot, 'bufferweave_client.py'), 'utf8');
const javascriptProtocol = fs.readFileSync(path.join(root, 'src', 'protocol.js'), 'utf8');
const extensionEntry = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
const serverVersion = pythonServer.match(/^SERVER_VERSION = "([^"]+)"/m)?.[1];
const pythonWireVersion = pythonClient.match(/^WIRE_PROTOCOL_VERSION = "([^"]+)"/m)?.[1];
const javascriptWireVersion = javascriptProtocol.match(/^const PROTOCOL_VERSION = '([^']+)'/m)?.[1];
assert.equal(manifest.version, serverVersion, 'MCP and extension product versions must match');
assert.equal(pythonWireVersion, javascriptWireVersion, 'Python and extension wire versions must match');
assert.match(
  extensionEntry,
  /context\.extensionMode\s*!==\s*vscode\.ExtensionMode\.Test/,
  'privileged test exports must require ExtensionMode.Test',
);
for (const expectedNoticeText of [
  'A quick beta note',
  'including unsaved text',
  'model or service configured by your client',
  'Access stays enabled on this machine until revoked',
]) {
  assert.ok(
    extensionEntry.includes(expectedNoticeText),
    `authorization prompts must retain: ${expectedNoticeText}`,
  );
}
assert.equal(
  extensionEntry.split('model or service configured by your client').length - 1,
  3,
  'every grant prompt must disclose the downstream model/service boundary',
);

const sourceFiles = fs.readdirSync(path.join(root, 'src'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => path.join(root, 'src', file));
for (const sourceFile of sourceFiles) {
  const checked = spawnSync(process.execPath, ['--check', sourceFile], { encoding: 'utf8' });
  if (checked.status !== 0) {
    process.stderr.write(checked.stderr);
    process.exit(checked.status || 1);
  }
}

const ignored = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
assert.match(ignored, /node_modules/);
assert.match(ignored, /test/);
process.stdout.write(`Validated manifest and ${sourceFiles.length} extension source files.\n`);
