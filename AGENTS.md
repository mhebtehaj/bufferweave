# BufferWeave live-edit guidance

When the user asks to collaborate on a file open in Cursor or VS Code, prefer the
`bufferweave` live-buffer tools over filesystem edits. Read the live document
immediately before every logical change and retain its `window_id`,
`document_instance_id`, and `version`. Send a small transaction with exact
UTF-16 ranges and `expected_original_text`; preview first when the user requests
review. Let the bridge rebase only across recorded non-overlapping changes. If
it returns `conflict`, `STALE_DOCUMENT`, `stale_version`, or `version_race`, do
not overwrite or guess: reread and resolve semantically. Use an ordinary
filesystem patch only when the live bridge is unavailable, and tell the user
that the edit will not include unsaved editor-buffer changes or share one editor
undo transaction.

Several Codex chats or agents may use the bridge at once. Do not reserve a
document while thinking: divide parallel work into different documents or
disjoint ranges, and have every agent perform its own fresh live read just
before applying a small transaction. The bridge serializes apply and save work
per document; a later disjoint transaction rebases through the earlier one,
while an overlapping loser receives a conflict without a partial write.
Normally omit `operation_id`; the bridge creates a globally unique one. Supply
one only when retrying the exact request identified by `outcome_unknown`. After
an overlap, designate one agent to resolve that region from a fresh read rather
than letting several agents repeatedly race on it. Leave `save_after_apply`
false unless the user asked to save; a designated saver must also use a freshly
read exact version. A read after `outcome_unknown` is not a cancellation
barrier—a delayed queued operation may still commit—so never infer from one
absent read that it is safe to issue a different overwrite.
