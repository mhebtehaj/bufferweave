# BufferWeave

BufferWeave is a local bridge that lets Codex tasks read and edit live Cursor
or Visual Studio Code buffers—including unsaved text—without silently
overwriting newer work.

Multiple tasks or agents can collaborate in the same document. BufferWeave
serializes their commits, rebases edits that touch disjoint regions, and returns
a structured no-write conflict when edits overlap. Successful agent
transactions remain ordinary editor undo steps, and saving stays under the
user's control unless separately authorized.

> **A quick beta note.** Much of this project's code was written with AI
> assistance, under human direction and review. It has been tested, but it can
> read and change live editor buffers, so use version control or backups and
> review changes before saving. It is provided as-is and used at your own risk.
> BufferWeave is an independent project and is not affiliated with or endorsed
> by Cursor, Microsoft, or OpenAI. See [DISCLAIMER.md](DISCLAIMER.md) for details.

## Why this exists

Filesystem-based agents can read an older saved file while the editor contains
newer unsaved text. A later whole-file write can then erase the user's work.
BufferWeave instead reads the editor's in-memory `TextDocument` and applies
small, version-checked transactions through the extension API.

The result is predictable:

| Situation | Result |
| --- | --- |
| Completed user and Codex edits touch disjoint regions | Both changes survive; repeated races fail without writing |
| Two Codex tasks edit disjoint regions from the same version | The later edit is safely rebased |
| Two tasks edit overlapping text | One may commit; the other receives a conflict and writes nothing |
| Codex changes a buffer | The file remains unsaved by default |
| You press Save | The editor writes the complete visible buffer to disk |
| You press Undo immediately after an agent edit | That agent transaction is undone as one ordinary undo unit |

This is bounded, version-aware operational transformation, not a CRDT. It does
not provide collaborator cursors, presence, or automatic semantic conflict
resolution.

## Safety model

Installation grants no workspace access. In each trusted workspace, choose an
explicit access level from the Command Palette:

- **BufferWeave: Enable Read and Preview for This Workspace** lets clients
  inspect open buffers and prepare previews; only a user action can apply one.
- **BufferWeave: Allow Direct Edits for This Workspace** also permits live
  buffer edits, but not saves.
- **BufferWeave: Allow Saving for This Workspace** also permits writing the
  entire current buffer to disk.
- **BufferWeave: Revoke Access for This Workspace** stops the local endpoint
  and rotates away the active credential.

The current grant is stored in the editor's machine-local workspace state, not
in repository settings. Changing between enabled modes restarts the endpoint
with a fresh credential; revoking access stops it and removes the active
endpoint. A status-bar item continuously shows whether BufferWeave is off,
read-only, edit-capable, or save-capable.

Transport uses an owner-only Unix-domain socket and authenticated registry
record. There is no TCP listener and no client-supplied shell execution. See
[SECURITY.md](SECURITY.md) for the threat model and same-user-process limitation.

## Quick start

Requirements:

- macOS with a local Cursor or Visual Studio Code workspace;
- Python 3.10 or newer;
- Node.js 22 or newer and npm when building the extension from source;
- the selected editor's `cursor` or `code` command-line tool, plus `codex`.

From the repository root, choose the editor explicitly:

```sh
./scripts/install-local --editor cursor
# or
./scripts/install-local --editor code
```

The installer builds and installs `extension/bufferweave.vsix` when needed and
registers the absolute MCP launcher as `bufferweave` with Codex. It does not
enable any workspace. Reload the selected editor, open a trusted non-critical
workspace, run **BufferWeave: Enable Read and Preview for This Workspace**, and
start a new Codex task so the client discovers the tools. Move to direct-edit or
save access only when needed.

From a coordinated GitHub release bundle, install the included CI-tested VSIX
without rebuilding it:

```sh
./scripts/install-local --editor cursor --vsix "$PWD/extension/bufferweave.vsix"
# or use: --editor code
```

Diagnose prerequisites and registration without printing tokens or document
contents:

```sh
./scripts/doctor
```

Uninstall without deleting the source checkout or user files:

```sh
./scripts/uninstall-local
```

## First safe test

1. Create a disposable workspace and open a small `demo.md` file.
2. Type an unsaved sentence.
3. Ask Codex to use `bufferweave` to read the live document and edit a different
   paragraph with `save_after_apply=false`.
4. Confirm that your unsaved sentence survives, the Codex edit appears
   immediately, and the editor still marks the file as unsaved.
5. Press Undo once, redo or repeat the edit, and then press Save. The complete
   visible buffer is what reaches disk.

A recording plan for a public concurrency demonstration is in
[docs/demo.md](docs/demo.md).

## MCP tools

Navigation:

- `check_editor`
- `open_file`
- `open_workspace`

Live-buffer collaboration:

- `list_editor_workspaces`
- `list_open_documents`
- `read_live_document`
- `preview_live_edits`
- `apply_live_edits`
- `save_live_document`
- `get_document_changes`

All mutation requests carry a document lifetime ID, base version, exact
expected original text, and explicit save behavior. Ambiguous windows, stale
document lifetimes, missing history, invalid expected text, overlapping edits,
and repeated version races fail closed.

See [LIVE_COLLABORATION.md](LIVE_COLLABORATION.md) for the architecture,
protocol behavior, conflict format, multi-agent guidance, and recovery rules.

## Verification and editor support

The core path—tool discovery, unsaved reads, version-checked edits, ordinary
Undo, disjoint concurrent merges, and overlap refusal—is verified in a real
Visual Studio Code Extension Development Host and in installed Cursor. The
installed-Cursor smoke also covers real two-window routing.

Both Cursor and Visual Studio Code are supported installation targets through
`--editor cursor|code`. A hands-on smoke in the normally installed Visual Studio
Code app remains a release gate; until it is completed, VS Code support rests on
the real Extension Host integration rather than an installed-app claim.

Current platform boundary:

- macOS with installed Cursor and local workspaces: hands-on verified;
- macOS with VS Code local workspaces: core Extension Host integration verified;
  installed-app smoke pending;
- Linux local workspaces: expected from the Unix-socket implementation but not
  yet verified in an installed editor;
- Windows, remote extension hosts, browser editors, untitled documents,
  notebooks, and virtual workspaces: unsupported.

Opening the same file in two editor windows creates independent buffers;
implicit routing fails as ambiguous until a caller selects a window. History and
idempotency caches are bounded and reset when the extension host restarts.

## Development

Run Python and extension unit tests:

```sh
./scripts/test-all
```

Include the disposable VS Code Extension Development Host integration suite:

```sh
./scripts/test-all --integration
```

Build the VSIX directly:

```sh
cd extension
npm ci
npm run build
npm run package
```

Never point integration tests at a real project or manuscript. Contribution
requirements and safety invariants are in [CONTRIBUTING.md](CONTRIBUTING.md).

See [SUPPORT.md](SUPPORT.md) before filing an issue and
[CHANGELOG.md](CHANGELOG.md) for release history. The project home is
[github.com/mhebtehaj/bufferweave](https://github.com/mhebtehaj/bufferweave).

## License

[MIT](LICENSE). The plain-language beta and development notice is in
[DISCLAIMER.md](DISCLAIMER.md).
