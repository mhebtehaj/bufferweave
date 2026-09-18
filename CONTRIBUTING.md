# Contributing to BufferWeave

Contributions to BufferWeave are welcome, especially focused improvements to
conflict safety, platform support, installation, and independent compatibility
testing. Start with a non-sensitive discussion or bug in the
[issue tracker](https://github.com/mhebtehaj/bufferweave/issues); report security
issues through [private vulnerability reporting](https://github.com/mhebtehaj/bufferweave/security/advisories/new).

## Development setup

Requirements:

- Python 3.10 or newer
- Node.js 22 or newer
- npm
- macOS or Linux for the Unix-socket transport

Run the Python tests from the repository root:

```sh
python3 -m unittest discover -s tests -v
```

Run extension checks and unit tests:

```sh
cd extension
npm ci
npm run build
```

The extension-host suite downloads a disposable VS Code runtime and must never
target a real project. It verifies the core live-buffer and concurrency path in
a real VS Code Extension Development Host:

```sh
npm run test:integration
```

Or run the repository-level verification script:

```sh
./scripts/test-all
```

## Safety invariants

Changes must preserve these properties:

- never replace a live buffer from a possibly stale disk snapshot;
- never guess through ambiguity, missing history, or overlapping edits;
- validate document lifetime, version, range, and expected original text;
- keep one logical transaction as one ordinary editor undo step;
- serialize mutations per document without blocking human typing;
- leave saving under user control unless a request explicitly asks to save;
- never log authentication tokens or complete document contents.

Add regression tests for every behavior change. Keep real user projects and
documents out of fixtures, screenshots, logs, and bug reports.

The same core path has also been verified in installed Cursor. A hands-on smoke
in the normally installed VS Code app remains a release gate; do not describe it
as completed until that test has been recorded.

## Pull requests

Keep changes small and describe their safety impact. Include the commands run
and their results. If behavior or the wire protocol changes, update the README,
`LIVE_COLLABORATION.md`, tests, changelog, and protocol version as appropriate.
