'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cursor-live-host-'));
  const registryPath = await fs.promises.mkdtemp('/tmp/cb-host-registry-');
  const userDataPath = await fs.promises.mkdtemp('/tmp/cb-host-user-');
  const extensionsPath = await fs.promises.mkdtemp('/tmp/cb-host-ext-');
  const files = {
    unsaved: 'unsaved.tex',
    rebase: 'rebase.tex',
    conflict: 'conflict.tex',
    queue: 'queue.tex',
    multiNonoverlap: 'multi-agent-nonoverlap.tex',
    multiOverlap: 'multi-agent-overlap.tex',
    disk: 'disk.tex',
    unicode: 'unicode # α.tex',
    hidden: 'loaded-but-not-tab.tex',
    preview: 'preview.tex',
  };
  await Promise.all([
    fs.promises.writeFile(path.join(workspacePath, files.unsaved), 'hello world\n'),
    fs.promises.writeFile(path.join(workspacePath, files.rebase), 'alpha beta gamma\n'),
    fs.promises.writeFile(path.join(workspacePath, files.conflict), 'alpha beta gamma\n'),
    fs.promises.writeFile(path.join(workspacePath, files.queue), 'one two three\n'),
    fs.promises.writeFile(
      path.join(workspacePath, files.multiNonoverlap),
      'alpha beta gamma\n',
    ),
    fs.promises.writeFile(
      path.join(workspacePath, files.multiOverlap),
      'alpha beta gamma\n',
    ),
    fs.promises.writeFile(path.join(workspacePath, files.disk), 'alpha beta gamma\n'),
    fs.promises.writeFile(
      path.join(workspacePath, files.unicode),
      '\\begin{align}\r\n  α + 😀\r\n\\end{align}\r\n',
    ),
    fs.promises.writeFile(path.join(workspacePath, files.hidden), 'not an editor tab\n'),
    fs.promises.writeFile(path.join(workspacePath, files.preview), 'preview target\n'),
  ]);
  try {
    let vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
    if (
      process.platform === 'darwin' &&
      !fs.existsSync(vscodeExecutablePath) &&
      vscodeExecutablePath.endsWith(`${path.sep}Electron`)
    ) {
      const codeExecutable = path.join(path.dirname(vscodeExecutablePath), 'Code');
      if (fs.existsSync(codeExecutable)) {
        vscodeExecutablePath = codeExecutable;
      }
    }
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        `--user-data-dir=${userDataPath}`,
        `--extensions-dir=${extensionsPath}`,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        BUFFERWEAVE_REGISTRY_DIR: registryPath,
        BUFFERWEAVE_TEST_WORKSPACE: workspacePath,
        BUFFERWEAVE_TEST_FILES: JSON.stringify(files),
      },
    });
  } finally {
    await Promise.all([
      fs.promises.rm(workspacePath, { recursive: true, force: true }),
      fs.promises.rm(registryPath, { recursive: true, force: true }),
      fs.promises.rm(userDataPath, { recursive: true, force: true }),
      fs.promises.rm(extensionsPath, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error('Extension Development Host tests failed:', error);
  process.exit(1);
});
