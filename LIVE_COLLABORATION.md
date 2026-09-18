# BufferWeave live collaboration architecture

BufferWeave joins the `bufferweave` MCP server to a small Cursor/VS Code
extension. It performs version-aware edits against the editor's
`TextDocument`, so an agent reads and changes the in-memory buffer rather than a
possibly older file on disk. It is deliberately not described as a CRDT: it can
rebase changes only while the required, bounded editor change history remains
available, and it refuses overlapping edits.

## Architecture

```text
Codex chat/agent A -- its bufferweave MCP process --\
Codex chat/agent B -- its bufferweave MCP process ----> one authenticated
Codex chat/agent C -- its bufferweave MCP process --/   socket coordinator
                                                       per editor window
                                                                  |
                                                     per-document FIFO queue
                                                                  |
                                                    live TextDocument buffer
```

Each editor extension host publishes a short-lived registry record beneath
`/tmp/bufferweave-<uid>` by default. The directory is mode `0700`; each
record and socket is mode `0600`. The record contains a random per-activation
window id, socket path, process id, workspace identity, and a random bearer
token. Every request is authenticated before dispatch. The MCP process rejects
symlinked, incorrectly owned, broadly readable, stale, incompatible, or
out-of-directory registry entries. No TCP port or shell-execution method is
exposed.

This protects against other OS users and accidental local clients. It does not
protect against a malicious process already running as the same Unix account,
because that process can read the owner-only registry record and bearer token.

Installation alone exposes nothing. Access is stored in the editor's
machine-local workspace state and must be granted explicitly for each trusted
workspace.
Read mode permits listing, reading, change inspection, and preview creation.
Edit mode additionally permits direct unsaved-buffer changes. Save mode also
permits standalone saves and `save_after_apply=true`; it can therefore persist
the user's other unsaved changes in the same buffer. Revocation stops the
server. Every enabled access-mode change restarts it with a fresh socket and
token. Grants are bound to the exact workspace identity and canonical folder
set; adding or removing a folder revokes access until the user authorizes the
new workspace shape. A generation guard is rechecked at the editor's mutation
and save boundaries, so a queued request cannot commit after revocation.
Each grant also records the authorization-notice version; a material notice
change invalidates older grants so the updated choice is made explicitly.

Wire protocol 2.0 makes this authorization model an explicit compatibility
boundary. The MCP client rejects older default-on extension records and records
without the required schema, access mode, version, and capability metadata.

`BUFFERWEAVE_REGISTRY_DIR` may override the registry directory for
isolated tests. Unix socket paths have a small platform limit, so production
uses the short `/tmp` root and the extension rejects an overlong override.

The extension canonicalizes the file and every open workspace folder with
`realpath`. Only an already-open `file:` document contained in an explicitly
open, trusted local workspace can be read, previewed, edited, or saved. A
document open in two windows is ambiguous until the request supplies the exact
`window_id`. A random `document_instance_id` also changes whenever a document
is closed/reopened or the extension restarts, preventing an old version number
from aliasing a new buffer lifetime.

## MCP tools

Navigation tools:

- `open_file`
- `open_workspace`
- `check_editor`

The live extension adds:

- `list_editor_workspaces`
- `list_open_documents`
- `read_live_document`
- `preview_live_edits`
- `apply_live_edits`
- `save_live_document`
- `get_document_changes`

Text offsets are zero-based UTF-16 code-unit offsets, which is the coordinate
system used by the VS Code-compatible document API. Reads return the canonical
`document_uri` and path, requested text and range, `version`,
`document_instance_id`, dirty state, line-ending kind, language id, `window_id`,
and workspace identity.

## Safe edit sequence

1. Call `list_editor_workspaces` or `list_open_documents` if the target window
   is not already known.
2. Call `read_live_document` immediately before editing. Retain its
   `document_uri`, `window_id`, `workspace_id`, `document_instance_id`, and
   `version`.
3. Prepare one small logical transaction. Every edit contains
   `start_offset`, `end_offset`, exact `expected_original_text`, and
   `replacement_text`. Send the retained version as `base_version`, a short
   `description`, and an explicit `save_after_apply` (`false` for preview).
4. Use `preview_live_edits` when review is requested. It opens a read-only
   virtual diff and records a pending preview, but does not touch the live
   document. The user may run **BufferWeave: Apply Pending Preview** or
   **BufferWeave: Reject Pending Preview**. The first Apply performs the
   complete version/history/expected-text validation. A non-applied result is
   retained as the settled preview outcome; reject it and create a fresh
   preview rather than expecting a second click to revalidate. Preview admission
   reserves its global slot and memory before opening UI, so simultaneous
   clients cannot overrun the bounded cache.
5. Use `apply_live_edits` for live mode. All replacements are submitted through
   one `TextEditor.edit` transaction with explicit undo stops. One ordinary undo
   was verified in both a real VS Code Extension Development Host and installed
   Cursor.
