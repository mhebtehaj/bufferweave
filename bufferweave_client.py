#!/usr/bin/env python3
"""Authenticated local client for BufferWeave extension instances.

Each supported editor window runs one extension host and publishes a short-lived registry
record in a user-private directory.  This module discovers those records,
rejects unsafe entries, routes a document to exactly one window, and performs a
single newline-delimited JSON request over that window's Unix-domain socket.

The authentication token is intentionally never included in exceptions or
diagnostic output.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import socket
import stat
import uuid
from typing import Any, Iterable
from urllib.parse import unquote, urlparse


WIRE_PROTOCOL_VERSION = "3.0"
REGISTRY_ENV = "BUFFERWEAVE_REGISTRY_DIR"
SOCKET_TIMEOUT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
_MUTATING_METHODS = frozenset({"applyEdits", "saveDocument"})
_INSTANCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class LiveBridgeError(RuntimeError):
    """A safe, structured failure returned to the MCP layer."""

    def __init__(self, code: str, message: str, data: Any | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            value["data"] = self.data
        return value


class _TransportAttemptError(Exception):
    """Internal transport failure plus any safe, specific protocol error."""

    def __init__(self, *, dispatched: bool, cause: LiveBridgeError | None = None):
        super().__init__("local bridge transport failure")
        self.dispatched = dispatched
        self.cause = cause


@dataclass(frozen=True)
class LiveInstance:
    """Validated connection metadata for one BufferWeave extension host."""

    instance_id: str
    window_id: str
    pid: int
    socket_path: Path
    token: str
    workspace_id: str | None
    workspace_folders: tuple[dict[str, Any], ...]
    workspace_file: str | None
    editor_name: str
    editor_version: str
    registry_path: Path
    registry_schema_version: int | None = None
    extension_version: str | None = None
    access_mode: str | None = None
    capabilities: tuple[str, ...] = ()

    def public_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "window_id": self.window_id,
            "pid": self.pid,
            "workspace_id": self.workspace_id,
            "workspace_folders": list(self.workspace_folders),
            "workspace_file": self.workspace_file,
            "editor_name": self.editor_name,
            "editor_version": self.editor_version,
            "registry_schema_version": self.registry_schema_version,
            "extension_version": self.extension_version,
            "access_mode": self.access_mode,
            "capabilities": list(self.capabilities),
        }


def registry_directory() -> Path:
    configured = os.environ.get(REGISTRY_ENV)
    if configured:
        return Path(os.path.abspath(os.path.expanduser(configured)))
    getuid = getattr(os, "getuid", None)
    suffix = str(getuid()) if getuid is not None else os.environ.get("USERNAME", "user")
    # macOS limits AF_UNIX paths to roughly 103 bytes. Its process temp path is
    # commonly much longer than /tmp, so keep this deterministic root short.
    base = Path("/tmp") if os.name == "posix" else Path(os.environ.get("TEMP", "."))
    return base / f"bufferweave-{suffix}"


def _owner_uid(path: Path) -> int | None:
    getuid = getattr(os, "getuid", None)
    if getuid is None:
        return None
    return path.lstat().st_uid


def _validate_private_directory(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise LiveBridgeError(
            "bridge_unavailable",
            "No BufferWeave extension instance is registered.",
        ) from exc
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise LiveBridgeError("unsafe_registry", f"BufferWeave registry is not a real directory: {path}")
    current_uid = getattr(os, "getuid", lambda: None)()
    if current_uid is not None and info.st_uid != current_uid:
        raise LiveBridgeError("unsafe_registry", "BufferWeave registry is owned by another user.")
    if info.st_mode & 0o077:
        raise LiveBridgeError(
            "unsafe_registry",
            "BufferWeave registry permissions are too broad; expected mode 0700.",
        )


def _validate_private_file(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise LiveBridgeError("unsafe_registry_entry", f"Ignoring non-regular registry entry {path.name}.")
    current_uid = getattr(os, "getuid", lambda: None)()
    if current_uid is not None and info.st_uid != current_uid:
        raise LiveBridgeError("unsafe_registry_entry", f"Registry entry {path.name} has the wrong owner.")
    if info.st_mode & 0o077:
        raise LiveBridgeError(
            "unsafe_registry_entry",
            f"Registry entry {path.name} permissions are too broad; expected mode 0600.",
        )
    return info


def _pid_alive(pid: int) -> bool:
    if pid < 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _require_string(record: dict[str, Any], field: str) -> str:
    value = record.get(field)
    if not isinstance(value, str) or not value.strip():
        raise LiveBridgeError("invalid_registry_entry", f"Registry field {field!r} is invalid.")
    return value


def _load_instance(path: Path, root: Path) -> LiveInstance:
    _validate_private_file(path)
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise LiveBridgeError("invalid_registry_entry", f"Could not read registry entry {path.name}.") from exc
    if not isinstance(record, dict):
        raise LiveBridgeError("invalid_registry_entry", f"Registry entry {path.name} is not an object.")
    if record.get("protocol_version") != WIRE_PROTOCOL_VERSION:
        raise LiveBridgeError(
            "incompatible_extension",
            f"Registry entry {path.name} uses an unsupported BufferWeave protocol version.",
        )

    instance_id = _require_string(record, "instance_id")
    window_id = record.get("window_id", instance_id)
    if not isinstance(window_id, str) or not _INSTANCE_ID.fullmatch(window_id):
        raise LiveBridgeError("invalid_registry_entry", f"Registry entry {path.name} has an invalid window id.")
    if not _INSTANCE_ID.fullmatch(instance_id):
        raise LiveBridgeError("invalid_registry_entry", f"Registry entry {path.name} has an invalid instance id.")

    pid = record.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or not _pid_alive(pid):
        raise LiveBridgeError("stale_registry_entry", f"Registry entry {path.name} is stale.")

    token = _require_string(record, "token")
    if len(token) < 32:
        raise LiveBridgeError("invalid_registry_entry", f"Registry entry {path.name} has an invalid token.")

    raw_socket = _require_string(record, "socket_path")
    socket_path = Path(raw_socket)
    if not socket_path.is_absolute() or socket_path.parent.resolve(strict=False) != root:
        raise LiveBridgeError(
            "unsafe_registry_entry",
            f"Registry entry {path.name} points outside the private registry directory.",
        )
    try:
        socket_info = socket_path.lstat()
    except FileNotFoundError as exc:
        raise LiveBridgeError("stale_registry_entry", f"Socket for registry entry {path.name} is missing.") from exc
    if not stat.S_ISSOCK(socket_info.st_mode) or stat.S_ISLNK(socket_info.st_mode):
        raise LiveBridgeError("unsafe_registry_entry", f"Registry entry {path.name} does not point to a socket.")
    current_uid = getattr(os, "getuid", lambda: None)()
    if current_uid is not None and socket_info.st_uid != current_uid:
        raise LiveBridgeError("unsafe_registry_entry", f"Socket for registry entry {path.name} has the wrong owner.")
    if socket_info.st_mode & 0o077:
        raise LiveBridgeError(
            "unsafe_registry_entry",
            f"Socket for registry entry {path.name} permissions are too broad; expected mode 0600.",
        )

    folders = record.get("workspace_folders", [])
    if not isinstance(folders, list) or any(not isinstance(item, dict) for item in folders):
        raise LiveBridgeError("invalid_registry_entry", f"Registry entry {path.name} has invalid workspaces.")
    workspace_id = record.get("workspace_id")
    if workspace_id is not None and not isinstance(workspace_id, str):
        raise LiveBridgeError("invalid_registry_entry", f"Registry entry {path.name} has an invalid workspace id.")
    workspace_file = record.get("workspace_file")
    if workspace_file is not None and not isinstance(workspace_file, str):
        raise LiveBridgeError("invalid_registry_entry", f"Registry entry {path.name} has an invalid workspace file.")
    editor_name = _require_string(record, "editor_name")
    editor_version = _require_string(record, "editor_version")
    registry_schema_version = record.get("registry_schema_version")
    if registry_schema_version != 1:
        raise LiveBridgeError("incompatible_extension", f"Registry entry {path.name} uses an unsupported schema version.")
    extension_version = record.get("extension_version")
    if not isinstance(extension_version, str) or not extension_version:
        raise LiveBridgeError("incompatible_extension", f"Registry entry {path.name} does not identify a compatible extension.")
    access_mode = record.get("access_mode")
    if access_mode not in {"read", "edit", "save"}:
        raise LiveBridgeError("incompatible_extension", f"Registry entry {path.name} has no compatible access grant.")
    raw_capabilities = record.get("capabilities")
    if not isinstance(raw_capabilities, list) or any(not isinstance(item, str) for item in raw_capabilities):
        raise LiveBridgeError("incompatible_extension", f"Registry entry {path.name} has no compatible capability list.")
    required_capabilities = {"read", "preview", "edit", "save", "rebase", "conflict"}
    if not required_capabilities.issubset(raw_capabilities):
        raise LiveBridgeError("incompatible_extension", f"Registry entry {path.name} lacks required capabilities.")
    return LiveInstance(
        instance_id=instance_id,
        window_id=window_id,
        pid=pid,
        socket_path=socket_path,
        token=token,
        workspace_id=workspace_id,
        workspace_folders=tuple(folders),
        workspace_file=workspace_file,
        editor_name=editor_name,
        editor_version=editor_version,
        registry_path=path,
        registry_schema_version=registry_schema_version,
        extension_version=extension_version,
        access_mode=access_mode,
        capabilities=tuple(raw_capabilities),
    )


def discover_instances() -> tuple[list[LiveInstance], list[dict[str, str]]]:
    """Return safe live instances plus sanitized ignored-entry diagnostics."""

    root = registry_directory()
    _validate_private_directory(root)
    canonical_root = root.resolve(strict=True)
    instances: list[LiveInstance] = []
    ignored: list[dict[str, str]] = []
    for entry in sorted(root.glob("*.json")):
        try:
            instance = _load_instance(entry, canonical_root)
        except LiveBridgeError as exc:
            ignored.append({"entry": entry.name, "code": exc.code, "message": exc.message})
            continue
        instances.append(instance)
    if not instances and ignored:
        # Preserve the diagnostics for a useful unavailable response without ever
        # leaking an authentication token or private document text.
        raise LiveBridgeError(
            "bridge_unavailable",
            "No usable BufferWeave extension instance is registered.",
            {"ignored_instances": ignored},
        )
    return instances, ignored


def _exchange(instance: LiveInstance, payload: bytes, request_id: str) -> dict[str, Any]:
    dispatched = False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(SOCKET_TIMEOUT_SECONDS)
            connection.connect(str(instance.socket_path))
            # A send failure cannot reveal how many bytes reached the peer. Be
            # conservative from the moment transmission starts.
            dispatched = True
            connection.sendall(payload)
            # Once the complete newline-terminated request has been sent, a
            # write may have executed even if the response connection fails.
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = connection.recv(min(65536, MAX_RESPONSE_BYTES + 1 - total))
                if not chunk:
                    break
                newline = chunk.find(b"\n")
                if newline >= 0:
                    chunks.append(chunk[:newline])
                    total += newline
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise LiveBridgeError("response_too_large", "BufferWeave response is too large.")
    except LiveBridgeError as exc:
        # Invalid/oversize responses occur after possible dispatch and are safe
        # to retry only because request ids are extension-side idempotency keys.
        raise _TransportAttemptError(dispatched=dispatched, cause=exc) from exc
    except (FileNotFoundError, ConnectionError, TimeoutError, socket.timeout, OSError) as exc:
        raise _TransportAttemptError(dispatched=dispatched) from exc

    raw = b"".join(chunks)
    try:
        response = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise _TransportAttemptError(dispatched=True) from exc
    if not isinstance(response, dict) or response.get("id") != request_id:
        raise _TransportAttemptError(dispatched=True)
    return response


def rpc(instance: LiveInstance, method: str, params: dict[str, Any]) -> Any:
    request_id = str(uuid.uuid4())
    payload = json.dumps(
        {
            "id": request_id,
            "token": instance.token,
            "method": method,
            "params": params,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    if len(payload) > MAX_RESPONSE_BYTES:
        raise LiveBridgeError("request_too_large", "Live edit request exceeds the local bridge size limit.")

    possible_dispatch = False
    last_specific_error: LiveBridgeError | None = None
    response: dict[str, Any] | None = None
    # Retrying the same id is safe: the extension caches the promise/result for
    # each authenticated request id. It also resolves the classic case where a
    # write succeeds but its first response is lost.
    for _ in range(2):
        try:
            response = _exchange(instance, payload, request_id)
            break
        except _TransportAttemptError as exc:
            possible_dispatch = possible_dispatch or exc.dispatched
            if exc.cause is not None:
                last_specific_error = exc.cause
    if response is None:
        if possible_dispatch and method in _MUTATING_METHODS:
            raise LiveBridgeError(
                "outcome_unknown",
                "The live write request may have completed but its response was lost. Reread the live document before taking any further action; do not fall back to a filesystem overwrite.",
                {
                    "window_id": instance.window_id,
                    "request_id": request_id,
                    "operation_id": params.get("operation_id", request_id),
                },
            )
        if last_specific_error is not None:
            raise last_specific_error
        raise LiveBridgeError(
            "bridge_unavailable",
            f"Editor window {instance.window_id} did not answer the local BufferWeave request.",
        )

    if response.get("ok") is True:
        return response.get("result")
    error = response.get("error")
    if not isinstance(error, dict):
        raise LiveBridgeError("invalid_bridge_response", "BufferWeave returned an invalid error.")
    code = error.get("code") if isinstance(error.get("code"), str) else "extension_error"
    message = error.get("message") if isinstance(error.get("message"), str) else "Editor extension request failed."
    raise LiveBridgeError(code, message, error.get("data"))


def canonical_file_identity(value: str) -> tuple[str | None, str | None]:
    """Return comparable (URI, path) values without requiring the file to be saved."""

    try:
        if value.startswith("file:"):
            parsed = urlparse(value)
            if parsed.scheme != "file" or parsed.netloc not in {"", "localhost"}:
                raise LiveBridgeError("invalid_document", "Only local file URIs are supported.")
            path = Path(unquote(parsed.path)).expanduser().resolve(strict=False)
            return path.as_uri(), str(path)
        if "://" in value:
            # Non-file documents may be read by URI, but edits remain extension-side
            # policy decisions. Keep the URI exact and do not reinterpret it as a path.
            return value, None
        path = Path(value).expanduser().resolve(strict=False)
        return path.as_uri(), str(path)
    except (OSError, RuntimeError, ValueError) as exc:
        raise LiveBridgeError("invalid_document", "Document path or URI is invalid.") from exc


def _normalize_open_document(document: dict[str, Any], index: int) -> dict[str, Any]:
    """Validate one extension descriptor and return canonical routing metadata."""

    def invalid() -> LiveBridgeError:
        return LiveBridgeError(
            "invalid_bridge_response",
            f"BufferWeave returned an invalid document descriptor at index {index}.",
        )

    document_uri = document.get("document_uri")
    document_path = document.get("path")
    if not isinstance(document_uri, str) or not document_uri or not isinstance(document_path, str):
        raise invalid()
    try:
        canonical_uri, uri_path = canonical_file_identity(document_uri)
        path_uri, canonical_path = canonical_file_identity(document_path)
    except (LiveBridgeError, OSError, RuntimeError, ValueError):
        raise invalid() from None
    # The extension exposes local workspace files only. Requiring both
    # identities to agree prevents a malformed descriptor from matching by its
    # path and then redirecting the actual operation through a different URI.
    if uri_path is None or canonical_path is None or canonical_uri != path_uri or uri_path != canonical_path:
        raise invalid()

    document_instance_id = document.get("document_instance_id")
    version = document.get("version")
    is_dirty = document.get("is_dirty")
    language_id = document.get("language_id")
    eol = document.get("eol")
    if (
        not isinstance(document_instance_id, str)
        or not document_instance_id
        or isinstance(version, bool)
        or not isinstance(version, int)
        or version < 1
        or not isinstance(is_dirty, bool)
        or not isinstance(language_id, str)
        or not language_id
        or eol not in {"\n", "\r\n"}
    ):
        raise invalid()

    workspace = document.get("workspace")
    if not isinstance(workspace, dict):
        raise invalid()
    workspace_uri = workspace.get("uri")
    workspace_path = workspace.get("path")
    workspace_name = workspace.get("name")
    if (
        not isinstance(workspace_uri, str)
        or not workspace_uri
        or not isinstance(workspace_path, str)
        or not isinstance(workspace_name, str)
        or not workspace_name
    ):
        raise invalid()
    try:
        canonical_workspace_uri, uri_workspace_path = canonical_file_identity(workspace_uri)
        path_workspace_uri, canonical_workspace_path = canonical_file_identity(workspace_path)
    except (LiveBridgeError, OSError, RuntimeError, ValueError):
        raise invalid() from None
    if (
        uri_workspace_path is None
        or canonical_workspace_path is None
        or canonical_workspace_uri != path_workspace_uri
        or uri_workspace_path != canonical_workspace_path
        or not Path(canonical_path).is_relative_to(Path(canonical_workspace_path))
    ):
        raise invalid()

    return {
        **document,
        "document_uri": canonical_uri,
        "path": canonical_path,
        "workspace": {
            **workspace,
            "uri": canonical_workspace_uri,
            "path": canonical_workspace_path,
        },
    }


def _document_matches(document: dict[str, Any], *, uri: str | None, path: str | None) -> bool:
    return (uri is not None and document["document_uri"] == uri) or (
        path is not None and document["path"] == path
    )


def _workspace_matches(instance: LiveInstance, workspace: str) -> bool:
    try:
        wanted_uri, wanted_path = canonical_file_identity(workspace)
    except LiveBridgeError:
        return False
    if instance.workspace_id and workspace == instance.workspace_id:
        return True
    for folder in instance.workspace_folders:
        uri = folder.get("uri")
        path = folder.get("path")
        if wanted_uri is not None and isinstance(uri, str) and uri == wanted_uri:
            return True
        if wanted_path is not None and isinstance(path, str):
            try:
                if str(Path(path).resolve(strict=False)) == wanted_path:
                    return True
            except (OSError, RuntimeError):
                pass
    return False


def select_instances(
    instances: Iterable[LiveInstance],
    *,
    window_id: str | None = None,
    workspace: str | None = None,
) -> list[LiveInstance]:
    selected = list(instances)
    if window_id is not None:
        selected = [item for item in selected if item.window_id == window_id or item.instance_id == window_id]
        if not selected:
            raise LiveBridgeError("window_not_found", f"No live editor window matches {window_id!r}.")
    if workspace is not None:
        selected = [item for item in selected if _workspace_matches(item, workspace)]
        if not selected:
            raise LiveBridgeError("workspace_not_found", f"No live editor window has workspace {workspace!r} open.")
    return selected


def list_open_documents(
    instance: LiveInstance,
    params: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    result = rpc(instance, "listOpenDocuments", params or {})
    if isinstance(result, dict):
        documents = result.get("documents")
    else:
        documents = result
    if not isinstance(documents, list) or any(not isinstance(item, dict) for item in documents):
        raise LiveBridgeError("invalid_bridge_response", "BufferWeave returned an invalid document list.")
    normalized = [_normalize_open_document(document, index) for index, document in enumerate(documents)]
    # Window identity is authoritative connection metadata, not document data.
    # Attach it after decoding so callers can always disambiguate real adapter
    # responses and a compromised/stale payload cannot spoof another window.
    return [
        {
            **document,
            "instance_id": instance.instance_id,
            "window_id": instance.window_id,
            "workspace_id": instance.workspace_id,
            "editor_name": instance.editor_name,
            "editor_version": instance.editor_version,
        }
        for document in normalized
    ]


def route_document(
    document: str,
    *,
    window_id: str | None = None,
    workspace: str | None = None,
    workspace_path: str | None = None,
) -> tuple[LiveInstance, dict[str, Any]]:
    """Resolve a document to exactly one live editor window."""

    if not isinstance(document, str) or not document:
        raise LiveBridgeError("invalid_document", "document must be a non-empty URI or path")
    wanted_uri, wanted_path = canonical_file_identity(document)
    instances, ignored = discover_instances()
    if not instances:
        raise LiveBridgeError(
            "bridge_unavailable",
            "No connected BufferWeave extension instance is registered.",
        )
    candidates = select_instances(instances, window_id=window_id, workspace=workspace)
    if workspace_path is not None:
        candidates = select_instances(candidates, workspace=workspace_path)
    matches: list[tuple[LiveInstance, dict[str, Any]]] = []
    unavailable: list[dict[str, str]] = []
    for instance in candidates:
        try:
            open_documents = list_open_documents(instance)
        except LiveBridgeError as exc:
            unavailable.append(
                {
                    "window_id": instance.window_id,
                    "code": exc.code,
                    "message": exc.message,
                }
            )
            continue
        for open_document in open_documents:
            if _document_matches(open_document, uri=wanted_uri, path=wanted_path):
                matches.append((instance, open_document))
                break
    # A stale entry is proven not to identify a usable extension instance. Any
    # other rejected entry may still be a live editor window that we cannot
    # safely probe (for example, a window that has not reloaded after a protocol
    # upgrade). In that case implicit routing cannot prove that the healthy
    # match is unique. An explicit healthy window_id remains authoritative.
    uninspectable = [
        item for item in ignored if item.get("code") != "stale_registry_entry"
    ]
    if (unavailable or uninspectable) and window_id is None:
        raise LiveBridgeError(
            "routing_incomplete",
            "At least one registered editor window cannot be safely inspected, so unique document routing cannot be proven; specify a healthy window_id or reconnect the editor.",
            {
                "matching_window_ids": [instance.window_id for instance, _ in matches],
                "unavailable_instances": unavailable,
                "ignored_instances": uninspectable,
            },
        )
    if not matches:
        if unavailable:
            raise LiveBridgeError(
                "bridge_unavailable",
                "The selected editor window did not answer the local BufferWeave request.",
                {"unavailable_instances": unavailable},
            )
        raise LiveBridgeError(
            "document_not_open",
            "The requested document is not open in a connected editor window inside an open workspace.",
        )
    if len(matches) > 1:
        raise LiveBridgeError(
            "ambiguous_document",
            "The document is open in more than one editor window; specify window_id.",
            {
                "matches": [
                    {
                        "window_id": instance.window_id,
                        "workspace_id": instance.workspace_id,
                    }
                    for instance, _ in matches
                ]
            },
        )
    return matches[0]
