# BufferWeave extension

This VS Code-compatible extension is the editor half of `bufferweave`. It runs
in Cursor and Visual Studio Code and exposes only text files that are inside a
trusted, explicitly open local workspace and
have a real editor tab. Reads come from `TextDocument`, so they include unsaved
text. Writes use one version-checked `TextEditor.edit` transaction with explicit
undo stops.

> **A quick beta note.** Much of this project's code was written with AI
> assistance, under human direction and review. It has been tested, but it can
> read and change live editor buffers, so use version control or backups and
> review changes before saving. It is provided as-is and used at your own risk.
> This independent project is not affiliated with or endorsed by Cursor,
> Microsoft, or OpenAI. The included MIT license contains the formal warranty
> and liability terms.

This is version-aware collaborative editing, not a CRDT. Multiple independent
Codex MCP processes may connect at once. The extension serializes transactions
for each document, safely rebases through bounded non-overlapping change
history, and refuses ambiguous or overlapping changes.

Installation grants no access. For each trusted workspace, the user explicitly
chooses read/preview, direct-edit, or save access from the Command Palette. The
grant is stored in machine-local workspace state, not repository settings.
Changing between enabled modes restarts the endpoint with a fresh credential;
revoking access stops it and removes the active endpoint. Any workspace-folder
change revokes the grant and requires explicit reauthorization.

## Local transport and discovery

Each connected editor window creates a Unix-domain socket and a JSON registry
entry under `/tmp/bufferweave-<uid>` by default. Tests may override it with
`BUFFERWEAVE_REGISTRY_DIR`. The directory is mode `0700`; registry files
and sockets are mode `0600`. Every request carries a random 256-bit bearer token
from that window's registry record, and token comparison is timing-safe.

The wire format is newline-delimited JSON:

```json
{"id":"globally-unique-id","token":"...","method":"readDocument","params":{"path":"/absolute/file.tex"}}
```

Responses are either `{ "id": ..., "ok": true, "result": ... }` or
`{ "id": ..., "ok": false, "error": { "code": ..., "message": ..., "data": ... } }`.
Request IDs are 1–128 character globally unique strings. Mutating responses are
cached for bounded replay, and edit/save `operation_id` values provide semantic
idempotency across a fresh transport request. Normal MCP calls omit
`operation_id` and inherit a random UUID request id. An explicit operation id is
global within the window cache and is reserved for retrying the exact request
after an uncertain outcome; changed payloads are rejected.

The channel protects against other OS users and accidental clients. It does not
protect against a malicious process already running as the same Unix account,
because such a process can read the owner-only registry and bearer token.

## Versioned edit contract

`readDocument` and `listOpenDocuments` return `document_uri`, canonical `path`,
`document_instance_id`, `version`, `is_dirty`, EOL, workspace, and window IDs.
Offsets are UTF-16 code-unit offsets, exactly matching the VS Code extension API.
Every live edit supplies:

- the same `document_instance_id` (preventing close/reopen version aliasing);
- `base_version` and a stable `operation_id`;
- one or more `{start_offset, end_offset, expected_original_text, replacement_text}` edits;
- a short description and explicit `save_after_apply` choice.

If the base version is current, the expected text is checked immediately. If it
is older, every range is rebased through complete retained history and checked
again. Missing history returns `stale_version`. Overlap returns a structured
`conflict` without writing.

For a nonempty agent range `[s,e)`, an intervening insertion at `s` stays before
the agent edit (the range shifts), an insertion at `e` stays after it, and an
insertion strictly inside conflicts. An agent insertion and an intervening edit
at the same anchor conflict. Event batches are transformed simultaneously.

After validation, all ranges are submitted through one `TextEditor.edit` call.
Preview preparation, edits with their optional guarded save, and standalone
saves use a FIFO queue per document; different documents are independent.
The editor rejects an edit call if the document version changes during handoff; the
bridge then rereads, rebases, and retries safely. A successful call records its
exact change event, so a later keystroke is reported as a later
`current_version`, not mistaken for the agent transaction. If a user change
arrives before an optional save, saving is skipped and the newer buffer remains
dirty. The queue does not block typing; if text changes while the editor's
asynchronous save is already running, callers must treat the returned
`current_version` and `is_dirty` as authoritative and not assume that newer text
was persisted.

