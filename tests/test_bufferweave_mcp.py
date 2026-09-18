from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import bufferweave_mcp as mcp

from test_bufferweave_client import FakeExtension


class McpServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="bufferweave-mcp-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.env = mock.patch.dict(
            os.environ,
            {"BUFFERWEAVE_REGISTRY_DIR": str(self.root)},
            clear=False,
        )
        self.env.start()
        os.environ.pop(mcp.EDITOR_ENV, None)
        self.servers: list[FakeExtension] = []

    def tearDown(self) -> None:
        for server in self.servers:
            server.stop()
        self.env.stop()
        self.temp.cleanup()

    def add_server(
        self,
        documents: list[dict],
        *,
        instance_id: str = "mcp",
        workspace: Path | None = None,
        editor_name: str = "Cursor",
        editor_version: str = "3.19.19-test",
    ) -> FakeExtension:
        server = FakeExtension(
            self.root,
            instance_id,
            workspace or self.root,
            documents,
            editor_name=editor_name,
            editor_version=editor_version,
        ).start()
        self.servers.append(server)
        return server

    @staticmethod
    def editor(
        key: str,
        *,
        cli_path: str | None = None,
        app_path: Path | None = None,
        reason: str = "selected for test",
    ) -> mcp.EditorInstallation:
        return mcp.EditorInstallation(
            key=key,
            display_name="Cursor" if key == "cursor" else "Visual Studio Code",
            cli_path=cli_path,
            app_path=app_path,
            selection_reason=reason,
        )

    def test_tool_discovery_preserves_navigation_and_adds_live_tools(self) -> None:
        names = {tool["name"] for tool in mcp.TOOLS}
        self.assertTrue({"open_file", "open_workspace", "check_editor"} <= names)
        self.assertTrue(
            {
                "list_editor_workspaces",
                "list_open_documents",
                "read_live_document",
                "preview_live_edits",
                "apply_live_edits",
                "save_live_document",
                "get_document_changes",
            }
            <= names
        )
        self.assertNotIn("check_cursor", names)
        self.assertNotIn("list_cursor_workspaces", names)

    def test_existing_navigation_validation_is_preserved_without_launching_ui(self) -> None:
        uri_result = mcp.call_tool("open_file", {"path": "file:///tmp/example.txt"})
        self.assertTrue(uri_result["isError"])
        self.assertIn("not a URI", uri_result["content"][0]["text"])

        target = self.root / "existing.txt"
        target.write_text("content", encoding="utf-8")
        column_result = mcp.call_tool("open_file", {"path": str(target), "column": 2})
        self.assertTrue(column_result["isError"])
        self.assertIn("column requires line", column_result["content"][0]["text"])

        selected = self.editor("cursor", cli_path="/test/bin/cursor")
        with (
            mock.patch.object(mcp, "_select_editor", return_value=selected),
            mock.patch.object(mcp, "_launch_editor_file") as launch_file,
        ):
            unknown_file = mcp.call_tool(
                "open_file",
                {"path": str(target), "unexpected": True},
            )
        self.assertTrue(unknown_file["isError"])
        self.assertIn("unexpected argument", unknown_file["content"][0]["text"])
        launch_file.assert_not_called()

        with (
            mock.patch.object(mcp, "_select_editor", return_value=selected),
            mock.patch.object(mcp, "_launch_editor_workspace") as launch_workspace,
        ):
            unknown_workspace = mcp.call_tool(
                "open_workspace",
                {"path": str(self.root), "unexpected": True},
            )
        self.assertTrue(unknown_workspace["isError"])
        self.assertIn("unexpected argument", unknown_workspace["content"][0]["text"])
        launch_workspace.assert_not_called()

        unknown_check = mcp.call_tool("check_editor", {"unexpected": True})
        self.assertTrue(unknown_check["isError"])
        self.assertIn("unexpected argument", unknown_check["content"][0]["text"])

    def test_editor_selection_honors_explicit_choice_and_auto_detection(self) -> None:
        cursor = self.editor("cursor", cli_path="/test/bin/cursor")
        code = self.editor("code", cli_path="/test/bin/code")
        installations = {"cursor": cursor, "code": code}

        with mock.patch.object(
            mcp,
            "_find_editor_installation",
            side_effect=installations.get,
        ):
            with mock.patch.dict(os.environ, {mcp.EDITOR_ENV: " CODE "}):
                selected = mcp._select_editor()
            self.assertEqual("code", selected.key)
            self.assertIn("BUFFERWEAVE_EDITOR=code", selected.selection_reason)

            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop(mcp.EDITOR_ENV, None)
                selected = mcp._select_editor()
            self.assertEqual("cursor", selected.key)
            self.assertIn("both supported editors", selected.selection_reason)

        with (
            mock.patch.object(
                mcp,
                "_find_editor_installation",
                side_effect=lambda key: code if key == "code" else None,
            ),
            mock.patch.dict(os.environ, {}, clear=False),
        ):
            os.environ.pop(mcp.EDITOR_ENV, None)
            selected = mcp._select_editor()
        self.assertEqual("code", selected.key)
        self.assertIn("only supported editor", selected.selection_reason)

    def test_editor_selection_rejects_invalid_or_unavailable_explicit_choice(self) -> None:
        with mock.patch.dict(os.environ, {mcp.EDITOR_ENV: "other"}):
            with self.assertRaises(mcp.ToolInputError) as invalid:
                mcp._select_editor()
        self.assertIn("cursor", str(invalid.exception))
        self.assertIn("code", str(invalid.exception))

        with (
            mock.patch.dict(os.environ, {mcp.EDITOR_ENV: "code"}),
            mock.patch.object(mcp, "_find_editor_installation", return_value=None),
        ):
            with self.assertRaises(mcp.ToolInputError) as missing:
                mcp._select_editor()
        self.assertIn("Visual Studio Code", str(missing.exception))
        self.assertIn("was not found", str(missing.exception))

    def test_editor_detection_supports_cli_and_macos_app_bundle(self) -> None:
        with mock.patch.object(mcp.shutil, "which", return_value="/usr/local/bin/code"):
            code = mcp._find_editor_installation("code")
        self.assertIsNotNone(code)
        self.assertEqual("/usr/local/bin/code", code.cli_path)
        self.assertIsNone(code.app_path)

        cursor_app = Path("/Applications/Cursor.app")
        bundled_cli = cursor_app / "Contents/Resources/app/bin/cursor"

        def exists(path: Path) -> bool:
            return path == cursor_app

        def is_file(path: Path) -> bool:
            return path == bundled_cli

        with (
            mock.patch.object(mcp.shutil, "which", return_value=None),
            mock.patch.object(mcp.sys, "platform", "darwin"),
            mock.patch.object(mcp.Path, "exists", autospec=True, side_effect=exists),
            mock.patch.object(mcp.Path, "is_file", autospec=True, side_effect=is_file),
            mock.patch.object(mcp.os, "access", return_value=True),
        ):
            cursor = mcp._find_editor_installation("cursor")
        self.assertIsNotNone(cursor)
        self.assertEqual(cursor_app, cursor.app_path)
        self.assertEqual(str(bundled_cli), cursor.cli_path)

    def test_launch_commands_cover_cli_and_macos_app_fallback(self) -> None:
        target = self.root / "file with space.py"
        target.write_text("print('ok')\n", encoding="utf-8")
        completed = mock.Mock(returncode=0, stderr="", stdout="")
        code = self.editor("code", cli_path="/test/bin/code")
        with mock.patch.object(mcp.subprocess, "run", return_value=completed) as run:
            mcp._launch_editor_file(code, target, 3, 4, True)
        run.assert_called_once_with(
            ["/test/bin/code", "--new-window", "--goto", f"{target}:3:4"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

        app = Path("/Applications/Visual Studio Code.app")
        app_only = self.editor("code", app_path=app)
        with (
            mock.patch.object(mcp.sys, "platform", "darwin"),
            mock.patch.object(mcp.subprocess, "run", return_value=completed) as run,
        ):
            mcp._launch_editor_workspace(app_only, self.root, True)
        run.assert_called_once_with(
            ["/usr/bin/open", "-n", "-a", str(app), str(self.root)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

        selected = self.editor("code", cli_path="/missing/code")
        with (
            mock.patch.object(mcp, "_select_editor", return_value=selected),
            mock.patch.object(
                mcp.subprocess,
                "run",
                side_effect=FileNotFoundError("editor executable disappeared"),
            ),
        ):
            failed = mcp.call_tool("open_workspace", {"path": str(self.root)})
        self.assertTrue(failed["isError"])
        self.assertIn("editor executable disappeared", failed["content"][0]["text"])

    def test_navigation_and_check_report_selected_editor(self) -> None:
        target = self.root / "selected.txt"
        target.write_text("content", encoding="utf-8")
        selected = self.editor(
            "code",
            cli_path="/test/bin/code",
            reason="Selected Visual Studio Code from BUFFERWEAVE_EDITOR=code",
        )
        with (
            mock.patch.object(mcp, "_select_editor", return_value=selected),
            mock.patch.object(mcp, "_launch_editor_file") as launch_file,
        ):
            opened = mcp.call_tool(
                "open_file",
                {"path": str(target), "line": 2, "column": 3, "new_window": True},
            )
            checked = mcp.call_tool("check_editor", {})
        self.assertFalse(opened["isError"])
        self.assertIn("Visual Studio Code", opened["content"][0]["text"])
        self.assertIn("BUFFERWEAVE_EDITOR=code", opened["content"][0]["text"])
        launch_file.assert_called_once_with(selected, target.resolve(), 2, 3, True)
        self.assertFalse(checked["isError"])
        self.assertIn("Visual Studio Code", checked["content"][0]["text"])

    def test_lists_windows_and_open_documents(self) -> None:
        target = self.root / "buffer.tex"
        target.write_text("disk", encoding="utf-8")
        document = {
            "document_uri": target.as_uri(),
            "path": str(target),
            "version": 4,
            "is_dirty": True,
            "window_id": "window-mcp",
        }
        self.add_server([document])

        workspaces = mcp.call_tool("list_editor_workspaces", {})
        workspace_value = workspaces["structuredContent"]
        self.assertEqual("window-mcp", workspace_value["windows"][0]["window_id"])

        documents = mcp.call_tool("list_open_documents", {})
        self.assertEqual(4, documents["structuredContent"]["documents"][0]["version"])

    def test_workspace_listing_uses_authoritative_registry_identity(self) -> None:
        server = self.add_server(
            [],
            editor_name="Visual Studio Code",
            editor_version="1.128.0-test",
        )
        server.workspace_result = {
            "window_id": "spoof-window",
            "instance_id": "spoof-instance",
            "workspace_id": "spoof-workspace",
            "editor_name": "spoof-editor",
            "editor_version": "spoof-version",
            "workspace_folders": [],
        }

        window = mcp.call_tool("list_editor_workspaces", {})["structuredContent"]["windows"][0]
        self.assertEqual(server.window_id, window["window_id"])
        self.assertEqual(server.instance_id, window["instance_id"])
        self.assertEqual(f"workspace-{server.instance_id}", window["workspace_id"])
        self.assertEqual("Visual Studio Code", window["editor_name"])
        self.assertEqual("1.128.0-test", window["editor_version"])

    def test_document_listing_forwards_multi_root_filter(self) -> None:
        target = self.root / "buffer.txt"
        target.write_text("buffer", encoding="utf-8")
        server = self.add_server(
            [{"document_uri": target.as_uri(), "path": str(target), "version": 2}],
        )
        result = mcp.call_tool(
            "list_open_documents",
            {"workspace_path": str(self.root)},
        )
        self.assertFalse(result["isError"])
        request = next(item for item in server.requests if item["method"] == "listOpenDocuments")
        self.assertEqual(str(self.root), request["params"]["workspace_path"])
        self.assertEqual(server.window_id, request["params"]["window_id"])

    def test_read_and_apply_are_routed_with_canonical_selector(self) -> None:
        target = self.root / "buffer.tex"
        target.write_text("disk", encoding="utf-8")
        document = {
            "document_uri": target.as_uri(),
            "path": str(target),
            "document_instance_id": "doc-instance-8",
            "version": 8,
            "is_dirty": True,
            "window_id": "window-mcp",
        }
        server = self.add_server([document])
        server.results["readDocument"] = {
            **document,
            "text": "unsaved buffer",
            "range": {"start_offset": 0, "end_offset": 14},
        }
        server.results["applyEdits"] = {
            "status": "applied",
            "base_version": 8,
            "current_version": 9,
            "saved": False,
        }

        read = mcp.call_tool("read_live_document", {"path": str(target)})
        self.assertEqual("unsaved buffer", read["structuredContent"]["text"])
        read_request = next(item for item in server.requests if item["method"] == "readDocument")
        self.assertEqual(target.resolve().as_uri(), read_request["params"]["document_uri"])
        self.assertNotIn("path", read_request["params"])

        applied = mcp.call_tool(
            "apply_live_edits",
            {
                "path": str(target),
                "document_instance_id": "doc-instance-8",
                "operation_id": "retry-operation-8",
                "base_version": 8,
                "edits": [
                    {
                        "start_offset": 0,
                        "end_offset": 7,
                        "expected_original_text": "unsaved",
                        "replacement_text": "live",
                    }
                ],
                "description": "Replace one word",
                "save_after_apply": False,
            },
        )
        self.assertEqual("applied", applied["structuredContent"]["status"])
        apply_request = next(item for item in server.requests if item["method"] == "applyEdits")
        self.assertEqual(8, apply_request["params"]["base_version"])
        self.assertEqual("retry-operation-8", apply_request["params"]["operation_id"])
        self.assertEqual("Replace one word", apply_request["params"]["description"])

    def test_conflict_result_is_not_converted_to_transport_error(self) -> None:
        target = self.root / "buffer.tex"
        target.write_text("disk", encoding="utf-8")
        document = {
            "document_uri": target.as_uri(),
            "path": str(target),
            "document_instance_id": "doc-instance-9",
            "version": 9,
        }
        server = self.add_server([document])
        server.results["applyEdits"] = {
            "status": "conflict",
            "conflicts": [
                {
                    "base_text": "old",
                    "current_text": "user",
                    "proposed_replacement": "agent",
                }
            ],
        }
        result = mcp.call_tool(
            "apply_live_edits",
            {
                "path": str(target),
                "document_instance_id": "doc-instance-9",
                "base_version": 8,
                "edits": [
                    {
                        "start_offset": 0,
                        "end_offset": 3,
                        "expected_original_text": "old",
                        "replacement_text": "agent",
                    }
                ],
                "description": "Conflicting edit",
                "save_after_apply": False,
            },
        )
        self.assertFalse(result["isError"])
        self.assertEqual("conflict", result["structuredContent"]["status"])

    def test_preview_requires_and_forwards_explicit_false_save_choice(self) -> None:
        target = self.root / "preview.tex"
        target.write_text("base", encoding="utf-8")
        document = {
            "document_uri": target.as_uri(),
            "path": str(target),
            "document_instance_id": "preview-document",
            "version": 1,
        }
        server = self.add_server([document])
        server.results["previewEdits"] = {"status": "preview", "preview_id": "preview-1"}
        common = {
            "path": str(target),
            "document_instance_id": "preview-document",
            "base_version": 1,
            "edits": [
                {
                    "start_offset": 0,
                    "end_offset": 4,
                    "expected_original_text": "base",
                    "replacement_text": "next",
                }
            ],
            "description": "Preview replacement",
        }

        missing = mcp.call_tool("preview_live_edits", common)
        self.assertTrue(missing["isError"])
        self.assertIn("save_after_apply is required", missing["content"][0]["text"])

        saving = mcp.call_tool(
            "preview_live_edits",
            {**common, "save_after_apply": True},
        )
        self.assertTrue(saving["isError"])
        self.assertIn("requires save_after_apply=false", saving["content"][0]["text"])

        preview = mcp.call_tool(
            "preview_live_edits",
            {**common, "save_after_apply": False},
        )
        self.assertFalse(preview["isError"])
        request = next(item for item in server.requests if item["method"] == "previewEdits")
        self.assertIs(request["params"]["save_after_apply"], False)

        schema = next(
            tool["inputSchema"] for tool in mcp.TOOLS if tool["name"] == "preview_live_edits"
        )
        self.assertIn("save_after_apply", schema["required"])
        self.assertIs(schema["properties"]["save_after_apply"]["const"], False)

    def test_missing_extension_is_a_structured_error(self) -> None:
        result = mcp.call_tool("list_editor_workspaces", {})
        self.assertFalse(result["isError"])
        self.assertEqual([], result["structuredContent"]["windows"])

    def test_live_tool_runtime_validation_matches_schema(self) -> None:
        unknown = mcp.call_tool("list_editor_workspaces", {"unexpected": True})
        self.assertTrue(unknown["isError"])
        self.assertIn("unexpected argument", unknown["content"][0]["text"])

        incomplete = mcp.call_tool(
            "apply_live_edits",
            {
                "path": "/tmp/not-open.txt",
                "base_version": 1,
                "description": "Missing identity",
                "edits": [
                    {
                        "start_offset": 0,
                        "end_offset": 0,
                        "expected_original_text": "",
                        "replacement_text": "x",
                    }
                ],
            },
        )
        self.assertTrue(incomplete["isError"])
        self.assertIn("document_instance_id is required", incomplete["content"][0]["text"])

        missing_save_choice = mcp.call_tool(
            "apply_live_edits",
            {
                "path": "/tmp/not-open.txt",
                "document_instance_id": "document-id",
                "base_version": 1,
                "description": "Missing explicit save choice",
                "edits": [
                    {
                        "start_offset": 0,
                        "end_offset": 0,
                        "expected_original_text": "",
                        "replacement_text": "x",
                    }
                ],
            },
        )
        self.assertTrue(missing_save_choice["isError"])
        self.assertIn("save_after_apply is required", missing_save_choice["content"][0]["text"])

        for invalid_uri in ("relative.txt", "file:relative.txt"):
            invalid_selector = mcp.call_tool(
                "read_live_document",
                {"document_uri": invalid_uri},
            )
            self.assertTrue(invalid_selector["isError"])
            self.assertIn(
                "document_uri must be an absolute local file URI",
                invalid_selector["content"][0]["text"],
            )

        tilde_path = mcp.call_tool("read_live_document", {"path": "~/relative.txt"})
        self.assertTrue(tilde_path["isError"])
        self.assertIn("path must be absolute", tilde_path["content"][0]["text"])

        tilde_workspace = mcp.call_tool(
            "list_open_documents",
            {"workspace_path": "~/relative-workspace"},
        )
        self.assertTrue(tilde_workspace["isError"])
        self.assertIn("workspace_path must be absolute", tilde_workspace["content"][0]["text"])

        unsafe_integer = mcp.call_tool(
            "get_document_changes",
            {
                "path": "/tmp/not-open.txt",
                "document_instance_id": "document-id",
                "base_version": mcp.MAX_SAFE_INTEGER + 1,
            },
        )
        self.assertTrue(unsafe_integer["isError"])
        self.assertIn("through", unsafe_integer["content"][0]["text"])

    def test_listing_keeps_healthy_window_when_another_window_errors(self) -> None:
        healthy = self.add_server([], instance_id="healthy")
        unhealthy = self.add_server([], instance_id="unhealthy")
        unhealthy.errors["listWorkspaces"] = {
            "code": "TEMPORARILY_UNAVAILABLE",
            "message": "restarting",
        }

        result = mcp.call_tool("list_editor_workspaces", {})["structuredContent"]
        self.assertEqual([healthy.window_id], [window["window_id"] for window in result["windows"]])
        self.assertEqual(unhealthy.window_id, result["unreachable_instances"][0]["window_id"])

    def test_json_rpc_initialization_uses_current_server_version(self) -> None:
        result = mcp.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": mcp.PROTOCOL_VERSION},
            }
        )
        self.assertEqual("bufferweave", result["result"]["serverInfo"]["name"])
        self.assertEqual("0.3.0", result["result"]["serverInfo"]["version"])
        self.assertEqual(mcp.PROTOCOL_VERSION, result["result"]["protocolVersion"])
        unsupported = mcp.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "initialize",
                "params": {"protocolVersion": "2099-01-01"},
            }
        )
        self.assertEqual(mcp.PROTOCOL_VERSION, unsupported["result"]["protocolVersion"])
        listed = mcp.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        json.dumps(listed)

    def test_json_rpc_rejects_non_object_params_and_tool_arguments(self) -> None:
        for value in ([], "", 0, False, None):
            invalid_params = mcp.handle_request(
                {"jsonrpc": "2.0", "id": 10, "method": "ping", "params": value}
            )
            self.assertEqual(-32602, invalid_params["error"]["code"])

            invalid_arguments = mcp.handle_request(
                {
                    "jsonrpc": "2.0",
                    "id": 11,
                    "method": "tools/call",
                    "params": {"name": "check_editor", "arguments": value},
                }
            )
            self.assertTrue(invalid_arguments["result"]["isError"])
            self.assertIn(
                "tool arguments must be an object",
                invalid_arguments["result"]["content"][0]["text"],
            )

            invalid_notification = mcp.handle_request(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                    "params": value,
                }
            )
            self.assertIsNone(invalid_notification)

        explicit_null_id = mcp.handle_request(
            {"jsonrpc": "2.0", "id": None, "method": "ping", "params": False}
        )
        self.assertEqual(-32602, explicit_null_id["error"]["code"])
        self.assertIsNone(explicit_null_id["id"])

        with mock.patch.object(mcp, "_editor_availability", return_value=(True, "available")):
            omitted_arguments = mcp.handle_request(
                {
                    "jsonrpc": "2.0",
                    "id": 12,
                    "method": "tools/call",
                    "params": {"name": "check_editor"},
                }
            )
        self.assertFalse(omitted_arguments["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
