# BufferWeave publishing checklist

BufferWeave is prepared as an independent GitHub beta at
[github.com/mhebtehaj/bufferweave](https://github.com/mhebtehaj/bufferweave), but
publication is intentionally not automatic.

Before a public release, confirm that the extension manifest names the permanent
publisher and repository, the extension identifier is consistent in tests and
uninstall behavior, packaging does not allow missing repository metadata, and
the complete test suite passes.

## Beta release gate

- [ ] All source and documentation contain no personal paths, tokens, or real
      document content.
- [ ] `./scripts/test-all --integration` passes from a clean checkout.
- [ ] The packaged artifact is `extension/bufferweave.vsix` and contains only
      intended runtime and documentation files.
- [ ] The repository README, embedded extension README, package preview flag,
      installer notice, and draft release notes consistently identify
      BufferWeave as a human-directed, AI-assisted beta.
- [ ] A human maintainer has reviewed the release diff, complete test results,
      packaged-file list, and draft release notes.
- [ ] The core path—tool discovery, unsaved reads, version-checked edits, Undo,
      concurrent disjoint merges, and overlap refusal—passes in the real VS Code
      Extension Development Host and installed Cursor.
- [ ] Installed Cursor smoke passes for two-window ambiguity, access grants, and
      revocation.
- [ ] A hands-on smoke in the normally installed VS Code app passes before the
      release claims installed-VS-Code verification. Until then, describe VS
      Code support as Extension Host verified with installed-app smoke pending.
- [ ] Both `./scripts/install-local --editor cursor` and `--editor code` are
      exercised with a release bundle, and the `bufferweave` MCP registration is
      verified.
- [ ] The tag, changelog version, MCP server version, extension version, bundle
      name, and `bufferweave.vsix` are reviewed as one coordinated release.
- [ ] SHA-256 checksums are published beside release artifacts.
- [ ] GitHub private vulnerability reporting is enabled and the link in
      [SECURITY.md](SECURITY.md) works.
- [ ] At least two external beta testers have exercised installation and
      recovery instructions before marketplace submission.