6. For `apply_live_edits`, treat every non-`applied` status as a refusal to edit
   the buffer. Reread after a stale result or version race. Resolve a conflict
   semantically; never resend a whole-file replacement over the newer buffer.

## Multiple Codex chats and agents

Every Codex chat or subagent may run an independent instance of the STDIO MCP
server. They all discover the same authenticated extension instance
for an editor window, and that single extension is the commit coordinator for
its live documents. No document is locked while an agent is reading or
thinking. Reads are optimistic snapshots; preview preparation, apply plus its
optional guarded save, and standalone saves are placed in a FIFO queue for the
target document. Different documents can proceed concurrently.

If two agents read version 12 and submit disjoint edits, one transaction commits
first and the second is rebased through that exact version transition before it
commits. Each successful transaction is a separate ordinary editor undo step.
If their ranges overlap, exactly one may commit; the later queued transaction
returns a structured conflict and performs no partial write. Coordinator queue
order, not agent identity, selects the winner, so callers must not depend on
which agent wins a race.

For productive parallel work, divide ownership by document or disjoint region,
have every agent reread immediately before its transaction, and keep
`save_after_apply=false` unless saving was requested. After a conflict, choose
one agent to resolve that region semantically from a fresh read. Having several
agents immediately resubmit competing resolutions only creates another safe
conflict cycle; the bridge cannot decide which intent is correct.
Every participating agent must use the live-buffer tools for that document;
ordinary filesystem patches bypass the extension's queue and cannot see
unsaved buffer state.

Normally omit `operation_id`. The MCP-to-extension request id is then a random
UUID and becomes the semantic idempotency key. A caller-supplied
`operation_id` is global within that editor window's bounded cache: it must be
globally unique and may be reused only for the identical request named by an
`outcome_unknown` result. A different payload with the same id is rejected with
`OPERATION_ID_REUSED`; an identical payload is deliberately deduplicated. The
global identity preserves recovery even if the originating MCP process exits.

Editor change events are stored as bounded version transitions. For each
intervening event, all ranges are interpreted in that event's pre-change
coordinate system. Non-overlapping ranges are transformed together. The
boundary policy is deterministic:

- insertion at the start of a nonempty agent range stays before it, so the
  agent range shifts right;
- insertion at the end stays after it, so the agent range does not expand;
- insertion at the exact anchor of an agent insertion conflicts;
- any proper overlap, deletion across a boundary, invalidated expected text,
  missing history, or document-lifetime mismatch refuses the complete
  transaction.

Agent transactions and guarded saves for one document are serialized.
Immediately before the edit, the extension uses the editor's version-aware
`TextEditor.edit`; if the buffer changes before the editor accepts the edit, the
bridge rereads and safely rebases or returns a conflict/version-race result.
Successful edits update the open buffer immediately and do not save unless
requested. The queue never blocks human typing. A save is dispatched only when
its expected version still matches; if typing occurs during the editor's
asynchronous save, treat the response's later `current_version` and `is_dirty`
as authoritative and do not assume that the newer text reached disk.

Change-history `source` values are diagnostic, not provenance guarantees.
The editor identifies Undo/Redo; BufferWeave recognizes its pending transaction,
while `disk` versus `user_or_extension` is inferred from dirty state. The
public API cannot always distinguish typing from another extension.

## Conflict and stale results

A same-region conflict has this shape (fields not relevant to the reason may be
omitted):

```json
{
  "status": "conflict",
  "reason": "intervening_overlap",
  "document_uri": "file:///path/to/workspace/main.tex",
  "path": "/path/to/workspace/main.tex",
  "window_id": "...",
  "workspace_id": "...",
  "document_instance_id": "...",
  "base_version": 12,
  "current_version": 14,
  "edit_index": 0,
  "base_text": "old text",
  "current_text": "user text",
  "proposed_replacement": "agent text",
  "base_range": { "start_offset": 40, "end_offset": 48 },
  "current_range": { "start_offset": 42, "end_offset": 51 },
  "intervening_changes": [],
  "conflicting_changes": []
}
```

`stale_version` means the complete transition sequence from `base_version` is
no longer in memory and includes `earliest_available_version`; reread.
`STALE_DOCUMENT` means the document lifetime changed; reread and use the new
`document_instance_id`. `version_race` means repeated typing prevented a stable
transaction after bounded retries; wait briefly and reread. None of these
statuses performs a partial write.

