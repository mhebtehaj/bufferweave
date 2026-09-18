from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest import mock

import bufferweave_client as live


class FakeExtension:
    def __init__(
        self,
        root: Path,
        instance_id: str,
        workspace: Path,
        documents: list[dict] | None = None,
        *,
        editor_name: str = "Cursor",
        editor_version: str = "3.19.19-test",
    ) -> None:
        self.root = root
        self.instance_id = instance_id
        self.window_id = f"window-{instance_id}"
        self.workspace = workspace.resolve()
        self.editor_name = editor_name
        self.editor_version = editor_version
        self.socket_path = root / f"{instance_id}.sock"
        self.token = (instance_id + "-secret-") * 4
        workspace_descriptor = {
            "name": self.workspace.name,
            "path": str(self.workspace),
            "uri": self.workspace.as_uri(),
            "index": 0,
        }
        self.documents = [
            {
                "document_instance_id": f"{instance_id}-document-{index}",
                "version": 1,
                "is_dirty": False,
                "language_id": "plaintext",
                "eol": "\n",
                "workspace": workspace_descriptor,
                **document,
            }
            for index, document in enumerate(documents or [])
        ]
        self.requests: list[dict] = []
        self.results: dict[str, object] = {}
        self.workspace_result: dict | None = None
        self.errors: dict[str, dict] = {}
        self.drop_first_response_methods: set[str] = set()
        self.drop_all_response_methods: set[str] = set()
        self._dropped_ids: set[str] = set()
        self._response_cache: dict[str, dict] = {}
        self._stopped = threading.Event()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def start(self) -> "FakeExtension":
        self._thread.start()
        if not self._ready.wait(2):
            raise RuntimeError("fake extension did not start")
        record = {
            "protocol_version": live.WIRE_PROTOCOL_VERSION,
            "registry_schema_version": 1,
            "extension_version": "0.1.0-test",
            "access_mode": "edit",
            "capabilities": ["read", "preview", "edit", "save", "rebase", "conflict"],
            "instance_id": self.instance_id,
            "window_id": self.window_id,
            "pid": os.getpid(),
            "socket_path": str(self.socket_path),
            "token": self.token,
            "workspace_id": f"workspace-{self.instance_id}",
            "workspace_folders": [
                {
                    "name": self.workspace.name,
                    "path": str(self.workspace),
                    "uri": self.workspace.as_uri(),
                }
            ],
            "workspace_file": None,
            "editor_name": self.editor_name,
            "editor_version": self.editor_version,
            "created_at": "2026-09-10T00:00:00.000Z",
            "updated_at": "2026-09-10T00:00:00.000Z",
        }
        registry_path = self.root / f"{self.instance_id}.json"
        registry_path.write_text(json.dumps(record), encoding="utf-8")
        registry_path.chmod(0o600)
        return self

    def stop(self) -> None:
        self._stopped.set()
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as wake:
                wake.connect(str(self.socket_path))
                wake.sendall(b"{}\n")
        except OSError:
            pass
        self._thread.join(timeout=2)

    def _serve(self) -> None:
        if self.socket_path.exists():
            self.socket_path.unlink()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(self.socket_path))
            self.socket_path.chmod(0o600)
            server.listen()
            server.settimeout(0.2)
            self._ready.set()
            while not self._stopped.is_set():
                try:
                    connection, _ = server.accept()
                except socket.timeout:
                    continue
                with connection:
                    raw = b""
                    while b"\n" not in raw:
                        chunk = connection.recv(65536)
                        if not chunk:
                            break
                        raw += chunk
                    try:
                        request = json.loads(raw.split(b"\n", 1)[0])
                    except Exception:
                        continue
                    if request.get("token") != self.token:
                        response = {
                            "id": request.get("id"),
                            "ok": False,
                            "error": {"code": "unauthorized", "message": "bad token"},
                        }
                    else:
                        self.requests.append(request)
                        method = request.get("method")
                        request_id = request.get("id")
                        if request_id in self._response_cache:
                            response = self._response_cache[request_id]
                        elif method in self.errors:
                            response = {
                                "id": request_id,
                                "ok": False,
                                "error": self.errors[method],
                            }
                        else:
                            if method == "listOpenDocuments":
                                result = {"documents": self.documents}
                            elif method == "listWorkspaces":
                                result = self.workspace_result or {
                                    "window_id": self.window_id,
                                    "workspace_id": f"workspace-{self.instance_id}",
                                    "editor_name": self.editor_name,
                                    "editor_version": self.editor_version,
                                    "workspace_folders": [
                                        {
                                            "name": self.workspace.name,
                                            "path": str(self.workspace),
                                            "uri": self.workspace.as_uri(),
                                        }
                                    ],
                                }
                            else:
                                result = self.results.get(method, {"method": method})
                            response = {"id": request_id, "ok": True, "result": result}
                        self._response_cache[request_id] = response
                        if (
                            method in self.drop_first_response_methods
                            and request_id not in self._dropped_ids
                        ):
                            self._dropped_ids.add(request_id)
                            continue
                        if method in self.drop_all_response_methods:
                            continue
                    try:
                        connection.sendall(json.dumps(response).encode("utf-8") + b"\n")
                    except BrokenPipeError:
                        pass
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass


class LiveBridgeClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="bufferweave-client-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.env = mock.patch.dict(os.environ, {live.REGISTRY_ENV: str(self.root)})
        self.env.start()
        self.servers: list[FakeExtension] = []

    def tearDown(self) -> None:
        for server in self.servers:
            server.stop()
        self.env.stop()
        self.temp.cleanup()

    def add_server(
        self,
        instance_id: str,
        workspace: Path,
        documents: list[dict] | None = None,
    ) -> FakeExtension:
        server = FakeExtension(self.root, instance_id, workspace, documents).start()
        self.servers.append(server)
        return server

    def test_registry_directory_uses_bufferweave_name_and_override(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(live.REGISTRY_ENV, None)
            expected_suffix = str(os.getuid()) if hasattr(os, "getuid") else os.environ.get("USERNAME", "user")
            self.assertEqual(Path(f"/tmp/bufferweave-{expected_suffix}"), live.registry_directory())

        override = self.root / "explicit-registry"
        with mock.patch.dict(os.environ, {live.REGISTRY_ENV: str(override)}):
            self.assertEqual(override, live.registry_directory())

        self.assertEqual("BUFFERWEAVE_REGISTRY_DIR", live.REGISTRY_ENV)
        self.assertEqual("3.0", live.WIRE_PROTOCOL_VERSION)

    def test_discovers_private_live_instance_and_authenticates(self) -> None:
        server = self.add_server("one", self.root)
        instances, ignored = live.discover_instances()
        self.assertEqual([], ignored)
        self.assertEqual([server.window_id], [item.window_id for item in instances])
        self.assertEqual("0.1.0-test", instances[0].extension_version)
        self.assertEqual("edit", instances[0].access_mode)
        self.assertIn("conflict", instances[0].capabilities)
        self.assertEqual("Cursor", instances[0].editor_name)
        self.assertEqual("3.19.19-test", instances[0].editor_version)

        result = live.rpc(instances[0], "listWorkspaces", {})
        self.assertEqual(server.window_id, result["window_id"])
        self.assertNotIn(server.token, json.dumps(result))
        self.assertEqual(server.token, server.requests[0]["token"])

    def test_routes_one_open_document_by_path(self) -> None:
        target = self.root / "scratch.tex"
        target.write_text("\\alpha α\n", encoding="utf-8")
        document = {
            "document_uri": target.resolve().as_uri(),
            "path": str(target.resolve()),
            "version": 7,
            "is_dirty": True,
            "window_id": "window-one",
        }
        server = self.add_server("one", self.root, [document])

        instance, found = live.route_document(str(target))
        self.assertEqual(server.window_id, instance.window_id)
        self.assertEqual(7, found["version"])

    def test_empty_existing_registry_is_bridge_unavailable_for_routing(self) -> None:
        target = self.root / "not-connected.txt"
        target.write_text("disk only", encoding="utf-8")

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.route_document(str(target))
        self.assertEqual("bridge_unavailable", raised.exception.code)

    def test_document_listing_gets_authoritative_window_identity(self) -> None:
        target = self.root / "scratch.txt"
        target.write_text("buffer", encoding="utf-8")
        # This matches the real extension shape: identity is on the response
        # envelope, not repeated on every document descriptor.
        server = self.add_server(
            "one",
            self.root,
            [{"document_uri": target.as_uri(), "path": str(target), "version": 2}],
        )
        instances, _ = live.discover_instances()
        documents = live.list_open_documents(instances[0])
        self.assertEqual(server.window_id, documents[0]["window_id"])
        self.assertEqual("workspace-one", documents[0]["workspace_id"])
        self.assertEqual("Cursor", documents[0]["editor_name"])
        self.assertEqual("3.19.19-test", documents[0]["editor_version"])

    def test_special_character_file_uri_round_trips(self) -> None:
        target = self.root / "space # question ? percent % α.tex"
        target.write_text("α", encoding="utf-8")
        document = {
            "document_uri": target.as_uri(),
            "path": str(target),
            "version": 2,
        }
        server = self.add_server("one", self.root, [document])

        selected, found = live.route_document(target.as_uri())
        self.assertEqual(server.window_id, selected.window_id)
        self.assertEqual(target.resolve().as_uri(), found["document_uri"])

    def test_rejects_mismatched_document_uri_and_path_descriptor(self) -> None:
        target = self.root / "target.txt"
        other = self.root / "other.txt"
        target.write_text("target", encoding="utf-8")
        other.write_text("other", encoding="utf-8")
        server = self.add_server(
            "one",
            self.root,
            [{"document_uri": other.as_uri(), "path": str(target)}],
        )
        instances, _ = live.discover_instances()

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.list_open_documents(instances[0])
        self.assertEqual("invalid_bridge_response", raised.exception.code)
        self.assertNotIn(str(target), raised.exception.message)
        self.assertEqual(server.window_id, instances[0].window_id)

    def test_rejects_ambiguous_document_without_window(self) -> None:
        target = self.root / "same.txt"
        target.write_text("same", encoding="utf-8")
        document = {"document_uri": target.as_uri(), "path": str(target)}
        first = self.add_server("one", self.root, [document])
        second = self.add_server("two", self.root, [document])

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.route_document(str(target))
        self.assertEqual("ambiguous_document", raised.exception.code)
        self.assertEqual(
            {first.window_id, second.window_id},
            {item["window_id"] for item in raised.exception.data["matches"]},
        )

        selected, _ = live.route_document(str(target), window_id=second.window_id)
        self.assertEqual(second.window_id, selected.window_id)

    def test_workspace_path_disambiguates_before_document_probe(self) -> None:
        target = self.root / "same.txt"
        target.write_text("same", encoding="utf-8")
        other_workspace = self.root / "other"
        other_workspace.mkdir()
        document = {"document_uri": target.as_uri(), "path": str(target)}
        first = self.add_server("one", self.root, [document])
        self.add_server("two", other_workspace, [document])

        selected, _ = live.route_document(str(target), workspace_path=str(self.root))
        self.assertEqual(first.window_id, selected.window_id)

    def test_unreachable_candidate_blocks_implicit_but_not_explicit_routing(self) -> None:
        target = self.root / "same.txt"
        target.write_text("same", encoding="utf-8")
        document = {"document_uri": target.as_uri(), "path": str(target)}
        healthy = self.add_server("one", self.root, [document])
        unhealthy = self.add_server("two", self.root, [])
        unhealthy.errors["listOpenDocuments"] = {
            "code": "TEMPORARILY_UNAVAILABLE",
            "message": "restarting",
        }

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.route_document(str(target))
        self.assertEqual("routing_incomplete", raised.exception.code)

        selected, _ = live.route_document(str(target), window_id=healthy.window_id)
        self.assertEqual(healthy.window_id, selected.window_id)

    def test_uninspectable_entry_blocks_implicit_but_not_explicit_routing(self) -> None:
        target = self.root / "same.txt"
        target.write_text("same", encoding="utf-8")
        document = {"document_uri": target.as_uri(), "path": str(target)}
        healthy = self.add_server("one", self.root, [document])
        incompatible = self.add_server("two", self.root, [document])
        registry_path = self.root / f"{incompatible.instance_id}.json"
        record = json.loads(registry_path.read_text(encoding="utf-8"))
        record["protocol_version"] = "1.0"
        registry_path.write_text(json.dumps(record), encoding="utf-8")
        registry_path.chmod(0o600)

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.route_document(str(target))
        self.assertEqual("routing_incomplete", raised.exception.code)
        self.assertEqual(
            "incompatible_extension",
            raised.exception.data["ignored_instances"][0]["code"],
        )

        selected, _ = live.route_document(str(target), window_id=healthy.window_id)
        self.assertEqual(healthy.window_id, selected.window_id)

    def test_rejects_current_protocol_record_without_authorization_metadata(self) -> None:
        incompatible = self.add_server("legacy-shape", self.root)
        registry_path = self.root / f"{incompatible.instance_id}.json"
        record = json.loads(registry_path.read_text(encoding="utf-8"))
        for field in ("registry_schema_version", "extension_version", "access_mode", "capabilities"):
            record.pop(field)
        registry_path.write_text(json.dumps(record), encoding="utf-8")
        registry_path.chmod(0o600)

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.discover_instances()
        self.assertEqual("bridge_unavailable", raised.exception.code)
        self.assertEqual(
            "incompatible_extension",
            raised.exception.data["ignored_instances"][0]["code"],
        )

    def test_rejects_registry_record_without_editor_identity(self) -> None:
        incompatible = self.add_server("missing-editor", self.root)
        registry_path = self.root / f"{incompatible.instance_id}.json"
        record = json.loads(registry_path.read_text(encoding="utf-8"))
        record.pop("editor_name")
        record.pop("editor_version")
        registry_path.write_text(json.dumps(record), encoding="utf-8")
        registry_path.chmod(0o600)

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.discover_instances()
        self.assertEqual("bridge_unavailable", raised.exception.code)
        self.assertEqual(
            "invalid_registry_entry",
            raised.exception.data["ignored_instances"][0]["code"],
        )

        record["editor_name"] = "   "
        record["editor_version"] = "3.19.19-test"
        registry_path.write_text(json.dumps(record), encoding="utf-8")
        registry_path.chmod(0o600)
        with self.assertRaises(live.LiveBridgeError) as whitespace:
            live.discover_instances()
        self.assertEqual(
            "invalid_registry_entry",
            whitespace.exception.data["ignored_instances"][0]["code"],
        )

    def test_provably_stale_ignored_entry_does_not_block_implicit_routing(self) -> None:
        target = self.root / "only-live.txt"
        target.write_text("live", encoding="utf-8")
        document = {"document_uri": target.as_uri(), "path": str(target)}
        healthy = self.add_server("one", self.root, [document])
        stale_path = self.root / "stale.json"
        stale_path.write_text(
            json.dumps(
                {
                    "protocol_version": live.WIRE_PROTOCOL_VERSION,
                    "instance_id": "stale",
                    "window_id": "window-stale",
                    "pid": 0,
                    "socket_path": str(self.root / "stale.sock"),
                    "token": "stale-secret-token" * 4,
                }
            ),
            encoding="utf-8",
        )
        stale_path.chmod(0o600)

        selected, _ = live.route_document(str(target))
        self.assertEqual(healthy.window_id, selected.window_id)

    def test_rejects_group_readable_registry_directory(self) -> None:
        self.root.chmod(0o750)
        with self.assertRaises(live.LiveBridgeError) as raised:
            live.discover_instances()
        self.assertEqual("unsafe_registry", raised.exception.code)

    def test_rejects_symlinked_registry_directory(self) -> None:
        target = self.root / "private-target"
        target.mkdir(mode=0o700)
        link = self.root / "registry-link"
        link.symlink_to(target, target_is_directory=True)
        with mock.patch.dict(os.environ, {live.REGISTRY_ENV: str(link)}):
            with self.assertRaises(live.LiveBridgeError) as raised:
                live.discover_instances()
        self.assertEqual("unsafe_registry", raised.exception.code)

    def test_reports_stale_or_incompatible_entries_without_leaking_token(self) -> None:
        stale = self.root / "stale.json"
        token = "do-not-leak-" * 4
        stale.write_text(
            json.dumps(
                {
                    "protocol_version": "old",
                    "instance_id": "stale",
                    "window_id": "stale",
                    "pid": os.getpid(),
                    "socket_path": str(self.root / "stale.sock"),
                    "token": token,
                }
            ),
            encoding="utf-8",
        )
        stale.chmod(0o600)
        with self.assertRaises(live.LiveBridgeError) as raised:
            live.discover_instances()
        self.assertEqual("bridge_unavailable", raised.exception.code)
        self.assertNotIn(token, json.dumps(raised.exception.as_dict()))

    def test_extension_structured_error_is_preserved(self) -> None:
        server = self.add_server("one", self.root)
        instances, _ = live.discover_instances()

        original_results = server.results
        # Override the simple fake for this request by temporarily using a bad
        # token on a copy of the immutable instance metadata.
        bad = live.LiveInstance(
            **{**instances[0].__dict__, "token": "x" * 32},
        )
        with self.assertRaises(live.LiveBridgeError) as raised:
            live.rpc(bad, "readDocument", {})
        self.assertEqual("unauthorized", raised.exception.code)
        self.assertIs(server.results, original_results)

    def test_lost_write_response_retries_same_id(self) -> None:
        server = self.add_server("one", self.root)
        server.results["applyEdits"] = {"status": "applied", "current_version": 3}
        server.drop_first_response_methods.add("applyEdits")
        instances, _ = live.discover_instances()

        result = live.rpc(instances[0], "applyEdits", {"document_instance_id": "doc"})
        self.assertEqual("applied", result["status"])
        requests = [item for item in server.requests if item["method"] == "applyEdits"]
        self.assertEqual(2, len(requests))
        self.assertEqual(requests[0]["id"], requests[1]["id"])

    def test_repeated_lost_write_response_reports_unknown_outcome(self) -> None:
        server = self.add_server("one", self.root)
        server.results["saveDocument"] = {"status": "saved", "current_version": 3}
        server.drop_all_response_methods.add("saveDocument")
        instances, _ = live.discover_instances()

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.rpc(instances[0], "saveDocument", {"document_instance_id": "doc"})
        self.assertEqual("outcome_unknown", raised.exception.code)
        request_ids = [
            item["id"] for item in server.requests if item["method"] == "saveDocument"
        ]
        self.assertEqual(2, len(request_ids))
        self.assertEqual(request_ids[0], request_ids[1])
        self.assertEqual(request_ids[0], raised.exception.data["request_id"])
        self.assertEqual(request_ids[0], raised.exception.data["operation_id"])

    def test_unknown_outcome_preserves_caller_operation_id(self) -> None:
        server = self.add_server("one", self.root)
        server.drop_all_response_methods.add("applyEdits")
        instances, _ = live.discover_instances()

        with self.assertRaises(live.LiveBridgeError) as raised:
            live.rpc(
                instances[0],
                "applyEdits",
                {"document_instance_id": "doc", "operation_id": "caller-stable-id"},
            )
        self.assertEqual("outcome_unknown", raised.exception.code)
        self.assertEqual("caller-stable-id", raised.exception.data["operation_id"])

    def test_large_read_response_preserves_specific_recovery_error(self) -> None:
        server = self.add_server("one", self.root)
        instances, _ = live.discover_instances()
        too_large = live.LiveBridgeError(
            "response_too_large",
            "BufferWeave response is too large.",
        )
        failure = live._TransportAttemptError(dispatched=True, cause=too_large)

        with mock.patch.object(live, "_exchange", side_effect=failure) as exchange:
            with self.assertRaises(live.LiveBridgeError) as raised:
                live.rpc(instances[0], "readDocument", {})
        self.assertEqual(2, exchange.call_count)
        self.assertEqual("response_too_large", raised.exception.code)


if __name__ == "__main__":
    unittest.main()