Two clients may submit from the same base version. Disjoint changes both commit,
with the later one rebased through the earlier transaction. Overlapping changes
produce one winner and one structured no-write conflict; arrival order is not a
semantic priority rule. Each successful client transaction remains its own
single editor undo step. Agents should divide parallel work by document or
disjoint region and nominate one resolver after an overlap instead of repeatedly
racing on the same text.

`source` values in change history are best-effort. The extension API exposes Undo/Redo
reasons; `agent` is matched to the pending transaction, while `disk` versus
`user_or_extension` is inferred from dirty state. The public API cannot always
distinguish typing, another extension, and a disk reload exactly.

## Preview mode

`previewEdits` requires `save_after_apply=false`. It opens a diff between two
immutable virtual documents and never makes the real document a read-only diff
side. Use **BufferWeave: Apply Pending Preview** or **Reject Pending
Preview** from the Command Palette. The first Apply revalidates the live version
and text before writing. Apply atomically claims the preview: a simultaneous
Reject reports that applying is already in progress instead of falsely
reporting cancellation. A non-applied confirmation is cached as that preview's
settled outcome; reject it and create a fresh preview for a new attempt. Before
asynchronous UI opens, the engine reserves one of eight
global preview slots, stored-request bytes from a 16 MiB aggregate budget, and
exact base-plus-proposed UTF-8 content from a 64 MiB aggregate budget. Oldest
completed previews are evicted through the same authoritative state; oversized
or failed allocations leave neither a pending record nor orphaned UI content.

## Build, test, and package

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run package
```

The fast tests cover rebasing invariants, boundary insertions, conflicts,
history loss, multi-client per-document serialization and guarded-save races,
routing, URI encoding, Unicode,
multiline LaTeX, CRLF, disk changes, authentication, permissions, idempotency,
and reconnection. The integration command downloads VS Code and runs the actual
extension in an Extension Development Host against a disposable workspace. It
also starts the real parent Python MCP server, then checks cross-layer tool
discovery, unsaved reads, immediate edits, one ordinary undo, safe rebase,
conflict refusal, queued edits, preview confirmation, disk reload,
Unicode/CRLF, semantic replay, `save_after_apply`, standalone save, exact CRLF
bytes on disk, same-process MCP rediscovery after a socket restart, and two
simultaneous independent MCP processes whose disjoint edits merge while
overlapping edits produce exactly one commit and one conflict.

## Install and authorize

After reviewing the generated VSIX, install it into Cursor or VS Code with:

```sh
cursor --install-extension ./bufferweave.vsix
# or
code --install-extension ./bufferweave.vsix
```

The repository installer performs both steps and records the selected editor:

```sh
./scripts/install-local --editor cursor
# or
./scripts/install-local --editor code
```

Restart or reload the selected editor. Choose one of the following commands in
each trusted workspace:

- **BufferWeave: Enable Read and Preview for This Workspace**
- **BufferWeave: Allow Direct Edits for This Workspace**
- **BufferWeave: Allow Saving for This Workspace**
- **BufferWeave: Revoke Access for This Workspace**

The repository-level `scripts/install-local` and `scripts/uninstall-local`
helpers perform the complete local setup and teardown. Manual uninstall uses:

```sh
cursor --uninstall-extension mhebtehaj.bufferweave
# or
code --uninstall-extension mhebtehaj.bufferweave
```

No shell execution, relative paths, virtual documents, untitled buffers,
untrusted workspaces, remote workspaces, or files merely loaded by another
extension are exposed. History and idempotency caches are bounded; after their
retention window, clients must reread. Implicit routing fails closed if another
non-stale registry entry is incompatible or cannot be safely inspected; use an
exact healthy window id or reload that editor window. The full automated suite
runs in a real VS Code Extension Host. Installed-Cursor smoke testing has also
verified undo and real two-window routing with disposable workspace identities;
an installed-VS-Code smoke test remains part of the public release gate.

Report security vulnerabilities privately through
[GitHub Security Advisories](https://github.com/mhebtehaj/bufferweave/security/advisories/new).
