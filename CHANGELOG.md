# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-18

### Changed

- Renamed the project, extension, MCP registration, commands, release bundle,
  and public documentation to BufferWeave.
- Added explicit `--editor cursor|code` installation targets and editor-neutral
  navigation/workspace tool names.
- Documented the verification boundary honestly: the core live-buffer and
  concurrency path is verified in a real VS Code Extension Development Host and
  installed Cursor, while a hands-on installed-VS-Code smoke remains a release
  gate.
- Added the permanent repository, public issue tracker, and GitHub private
  vulnerability-reporting links.

## [0.2.0] - 2026-09-18

### Changed

- Marked the project as a public beta and added a calm, visible disclosure of
  its human-directed, AI-assisted development.
- Added a plain-language disclaimer, installer notice, and informed
  authorization prompts while preserving the standard MIT License.
- Made live-buffer exposure an explicit per-workspace opt-in.
- Split read/preview, direct-edit, and save authority into separate revocable
  machine-local grants with credential rotation.
- Added public-release documentation, portable helper scripts, and CI.
- Removed machine-specific setup notes from the project documentation.

### Added

- Continuous access-mode status and explicit grant/revoke commands.
- Registry schema, extension version, access mode, and capability metadata.
- Wire protocol 2.0, which rejects the earlier default-on extension rather than
  silently weakening the new authorization model.
- Authorization unit tests and end-to-end default-off/rotation/revocation tests.

## [0.1.0] - 2026-09-10

### Added

- Authenticated, owner-only local transport between an MCP server and Cursor.
- Live reads of unsaved `TextDocument` buffers.
- Version-checked, undoable edits with exact expected-text validation.
- Per-document FIFO coordination for multiple Codex tasks and agents.
- Safe rebasing for disjoint stale-base edits and structured no-write conflicts
  for overlapping edits.
- Preview, guarded save, idempotency, multi-window routing, and bounded history.
- Python, JavaScript, extension-host, and disposable Cursor integration tests.
