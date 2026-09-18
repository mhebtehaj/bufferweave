# BufferWeave public demo plan

Use only a disposable workspace containing a synthetic `demo.md`. Hide absolute
user paths, registry records, tokens, and unrelated sidebar content.

## 60–90 second recording

1. Open `demo.md` with three labeled sections and show that the file begins
   clean.
2. Type an unsaved sentence in section A.
3. Ask Codex task A to use `bufferweave` to read that live sentence and edit
   section B with `save_after_apply=false`. Show that the user's sentence
   survives, the agent text appears immediately, and the dirty indicator
   remains.
4. Have two Codex tasks read the same version and simultaneously edit separate
   sections B and C. Show that both changes survive.
5. Reset one synthetic token. Have both tasks edit exactly that token from the
   same base. Show one successful transaction and one structured conflict with
   no partial second write.
6. Press Undo once and show that only the winning agent transaction disappears.
7. Restore the intended text and press Save. Show that the complete visible
   buffer—including user and accepted agent work—is persisted.
8. End on the BufferWeave access-grant status item and the sentence: "Local,
   opt-in, version-checked, and conflict-safe."
