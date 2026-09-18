# BufferWeave support

BufferWeave is a beta, not an official Cursor, Microsoft, VS Code, or OpenAI
product. It is not affiliated with or endorsed by those organizations. Support
is best-effort; the software is provided as-is under the MIT License.

Use the [GitHub issue tracker](https://github.com/mhebtehaj/bufferweave/issues)
for non-sensitive bugs, compatibility reports, and support requests. Report
vulnerabilities only through
[GitHub private vulnerability reporting](https://github.com/mhebtehaj/bufferweave/security/advisories/new).

Before reporting a problem:

1. Run `./scripts/doctor` if you installed from a source checkout.
2. Confirm that the workspace is trusted and BufferWeave is enabled for it.
3. Run **BufferWeave: Show Connection Status**.
4. Reload the editor window and start a new Codex task if the MCP tool catalog
   changed.

For a source-development report, also run `./scripts/test-all` and include the
failing test name. Include the operating system, editor and version, Python
version, extension version, MCP server version, and failing status/error code.
Do not include bearer tokens, registry records, proprietary source text, or
complete document contents.

## Current support boundary

- The core live-buffer and concurrency path is verified in a real VS Code
  Extension Development Host and installed Cursor.
- macOS with installed Cursor and local workspaces is hands-on tested, including
  real two-window routing.
- macOS with VS Code local workspaces has real Extension Host integration
  coverage. A hands-on smoke in the normally installed VS Code app remains a
  release gate and is not yet claimed as complete.
- The installer supports both `--editor cursor` and `--editor code`.
- Linux local workspaces are expected from the Unix-socket implementation but
  have not yet been validated in an installed editor.
- Windows, remote extension hosts, browser editors, notebooks, untitled buffers,
  and virtual workspaces are unsupported.
