# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""Panel of realvirtual Live Sync: port, token, connection and rate (plan-637 §2.8)."""

from __future__ import annotations

import time

import omni.ui as ui


class LiveSyncPanel:
    def __init__(self, server, token: str, on_regenerate):
        self._server = server
        self._on_regenerate = on_regenerate
        self._last_refresh = 0.0
        self._window = ui.Window("realvirtual Live Sync", width=360, height=190)
        with self._window.frame:
            with ui.VStack(spacing=6, height=0):
                with ui.HStack(height=22):
                    ui.Label("Port", width=90)
                    self._port = ui.Label("-")
                with ui.HStack(height=22):
                    ui.Label("Access token", width=90)
                    self._token = ui.StringField(read_only=True)
                    self._token.model.set_value(token)
                    ui.Button("New", width=50, clicked_fn=self._regenerate)
                with ui.HStack(height=22):
                    ui.Label("Client", width=90)
                    self._client = ui.Label("not connected")
                with ui.HStack(height=22):
                    ui.Label("Scene", width=90)
                    self._scene = ui.Label("-")
                with ui.HStack(height=22):
                    ui.Label("Updates", width=90)
                    self._rate = ui.Label("-")
                self._error = ui.Label("", word_wrap=True, style={"color": 0xFF5050EF})
        self.refresh(force=True)

    def _regenerate(self):
        self._token.model.set_value(self._on_regenerate())

    def refresh(self, force: bool = False):
        now = time.monotonic()
        if not force and now - self._last_refresh < 0.25:
            return
        self._last_refresh = now
        st = self._server.status
        self._port.text = ("ws://127.0.0.1:%d" % st.port) if st.listening else ("port %d (not listening)" % st.port)
        self._client.text = st.client_origin or "not connected"
        self._scene.text = ("session %d · %d nodes · %d templates" % (st.session, st.nodes, st.templates)) if st.session else "-"
        self._rate.text = "%.0f Hz applied" % st.applied_hz
        self._error.text = st.last_error or ""

    def destroy(self):
        if self._window:
            self._window.destroy()
            self._window = None
