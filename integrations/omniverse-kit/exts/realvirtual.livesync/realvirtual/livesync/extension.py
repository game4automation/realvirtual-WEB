# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""Kit entry point of realvirtual Live Sync (plan-637 Phase 2).

Wires the pure modules into Kit:

* ``LiveSyncServer`` runs in Kit's asyncio loop (``omni.kit.async_engine``),
* ``UsdStageAdapter`` writes into ``omni.usd.get_context().get_stage()``,
* ``apply_pending`` runs once per app update (update event stream),
* a small panel shows port, token, connection and rate.

Settings (``carb.settings``, e.g. ``--/exts/realvirtual.livesync/port=8776``):

* ``/exts/realvirtual.livesync/port`` (default 8775; 8765 before 2026-10-21 -
  it collided with other local services). The viewer's port (USD > Settings)
  must be the same value. A taken port is logged once with the owning process.
* ``/exts/realvirtual.livesync/allowed_origins`` (list of glob patterns)
* ``/exts/realvirtual.livesync/token`` (default: generated once and stored in
  ``~/.realvirtual/livesync-token.txt``)
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets

import carb
import carb.settings
import omni.ext
import omni.kit.app
import omni.usd

from .panel import LiveSyncPanel
from .port_owner import bind_error_message
from .protocol import DEFAULT_PORT
from .server import DEFAULT_ALLOWED_ORIGINS, LOGGER_NAME, LiveSyncServer
from .stage_usd import UsdStageAdapter


class CarbLogHandler(logging.Handler):
    """Forwards the ``realvirtual.livesync`` logger to the Kit log (``carb.log_*``)."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            text = "[realvirtual.livesync] " + self.format(record)
            if record.levelno >= logging.ERROR:
                carb.log_error(text)
            elif record.levelno >= logging.WARNING:
                carb.log_warn(text)
            else:
                carb.log_info(text)
        except Exception:  # noqa: BLE001 - logging must never break the extension
            pass


def _attach_log_handler() -> None:
    """One carb handler on the extension logger (idempotent across reloads).

    It stays attached after shutdown so the server's last lines ("server
    stopped") still reach the Kit log.
    """
    logger = logging.getLogger(LOGGER_NAME)
    for h in list(logger.handlers):
        if h.__class__.__name__ == "CarbLogHandler":
            logger.removeHandler(h)
    handler = CarbLogHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False  # Kit's own Python-logging bridge would print it twice

SETTINGS_ROOT = "/exts/realvirtual.livesync"
TOKEN_FILE = os.path.join(os.path.expanduser("~"), ".realvirtual", "livesync-token.txt")


def load_or_create_token(path: str = TOKEN_FILE) -> str:
    """The persistent access token (generated on first use)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            token = f.read().strip()
            if token:
                return token
    except OSError:
        pass
    return regenerate_token(path)


def regenerate_token(path: str = TOKEN_FILE) -> str:
    token = secrets.token_urlsafe(12)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(token)
    return token


def _run(coro):
    try:
        from omni.kit.async_engine import run_coroutine
        return run_coroutine(coro)
    except ImportError:
        return asyncio.ensure_future(coro)


class RealvirtualLiveSyncExtension(omni.ext.IExt):
    def on_startup(self, ext_id):
        _attach_log_handler()
        settings = carb.settings.get_settings()
        port = settings.get(SETTINGS_ROOT + "/port") or DEFAULT_PORT
        origins = settings.get(SETTINGS_ROOT + "/allowed_origins") or list(DEFAULT_ALLOWED_ORIGINS)
        token = settings.get(SETTINGS_ROOT + "/token") or load_or_create_token()

        self._adapter = UsdStageAdapter(lambda: omni.usd.get_context().get_stage())
        self._server = LiveSyncServer(lambda: self._adapter, token=token, allowed_origins=origins, port=int(port))
        self._start_task = _run(self._start())
        self._update_sub = (
            omni.kit.app.get_app()
            .get_update_event_stream()
            .create_subscription_to_pop(self._on_update, name="realvirtual.livesync.apply")
        )
        self._panel = LiveSyncPanel(self._server, token, on_regenerate=self._regenerate)

    async def _start(self):
        try:
            await self._server.start()  # logs "listening on ..."
        except OSError as exc:
            # One line: who holds the port and which setting to change (port in use),
            # otherwise the plain bind error.
            self._server.status.last_error = bind_error_message(self._server.port, exc)
            logging.getLogger(LOGGER_NAME).error(self._server.status.last_error)

    def _on_update(self, _event):
        try:
            self._server.apply_pending()
        except Exception as exc:  # noqa: BLE001 - never break the app update
            self._server.status.last_error = str(exc)
            logging.getLogger(LOGGER_NAME).error("apply failed: %s", exc, exc_info=True)
        self._panel.refresh()

    def _regenerate(self) -> str:
        token = regenerate_token()
        self._server.set_token(token)
        return token

    def on_shutdown(self):
        self._update_sub = None
        if getattr(self, "_panel", None):
            self._panel.destroy()
            self._panel = None
        if getattr(self, "_server", None):
            _run(self._server.stop())
