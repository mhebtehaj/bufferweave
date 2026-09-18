#!/usr/bin/env python3
"""BufferWeave MCP server for navigation and live editor collaboration."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any
from urllib.parse import urlparse

from bufferweave_client import (
    LiveBridgeError,
    canonical_file_identity,
    discover_instances,
    list_open_documents as live_list_open_documents,
    route_document,
    rpc as live_rpc,
    select_instances,
)


SERVER_NAME = "bufferweave"
SERVER_VERSION = "0.3.0"
PROTOCOL_VERSION = "2025-06-18"
MAX_SAFE_INTEGER = 9_007_199_254_740_991
EDITOR_ENV = "BUFFERWEAVE_EDITOR"

SERVER_INSTRUCTIONS = (
    "Provide standard clickable file citations with absolute paths and exact one-based "
    "line numbers when the user asks for links or line references; the Codex host is "
    "configured to open local files, so clicking those citations opens the selected editor. "
    "Use open_file only when the user asks to open, show, reveal, jump to, navigate to, "
    "or move the editor immediately. Reuse the existing editor window unless the user "
    "explicitly requests a new window. After editing, use open_file when opening the "
    "principal changed location would materially help review. Do not treat this tool "
    "as authorization to edit the file, and never invent a path. When the user asks "
    "for collaborative editing in a live editor buffer, prefer the live-document tools: "
    "read the current document version immediately before editing, send small logical "
    "transactions with expected original text, and never overwrite a conflict. Rebase "
    "only through BufferWeave's verified non-overlapping history. Multiple Codex chats or "
    "agents may use BufferWeave concurrently: each must do its own fresh read, and an agent "
    "that loses an overlapping race must reread and resolve the conflict rather than retrying "
    "blindly. Normally omit operation_id; if supplied, it must be globally unique and may "
    "be reused only for the identical uncertain request. Use ordinary filesystem "
    "patches only when BufferWeave is unavailable, and tell the user when falling back. "
    "After outcome_unknown, reread the live document and never use a filesystem fallback; "
    "an absent change is not proof of cancellation because a delayed queued operation may "
    "still commit, so retry only the identical returned operation id."
)

_WINDOW_FILTER_PROPERTIES: dict[str, Any] = {
    "window_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": r".*\S.*",
        "description": "Exact live editor window id. Required when the same document is open in multiple windows.",
    },
    "workspace_id": {
        "type": "string",
        "minLength": 1,
        "pattern": r".*\S.*",
        "description": "Exact workspace id returned by list_editor_workspaces.",
    },
    "workspace_path": {
        "type": "string",
        "minLength": 1,
        "pattern": r".*\S.*",
        "description": "Absolute path of an open workspace folder used to narrow routing.",
    },
}

_DOCUMENT_SELECTOR_PROPERTIES: dict[str, Any] = {
    "document_uri": {
        "type": "string",
        "minLength": 1,
        "pattern": r".*\S.*",
        "description": "Canonical file URI returned by a live-document read or listing.",
    },
    "path": {
        "type": "string",
        "minLength": 1,
        "pattern": r".*\S.*",
        "description": "Absolute local path of a document already open in a connected editor.",
    },
    **_WINDOW_FILTER_PROPERTIES,
}

_LIVE_EDIT_PROPERTIES: dict[str, Any] = {
    **_DOCUMENT_SELECTOR_PROPERTIES,
    "operation_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": r".*\S.*",
        "description": (
            "Normally omit this globally unique idempotency key. Supply it only to retry "
            "the identical apply using error.data.operation_id after outcome_unknown."
        ),
    },
    "document_instance_id": {
        "type": "string",
        "minLength": 1,
        "pattern": r".*\S.*",
        "description": "Opaque document-lifetime id returned by read_live_document.",
    },
    "base_version": {
        "type": "integer",
        "minimum": 1,
        "maximum": MAX_SAFE_INTEGER,
        "description": "Editor document version returned by the immediately preceding live read.",
    },
    "edits": {
        "type": "array",
        "minItems": 1,
        "maxItems": 256,
        "description": "Non-overlapping edits expressed as UTF-16 offsets in the base document.",
        "items": {
            "type": "object",
            "properties": {
                "start_offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_SAFE_INTEGER,
                },
                "end_offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_SAFE_INTEGER,
                },
                "expected_original_text": {"type": "string"},
                "replacement_text": {"type": "string"},
            },
            "required": [
                "start_offset",
                "end_offset",
                "expected_original_text",
                "replacement_text",
            ],
            "additionalProperties": False,
        },
    },
    "description": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500,
        "pattern": r".*\S.*",
        "description": "Short human-readable description of this logical edit transaction.",
    },
    "save_after_apply": {
        "type": "boolean",
        "description": "Save only after the complete transaction applies successfully.",
    },
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "open_file",
        "description": (
            "Open an existing local file in the selected editor at an optional line and column. "
            "Use this for an immediate navigation request; for a clickable reference "
            "that the user can open later, provide a standard file citation instead."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or current-working-directory-relative local file path.",
                },
                "line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional one-based line number.",
                },
                "column": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional one-based column number. Requires line.",
                },
                "new_window": {
                    "type": "boolean",
                    "default": False,
                    "description": "Open in a new editor window.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "open_workspace",
        "description": "Open an existing local directory as a workspace in the selected editor.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or current-working-directory-relative local directory path.",
                },
                "new_window": {
                    "type": "boolean",
                    "default": False,
                    "description": "Open in a new editor window.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "check_editor",
        "description": (
            "Report the editor selected by BUFFERWEAVE_EDITOR or automatic detection, "
            "and whether it can be launched."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "list_editor_workspaces",
        "description": (
            "List connected editor windows, editor identity/version, and explicitly open "
            "workspace folders. Use window_id to disambiguate duplicate windows."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "list_open_documents",
        "description": (
            "List live text documents from connected editor windows. The text is not returned; "
            "use read_live_document to read unsaved buffer contents."
        ),
        "inputSchema": {
            "type": "object",
            "properties": _WINDOW_FILTER_PROPERTIES,
            "additionalProperties": False,
        },
    },
    {
        "name": "read_live_document",
        "description": (
            "Read text directly from an open editor TextDocument, including unsaved edits. "
            "Offsets are UTF-16 code units, matching the extension API."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                **_DOCUMENT_SELECTOR_PROPERTIES,
                "range": {
                    "type": "object",
                    "properties": {
                        "start_offset": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": MAX_SAFE_INTEGER,
                        },
                        "end_offset": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": MAX_SAFE_INTEGER,
                        },
                    },
                    "required": ["start_offset", "end_offset"],
                    "additionalProperties": False,
                },
            },
            "anyOf": [{"required": ["document_uri"]}, {"required": ["path"]}],
            "additionalProperties": False,
        },
    },
    {
        "name": "preview_live_edits",
        "description": (
            "Validate and rebase a versioned edit without modifying the document, then show a "
            "reviewable editor diff. Set save_after_apply explicitly to false. Conflicts and "
            "missing history are returned structurally."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                **{
                    key: value
                    for key, value in _LIVE_EDIT_PROPERTIES.items()
                    if key not in {"operation_id", "save_after_apply"}
                },
                "save_after_apply": {
                    "type": "boolean",
                    "const": False,
                    "description": "Must be explicitly false because preview never saves.",
                },
            },
            "required": [
                "document_instance_id",
                "base_version",
                "edits",
                "description",
                "save_after_apply",
            ],
            "anyOf": [{"required": ["document_uri"]}, {"required": ["path"]}],
            "additionalProperties": False,
        },
    },
    {
        "name": "apply_live_edits",
        "description": (
            "Apply a safe versioned edit to the live editor buffer as one logical transaction. "
            "Concurrent chats are serialized per document: BufferWeave verifies expected text, "
            "rebases only across non-overlapping changes, and never writes on conflict, stale "
            "history, or a version race."
        ),
        "inputSchema": {
            "type": "object",
            "properties": _LIVE_EDIT_PROPERTIES,
            "required": [
                "document_instance_id",
                "base_version",
                "edits",
                "description",
                "save_after_apply",
            ],
            "anyOf": [{"required": ["document_uri"]}, {"required": ["path"]}],
            "additionalProperties": False,
        },
    },
    {
        "name": "save_live_document",
        "description": "Save an open live editor document only at the freshly read expected version.",
        "inputSchema": {
            "type": "object",
            "properties": {
                **_DOCUMENT_SELECTOR_PROPERTIES,
                "document_instance_id": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": r".*\S.*",
                    "description": "Opaque document-lifetime id returned by read_live_document.",
                },
                "expected_version": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SAFE_INTEGER,
                },
                "operation_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": r".*\S.*",
                    "description": (
                        "Normally omit this globally unique idempotency key. Supply it only to "
                        "retry the identical save using error.data.operation_id after "
                        "outcome_unknown."
                    ),
                },
            },
            "required": ["document_instance_id", "expected_version"],
            "anyOf": [{"required": ["document_uri"]}, {"required": ["path"]}],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_document_changes",
        "description": (
            "Return the bounded editor change history after a base version. If the complete "
            "history is unavailable, the result requires a fresh read."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                **_DOCUMENT_SELECTOR_PROPERTIES,
                "document_instance_id": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": r".*\S.*",
                    "description": "Opaque document-lifetime id returned by read_live_document.",
                },
                "base_version": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SAFE_INTEGER,
                },
                "through_version": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SAFE_INTEGER,
                },
            },
            "required": ["document_instance_id", "base_version"],
            "anyOf": [{"required": ["document_uri"]}, {"required": ["path"]}],
            "additionalProperties": False,
        },
    },
]


class ToolInputError(ValueError):
    """Raised when a tool receives invalid user input."""


@dataclass(frozen=True)
class EditorInstallation:
    """One detected editor plus how BufferWeave selected it."""

    key: str
    display_name: str
    cli_path: str | None
    app_path: Path | None
    selection_reason: str

    @property
    def launch_location(self) -> str:
        if self.cli_path is not None:
            return f"CLI at {self.cli_path}"
        if self.app_path is not None:
            return f"app at {self.app_path}"
        return "unavailable"


def _tool_result(message: str, *, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": is_error,
    }


def _structured_tool_result(value: Any, *, is_error: bool = False) -> dict[str, Any]:
    structured = value if isinstance(value, dict) else {"items": value}
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True),
            }
        ],
        "structuredContent": structured,
        "isError": is_error,
    }


def _resolve_local_path(raw_path: Any, *, kind: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ToolInputError("path must be a non-empty string")
    if "://" in raw_path or raw_path.startswith("file:"):
        raise ToolInputError("path must be a local filesystem path, not a URI")

    try:
        path = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ToolInputError(f"path does not exist: {raw_path}") from exc

    if kind == "file" and not path.is_file():
        raise ToolInputError(f"path is not a file: {path}")
    if kind == "directory" and not path.is_dir():
        raise ToolInputError(f"path is not a directory: {path}")
    return path


def _positive_int(value: Any, name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ToolInputError(f"{name} must be a positive integer")
    return value


def _optional_string(arguments: dict[str, Any], name: str) -> str | None:
    value = arguments.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ToolInputError(f"{name} must be a non-empty string")
    return value


def _live_filters(arguments: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    return (
        _optional_string(arguments, "window_id"),
        _optional_string(arguments, "workspace_id"),
        _optional_string(arguments, "workspace_path"),
    )


def _reject_unknown(arguments: dict[str, Any], allowed: set[str]) -> None:
    unknown = sorted(set(arguments) - allowed)
    if unknown:
        raise ToolInputError(f"unexpected argument(s): {', '.join(unknown)}")


def _required_int(
    arguments: dict[str, Any],
    name: str,
    minimum: int = 0,
    maximum: int = MAX_SAFE_INTEGER,
) -> int:
    value = arguments.get(name)
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        raise ToolInputError(f"{name} must be an integer from {minimum} through {maximum}")
    return value


def _required_string(
    arguments: dict[str, Any],
    name: str,
    *,
    maximum: int | None = None,
) -> str:
    value = _optional_string(arguments, name)
    if value is None:
        raise ToolInputError(f"{name} is required")
    if maximum is not None and len(value) > maximum:
        raise ToolInputError(f"{name} must be at most {maximum} characters")
    return value


def _validate_document_selector(arguments: dict[str, Any]) -> None:
    _document_argument(arguments)
    path = arguments.get("path")
    if isinstance(path, str) and not Path(path).is_absolute():
        raise ToolInputError("path must be absolute for live-document tools")
    document_uri = arguments.get("document_uri")
    if isinstance(document_uri, str):
        parsed_uri = urlparse(document_uri)
        if (
            parsed_uri.scheme != "file"
            or parsed_uri.netloc not in {"", "localhost"}
            or not parsed_uri.path.startswith("/")
            or parsed_uri.query
            or parsed_uri.fragment
        ):
            raise ToolInputError("document_uri must be an absolute local file URI")
        _, uri_path = canonical_file_identity(document_uri)
        if uri_path is None:
            raise ToolInputError("document_uri must use the file scheme")
    _live_filters(arguments)
    workspace_path = arguments.get("workspace_path")
    if isinstance(workspace_path, str) and not Path(workspace_path).is_absolute():
        raise ToolInputError("workspace_path must be absolute")


def _validate_range(value: Any, name: str) -> None:
    if not isinstance(value, dict):
        raise ToolInputError(f"{name} must be an object")
    _reject_unknown(value, {"start_offset", "end_offset"})
    start = _required_int(value, "start_offset")
    end = _required_int(value, "end_offset")
    if end < start:
        raise ToolInputError(f"{name}.end_offset must be >= {name}.start_offset")


def _validate_live_arguments(name: str, arguments: dict[str, Any]) -> None:
    filters = {"window_id", "workspace_id", "workspace_path"}
    selector = filters | {"document_uri", "path"}
    if name == "list_editor_workspaces":
        _reject_unknown(arguments, set())
        return
    if name == "list_open_documents":
        _reject_unknown(arguments, filters)
        _live_filters(arguments)
        workspace_path = arguments.get("workspace_path")
        if isinstance(workspace_path, str) and not Path(workspace_path).is_absolute():
            raise ToolInputError("workspace_path must be absolute")
        return

    if name == "read_live_document":
        _reject_unknown(arguments, selector | {"range"})
        _validate_document_selector(arguments)
        if "range" in arguments:
            _validate_range(arguments["range"], "range")
        return

    if name in {"preview_live_edits", "apply_live_edits"}:
        allowed = selector | {
            "document_instance_id",
            "base_version",
            "edits",
            "description",
            "save_after_apply",
        }
        if name == "apply_live_edits":
            allowed.add("operation_id")
        _reject_unknown(arguments, allowed)
        _validate_document_selector(arguments)
        _required_string(arguments, "document_instance_id")
        _required_int(arguments, "base_version", 1)
        _required_string(arguments, "description", maximum=500)
        if "operation_id" in arguments:
            _required_string(arguments, "operation_id", maximum=128)
        if "save_after_apply" not in arguments:
            raise ToolInputError("save_after_apply is required")
        save = arguments["save_after_apply"]
        if not isinstance(save, bool):
            raise ToolInputError("save_after_apply must be a boolean")
        if name == "preview_live_edits" and save:
            raise ToolInputError("preview_live_edits requires save_after_apply=false")
        edits = arguments.get("edits")
        if not isinstance(edits, list) or not 1 <= len(edits) <= 256:
            raise ToolInputError("edits must contain between 1 and 256 entries")
        for index, edit in enumerate(edits):
            if not isinstance(edit, dict):
                raise ToolInputError(f"edits[{index}] must be an object")
            _reject_unknown(
                edit,
                {"start_offset", "end_offset", "expected_original_text", "replacement_text"},
            )
            _validate_range(
                {"start_offset": edit.get("start_offset"), "end_offset": edit.get("end_offset")},
                f"edits[{index}]",
            )
            if not isinstance(edit.get("expected_original_text"), str):
                raise ToolInputError(f"edits[{index}].expected_original_text must be a string")
            if not isinstance(edit.get("replacement_text"), str):
                raise ToolInputError(f"edits[{index}].replacement_text must be a string")
        return

    if name == "save_live_document":
        _reject_unknown(
            arguments,
            selector | {"document_instance_id", "expected_version", "operation_id"},
        )
        _validate_document_selector(arguments)
        _required_string(arguments, "document_instance_id")
        _required_int(arguments, "expected_version", 1)
        if "operation_id" in arguments:
            _required_string(arguments, "operation_id", maximum=128)
        return

    if name == "get_document_changes":
        _reject_unknown(
            arguments,
            selector | {"document_instance_id", "base_version", "through_version"},
        )
        _validate_document_selector(arguments)
        _required_string(arguments, "document_instance_id")
        base = _required_int(arguments, "base_version", 1)
        if "through_version" in arguments:
            _required_int(arguments, "through_version", base)
        return


def _selected_live_instances(arguments: dict[str, Any]):
    window_id, workspace_id, workspace_path = _live_filters(arguments)
    instances, ignored = discover_instances()
    selected = select_instances(instances, window_id=window_id, workspace=workspace_id)
    if workspace_path is not None:
        selected = select_instances(selected, workspace=workspace_path)
    return selected, ignored


def _document_argument(arguments: dict[str, Any]) -> str:
    document_uri = _optional_string(arguments, "document_uri")
    path = _optional_string(arguments, "path")
    if document_uri is None and path is None:
        raise ToolInputError("one of document_uri or path is required")
    if document_uri is not None and path is not None:
        uri_identity, _ = canonical_file_identity(document_uri)
        path_identity, _ = canonical_file_identity(path)
        if uri_identity != path_identity:
            raise ToolInputError("document_uri and path identify different live documents")
        return document_uri
    return document_uri or path or ""


def _routed_live_document(arguments: dict[str, Any], *, override: str | None = None):
    window_id, workspace_id, workspace_path = _live_filters(arguments)
    document = override
    if document is None:
        document_uri = _optional_string(arguments, "document_uri")
        path = _optional_string(arguments, "path")
        document = document_uri or path
    if document is None:
        raise ToolInputError("one of document_uri or path is required")
    instance, open_document = route_document(
        document,
        window_id=window_id,
        workspace=workspace_id,
        workspace_path=workspace_path,
    )
    return instance, open_document


def _extension_selector(instance: Any, document: dict[str, Any]) -> dict[str, Any]:
    document_uri = document.get("document_uri", document.get("uri"))
    if not isinstance(document_uri, str) or not document_uri:
        raise LiveBridgeError("invalid_bridge_response", "The editor returned a document without a URI.")
    selector: dict[str, Any] = {
        "document_uri": document_uri,
        "window_id": instance.window_id,
    }
    if instance.workspace_id:
        selector["workspace_id"] = instance.workspace_id
    return selector


def _call_live_document_method(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    # Validate a supplied URI/path pair before routing the canonical target once.
    document = _document_argument(arguments)
    instance, open_document = _routed_live_document(arguments, override=document)
    params = _extension_selector(instance, open_document)

    if name == "read_live_document":
        if "range" in arguments:
            params["range"] = arguments["range"]
        method = "readDocument"
    elif name in {"preview_live_edits", "apply_live_edits"}:
        params.update(
            {
                "document_instance_id": arguments.get("document_instance_id"),
                "base_version": arguments.get("base_version"),
                "edits": arguments.get("edits"),
                "description": arguments.get("description"),
                "save_after_apply": arguments["save_after_apply"],
            }
        )
        if name == "apply_live_edits" and "operation_id" in arguments:
            params["operation_id"] = arguments["operation_id"]
        method = "previewEdits" if name == "preview_live_edits" else "applyEdits"
    elif name == "save_live_document":
        params["document_instance_id"] = arguments.get("document_instance_id")
        params["expected_version"] = arguments.get("expected_version")
        if "operation_id" in arguments:
            params["operation_id"] = arguments["operation_id"]
        method = "saveDocument"
    elif name == "get_document_changes":
        params["document_instance_id"] = arguments.get("document_instance_id")
        params["base_version"] = arguments.get("base_version")
        if "through_version" in arguments:
            params["through_version"] = arguments["through_version"]
        method = "getDocumentChanges"
    else:  # pragma: no cover - only called from the fixed dispatch below.
        raise ToolInputError(f"unknown live document tool: {name}")

    return _structured_tool_result(live_rpc(instance, method, params))


_EDITOR_SPECS: dict[str, dict[str, str]] = {
    "cursor": {
        "display_name": "Cursor",
        "cli_name": "cursor",
        "app_bundle": "Cursor.app",
    },
    "code": {
        "display_name": "Visual Studio Code",
        "cli_name": "code",
        "app_bundle": "Visual Studio Code.app",
    },
}


def _find_editor_installation(editor_key: str) -> EditorInstallation | None:
    spec = _EDITOR_SPECS[editor_key]
    cli_path = shutil.which(spec["cli_name"])
    if cli_path:
        return EditorInstallation(
            key=editor_key,
            display_name=spec["display_name"],
            cli_path=cli_path,
            app_path=None,
            selection_reason="",
        )

    if sys.platform == "darwin":
        app_paths = (
            Path("/Applications") / spec["app_bundle"],
            Path.home() / "Applications" / spec["app_bundle"],
        )
        for app_path in app_paths:
            if not app_path.exists():
                continue
            bundled_cli = app_path / "Contents/Resources/app/bin" / spec["cli_name"]
            bundled_cli_path = (
                str(bundled_cli)
                if bundled_cli.is_file() and os.access(bundled_cli, os.X_OK)
                else None
            )
            return EditorInstallation(
                key=editor_key,
                display_name=spec["display_name"],
                cli_path=bundled_cli_path,
                app_path=app_path,
                selection_reason="",
            )
    return None


def _with_selection_reason(
    installation: EditorInstallation,
    reason: str,
) -> EditorInstallation:
    return EditorInstallation(
        key=installation.key,
        display_name=installation.display_name,
        cli_path=installation.cli_path,
        app_path=installation.app_path,
        selection_reason=reason,
    )


def _select_editor() -> EditorInstallation:
    configured = os.environ.get(EDITOR_ENV)
    if configured is not None:
        editor_key = configured.strip().lower()
        if editor_key not in _EDITOR_SPECS:
            raise ToolInputError(f"{EDITOR_ENV} must be either 'cursor' or 'code'")
        installation = _find_editor_installation(editor_key)
        display_name = _EDITOR_SPECS[editor_key]["display_name"]
        if installation is None:
            raise ToolInputError(
                f"{EDITOR_ENV} explicitly selects {display_name}, but that editor was not found"
            )
        return _with_selection_reason(
            installation,
            f"Selected {display_name} from {EDITOR_ENV}={editor_key}",
        )

    cursor = _find_editor_installation("cursor")
    code = _find_editor_installation("code")
    if cursor is not None and code is not None:
        return _with_selection_reason(
            cursor,
            "Auto-selected Cursor because both supported editors are available",
        )
    if cursor is not None:
        return _with_selection_reason(
            cursor,
            "Auto-selected Cursor because it is the only supported editor found",
        )
    if code is not None:
        return _with_selection_reason(
            code,
            "Auto-selected Visual Studio Code because it is the only supported editor found",
        )
    raise ToolInputError(
        "Neither Cursor nor Visual Studio Code was found; install one or set "
        f"{EDITOR_ENV}=cursor|code after installation"
    )


def _editor_availability() -> tuple[bool, str]:
    try:
        editor = _select_editor()
    except ToolInputError as exc:
        return False, str(exc)
    return True, f"{editor.selection_reason}; using {editor.launch_location}."


def _launch_editor_file(
    editor: EditorInstallation,
    path: Path,
    line: int | None,
    column: int | None,
    new_window: bool,
) -> None:
    target = str(path)
    if line is not None:
        target += f":{line}"
        if column is not None:
            target += f":{column}"

    if editor.cli_path is not None:
        command = [editor.cli_path]
        if new_window:
            command.append("--new-window")
        command.extend(["--goto", target])
    elif sys.platform == "darwin" and editor.app_path is not None:
        command = ["/usr/bin/open", "-a", str(editor.app_path), "--args"]
        if new_window:
            command.append("--new-window")
        command.extend(["--goto", target])
    else:
        raise ToolInputError(f"{editor.display_name} cannot be launched on this platform")

    completed = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown launch error"
        raise RuntimeError(detail)


def _launch_editor_workspace(
    editor: EditorInstallation,
    path: Path,
    new_window: bool,
) -> None:
    if editor.cli_path is not None:
        command = [editor.cli_path]
        if new_window:
            command.append("--new-window")
        command.append(str(path))
    elif sys.platform == "darwin" and editor.app_path is not None:
        command = ["/usr/bin/open"]
        if new_window:
            command.append("-n")
        command.extend(["-a", str(editor.app_path), str(path)])
    else:
        raise ToolInputError(f"{editor.display_name} cannot be launched on this platform")

    completed = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown launch error"
        raise RuntimeError(detail)


def call_tool(name: str, arguments: Any) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        return _tool_result("tool arguments must be an object", is_error=True)

    try:
        if name == "check_editor":
            _reject_unknown(arguments, set())
            available, message = _editor_availability()
            return _tool_result(message, is_error=not available)

        if name == "open_file":
            _reject_unknown(arguments, {"path", "line", "column", "new_window"})
            path = _resolve_local_path(arguments.get("path"), kind="file")
            line = _positive_int(arguments.get("line"), "line")
            column = _positive_int(arguments.get("column"), "column")
            if column is not None and line is None:
                raise ToolInputError("column requires line")
            new_window = arguments.get("new_window", False)
            if not isinstance(new_window, bool):
                raise ToolInputError("new_window must be a boolean")
            editor = _select_editor()
            _launch_editor_file(editor, path, line, column, new_window)
            location = str(path)
            if line is not None:
                location += f":{line}"
                if column is not None:
                    location += f":{column}"
            return _tool_result(
                f"Opened {location} in {editor.display_name}. {editor.selection_reason}."
            )

        if name == "open_workspace":
            _reject_unknown(arguments, {"path", "new_window"})
            path = _resolve_local_path(arguments.get("path"), kind="directory")
            new_window = arguments.get("new_window", False)
            if not isinstance(new_window, bool):
                raise ToolInputError("new_window must be a boolean")
            editor = _select_editor()
            _launch_editor_workspace(editor, path, new_window)
            return _tool_result(
                f"Opened workspace {path} in {editor.display_name}. {editor.selection_reason}."
            )

        if name == "list_editor_workspaces":
            _validate_live_arguments(name, arguments)
            instances, ignored = discover_instances()
            windows: list[dict[str, Any]] = []
            unreachable: list[dict[str, Any]] = []
            for instance in instances:
                try:
                    result = live_rpc(instance, "listWorkspaces", {})
                except LiveBridgeError as exc:
                    unreachable.append(
                        {
                            "window_id": instance.window_id,
                            "error": exc.as_dict(),
                        }
                    )
                    continue
                if isinstance(result, dict):
                    window = dict(result)
                else:
                    window = {"workspaces": result}
                window["window_id"] = instance.window_id
                window["instance_id"] = instance.instance_id
                window["workspace_id"] = instance.workspace_id
                window["editor_name"] = instance.editor_name
                window["editor_version"] = instance.editor_version
                windows.append(window)
            return _structured_tool_result(
                {
                    "windows": windows,
                    "ignored_instances": ignored,
                    "unreachable_instances": unreachable,
                }
            )

        if name == "list_open_documents":
            _validate_live_arguments(name, arguments)
            instances, ignored = _selected_live_instances(arguments)
            documents: list[dict[str, Any]] = []
            unreachable: list[dict[str, Any]] = []
            for instance in instances:
                try:
                    params: dict[str, Any] = {"window_id": instance.window_id}
                    if instance.workspace_id:
                        params["workspace_id"] = instance.workspace_id
                    if "workspace_path" in arguments:
                        params["workspace_path"] = arguments["workspace_path"]
                    documents.extend(live_list_open_documents(instance, params))
                except LiveBridgeError as exc:
                    unreachable.append(
                        {
                            "window_id": instance.window_id,
                            "error": exc.as_dict(),
                        }
                    )
            return _structured_tool_result(
                {
                    "documents": documents,
                    "ignored_instances": ignored,
                    "unreachable_instances": unreachable,
                }
            )

        if name in {
            "read_live_document",
            "preview_live_edits",
            "apply_live_edits",
            "save_live_document",
            "get_document_changes",
        }:
            _validate_live_arguments(name, arguments)
            return _call_live_document_method(name, arguments)

        return _tool_result(f"unknown tool: {name}", is_error=True)
    except LiveBridgeError as exc:
        return _structured_tool_result(
            {"status": "error", "error": exc.as_dict()},
            is_error=True,
        )
    except (ToolInputError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        return _tool_result(str(exc), is_error=True)


def _response(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def handle_request(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    has_request_id = "id" in message
    request_id = message.get("id")
    if "params" not in message:
        params: dict[str, Any] = {}
    else:
        raw_params = message["params"]
        if not isinstance(raw_params, dict):
            if not has_request_id:
                return None
            return _error(request_id, -32602, "invalid params: params must be an object")
        params = raw_params

    if method == "initialize":
        requested_version = params.get("protocolVersion")
        protocol_version = (
            requested_version
            if requested_version == PROTOCOL_VERSION
            else PROTOCOL_VERSION
        )
        return _response(
            request_id,
            {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": SERVER_INSTRUCTIONS,
            },
        )
    if method == "ping":
        return _response(request_id, {})
    if method == "tools/list":
        return _response(request_id, {"tools": TOOLS})
    if method == "tools/call":
        return _response(
            request_id,
            call_tool(str(params.get("name", "")), params.get("arguments", {})),
        )
    if method == "resources/list":
        return _response(request_id, {"resources": []})
    if method == "prompts/list":
        return _response(request_id, {"prompts": []})
    if method in {"notifications/initialized", "notifications/cancelled", "logging/setLevel"}:
        return None if not has_request_id else _response(request_id, {})
    if not has_request_id:
        return None
    return _error(request_id, -32601, f"method not found: {method}")


def main() -> int:
    for raw_line in sys.stdin.buffer:
        if not raw_line.strip():
            continue
        try:
            message = json.loads(raw_line)
            if not isinstance(message, dict):
                raise ValueError("request must be a JSON object")
            response = handle_request(message)
        except (json.JSONDecodeError, ValueError) as exc:
            response = _error(None, -32700, f"parse error: {exc}")
        except Exception as exc:  # Keep the STDIO server alive after an unexpected request failure.
            print(f"{SERVER_NAME}: {exc}", file=sys.stderr, flush=True)
            response = _error(message.get("id") if isinstance(message, dict) else None, -32603, "internal error")

        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