Apply and save operations are idempotent through bounded request and operation
caches (up to 512 settled entries, normally retained for 30 minutes). If the
MCP returns `outcome_unknown`, first reread the live buffer. If the change is
already present, do not apply it again. If it is absent and a retry is still
appropriate, resend the identical request with the returned `operation_id`;
never convert an uncertain live write into a filesystem overwrite.
An immediate read is not a cancellation barrier: an unusually delayed request
may still be waiting in the extension queue and commit later. Consequently,
absence after that read does not prove failure. Wait and retry only the
identical operation id. Any later live edit enters the same document queue;
regardless of enqueue order, both operations revalidate against the version
they encounter before a write.
`save_outcome_unknown` means a save call threw after dispatch and the disk may
already have changed; inspect a fresh live read's dirty state and, when needed,
the disk contents before deciding whether an identical save retry is safe.

## Build, test, and package

The MCP side has no third-party runtime dependency:

```sh
cd bufferweave
python3 -m unittest discover -s tests -v
```

Build and package the extension locally:

```sh
cd extension
npm ci
npm run build
npm run test:integration
npm run package
```

All integration tests use a disposable workspace. Do not point them at a real
project or manuscript. The Extension Development Host suite starts the actual
Python MCP server, discovers its tool catalog, reads and edits an unsaved live
buffer through MCP, verifies one ordinary undo, and confirms that the same MCP
process rediscovers the extension after its socket restarts. It also runs two
independent MCP processes simultaneously from the same live version: disjoint
edits must both survive, while overlapping edits must yield one commit and one
no-write conflict whose winner is reversed by one ordinary undo. The remaining
editor scenarios exercise the authenticated socket and real VS Code-compatible
document APIs directly. Unit stress cases also cover concurrent preview
admission by count, stored-request bytes, and actual base-plus-proposed diff
content, including allocation-failure cleanup.

Together these tests verify the core live-buffer and concurrency path in a real
VS Code Extension Development Host. That same path, including ordinary Undo,
has also been verified in installed Cursor; the installed-Cursor smoke covers
real two-window routing as well. A hands-on smoke in the normally installed VS
Code app remains a release gate and is not yet claimed as complete.

## Install, authorize, and uninstall

From the repository root, the portable helper builds the VSIX if necessary,
installs it through the selected editor CLI, and registers the `bufferweave` MCP
server with its absolute launcher path:

```sh
./scripts/install-local --editor cursor
# or: ./scripts/install-local --editor code
```

Reload the selected editor, open a trusted workspace, and choose the
least-privileged BufferWeave access command that fits the task: **Enable Read
and Preview**, **Allow Direct Edits**, or **Allow Saving**. Use **Revoke Access**
when finished. Start a new Codex task
after first installation or a tool-catalog change.

Uninstall with:

```sh
./scripts/uninstall-local
```

Reload the editor after uninstalling. The extension removes its own socket and
registry entry on normal shutdown; records proven stale are ignored and can be
removed only after confirming their recorded process is no longer alive.

## Known limitations and recovery

- This is bounded operational transformation for one document, not a CRDT and
  not multi-author presence/cursor sharing. It coordinates commits from several
  chats safely, but semantic task ownership remains outside the bridge.
- Coordination is scoped to one editor window and one document instance. When
  the same file is open in two windows, implicit routing fails as ambiguous;
  explicitly editing both windows creates two independent live buffers and is
  not a cross-window collaborative session.
- Ambiguous multi-window routing is covered with isolated tests and an installed
  Cursor smoke test using two disposable workspace identities. A hands-on smoke
  in the normally installed VS Code app remains a release gate.
- Implicit routing fails closed when a non-stale registry entry is incompatible
  or cannot be safely inspected. Supply an exact healthy `window_id`, or reload
  the affected editor windows, rather than guessing which buffer is unique.
- Preview uses an extension-owned virtual diff and Apply/Reject commands; the
  public extension API does not place edits in a host editor's internal AI
  tracked-edit review UI.
- Only local `file:` documents in trusted, open workspaces are supported.
  Remote extension hosts, untitled documents, notebooks, browser editors, and
  Windows named pipes are outside the current implementation.
- History is in memory and resets on extension restart or document close. A
  stale request must reread rather than guess.
- Request/operation idempotency is deliberately bounded. Recovery from an old
  or evicted operation always begins with a new live read.
- Pending previews are globally bounded per window to eight records, 16 MiB of
  stored request data, and 64 MiB of actual base-plus-proposed virtual-document
  content. Admission evicts the oldest completed preview when necessary; a
  single oversized preview fails without allocating UI state.
- A single request or response is limited to 32 MiB. If a full read returns
  `response_too_large`, request smaller ranges; mutating requests never use
  this as permission to retry by overwriting the file.
- If the status bar reports a disconnected bridge, reload the editor window,
  check `list_editor_workspaces`, and inspect the extension's output channel.
  Logs contain safe method/status/version/timing metadata, not paths, tokens, or
  complete document contents.
- If the live bridge is unavailable, a filesystem patch cannot see unsaved
  buffer changes and will not be one editor undo transaction. Use that fallback
  only after telling the user.
