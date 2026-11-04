# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
"""Who holds a TCP port - for the "port in use" log line (plan-637).

When the server cannot bind its port, the extension logs ONE line that names
the owning process and the setting to change, e.g.::

    Port 8775 is taken by pythonw.exe (pid 33840) - change /exts/realvirtual.livesync/port

The parsers are pure (sample outputs are unit-tested without Kit); only
:func:`find_port_owner` runs commands: ``netstat -ano`` + ``tasklist`` on
Windows, ``lsof`` elsewhere (best effort - None when nothing is found).
"""

from __future__ import annotations

import csv
import errno
import io
import re
import subprocess
import sys
from typing import Callable, List, Optional, Tuple

#: The carb setting that holds the port.
PORT_SETTING = "/exts/realvirtual.livesync/port"

_LISTEN_STATES = ("LISTENING", "ABHÖREN", "ABHOREN", "LISTEN")

Runner = Callable[[List[str]], str]


def is_address_in_use(exc: BaseException) -> bool:
    """True for the bind error "address already in use" (POSIX and Windows)."""
    if not isinstance(exc, OSError):
        return False
    codes = {errno.EADDRINUSE, 10048}  # 10048 = WSAEADDRINUSE
    if exc.errno in codes or getattr(exc, "winerror", None) in codes:
        return True
    text = str(exc).lower()
    return "address already in use" in text or "only one usage of each socket address" in text


def _port_of(address: str) -> Optional[int]:
    """Port of ``127.0.0.1:8775`` / ``[::1]:8775`` / ``*:8775``."""
    m = re.search(r":(\d+)$", address.strip())
    return int(m.group(1)) if m else None


def parse_netstat_listeners(output: str, port: int) -> List[int]:
    """PIDs listening on TCP ``port`` in ``netstat -ano`` output (in order, no duplicates).

    A row looks like ``TCP  127.0.0.1:8775  0.0.0.0:0  LISTENING  33840``; the
    state column is localised on some Windows installs, so a TCP row whose
    remote port is 0 counts as listening too.
    """
    pids: List[int] = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        local, remote, state, pid = parts[1], parts[2], parts[3], parts[-1]
        if _port_of(local) != port:
            continue
        listening = state.upper() in _LISTEN_STATES or _port_of(remote) == 0
        if not listening or not pid.isdigit():
            continue
        n = int(pid)
        if n > 0 and n not in pids:
            pids.append(n)
    return pids


def parse_tasklist_image(output: str) -> Optional[str]:
    """Image name from ``tasklist /FI "PID eq N" /FO CSV /NH`` output (None when none)."""
    for row in csv.reader(io.StringIO(output)):
        if len(row) >= 2 and row[1].strip().isdigit():
            name = row[0].strip()
            if name:
                return name
    # Table format fallback: "pythonw.exe   33840 Console   1   12.345 K"
    for line in output.splitlines():
        m = re.match(r"^(\S+\.\w+)\s+(\d+)\s", line.strip())
        if m:
            return m.group(1)
    return None


def parse_lsof_owner(output: str) -> Optional[Tuple[str, int]]:
    """(command, pid) from ``lsof -nP -iTCP:<port> -sTCP:LISTEN`` output."""
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            return parts[0], int(parts[1])
    return None


def describe_owner(name: Optional[str], pid: Optional[int]) -> Optional[str]:
    """``pythonw.exe (pid 33840)`` / ``pid 33840`` / None."""
    if pid is None:
        return None
    return "%s (pid %d)" % (name, pid) if name else "pid %d" % pid


def port_in_use_message(port: int, owner: Optional[str]) -> str:
    """The one log line for a port that is already taken."""
    who = owner if owner else "another program"
    return "Port %d is taken by %s - change %s and the port in realvirtual WEB (USD > Settings) to the same free port" % (
        port, who, PORT_SETTING,
    )


def bind_error_message(port: int, exc: BaseException, finder: Callable[[int], Optional[str]] = None) -> str:
    """Log line for a failed bind: the owner + setting when the port is taken, else the plain error."""
    if is_address_in_use(exc):
        return port_in_use_message(port, (finder or find_port_owner)(port))
    return "cannot listen on port %d: %s" % (port, exc)


def _run(cmd: List[str]) -> str:
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    out = subprocess.run(cmd, capture_output=True, timeout=5, check=False, **kwargs)
    data = out.stdout or b""
    for enc in ("utf-8", "cp850", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def find_port_owner(port: int, run: Runner = _run, platform: str = sys.platform) -> Optional[str]:
    """``pythonw.exe (pid 33840)`` for the process listening on ``port``, or None (best effort)."""
    try:
        if platform == "win32":
            pids = parse_netstat_listeners(run(["netstat", "-ano", "-p", "TCP"]), port)
            if not pids:
                pids = parse_netstat_listeners(run(["netstat", "-ano"]), port)
            if not pids:
                return None
            pid = pids[0]
            name = parse_tasklist_image(run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"]))
            return describe_owner(name, pid)
        found = parse_lsof_owner(run(["lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN"]))
        return describe_owner(found[0], found[1]) if found else None
    except Exception:  # noqa: BLE001 - diagnosis must never break startup
        return None
