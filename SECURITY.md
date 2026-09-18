# BufferWeave security policy

## Supported versions

This project is currently a beta. Security fixes are applied to
the latest release only.

## Reporting a vulnerability

Do not publish an exploit or sensitive document content in a public issue.
Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/mhebtehaj/bufferweave/security/advisories/new).
Use the public [issue tracker](https://github.com/mhebtehaj/bufferweave/issues)
only for non-sensitive bugs and support requests.

## Security boundary

The bridge is local-only. It opens no TCP port and executes no client-supplied
shell command. Each Cursor or VS Code window publishes a random bearer token and
a Unix-domain socket inside an owner-only registry directory. Registry records
and sockets are owner-only, and the MCP client rejects unsafe ownership, modes,
symlinks, stale processes, incompatible protocol versions, and ambiguous
routing.

BufferWeave exposes only already-open local files inside a trusted workspace for
which the user explicitly granted access. A machine-local grant separates
read/preview, direct-edit, and save authority. Changing between enabled modes
restarts the endpoint with a fresh credential; revoking access stops it and
removes the active endpoint. Edits require a
current document lifetime ID, a base version, exact expected text, and an
explicit save choice. Overlap or uncertainty fails without a partial write.

Save authority is intentionally separate because saving persists the entire
current buffer, including unrelated unsaved human changes that were already
present. Read and edit grants do not allow standalone saves or
`save_after_apply=true`.

This design protects against other operating-system users and accidental local
clients. It does **not** protect against malicious software already running as
the same user: such a process can read the owner-only registry record and token,
and it may already have comparable access to the user's files and editor data.
The bridge is not suitable for a hostile shared-account environment.

The MCP client that invokes a read receives the selected document text. Users
are responsible for the privacy and data-handling terms of that MCP client and
any model or service to which it sends tool results.

## Release expectations

Official artifacts should be produced by CI from a tagged commit and published
with SHA-256 checksums. Never distribute `node_modules`, test editor downloads,
tokens, registry records, user settings, or real workspace fixtures.
