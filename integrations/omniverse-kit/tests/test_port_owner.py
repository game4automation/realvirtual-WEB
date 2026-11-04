# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
"""Port-in-use diagnosis without Kit (plan-637 port collision).

Pure parsers against sample ``netstat`` / ``tasklist`` / ``lsof`` output plus
one real double bind. Plain ``unittest`` (no third-party package needed)::

    python -m unittest discover -s integrations/omniverse-kit/tests -p "test_port_owner.py"

pytest collects it as well.
"""

import os
import socket
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.normpath(os.path.join(HERE, "..", "exts", "realvirtual.livesync"))
if EXT not in sys.path:
    sys.path.insert(0, EXT)

from realvirtual.livesync.port_owner import (  # noqa: E402
    PORT_SETTING,
    bind_error_message,
    describe_owner,
    find_port_owner,
    is_address_in_use,
    parse_lsof_owner,
    parse_netstat_listeners,
    parse_tasklist_image,
    port_in_use_message,
)

NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:8765         0.0.0.0:0              LISTENING       33840
  TCP    127.0.0.1:8765         127.0.0.1:51234        ESTABLISHED     33840
  TCP    127.0.0.1:51234        127.0.0.1:8765         ESTABLISHED     9999
  TCP    127.0.0.1:87650        0.0.0.0:0              LISTENING       4444
  TCP    [::1]:8765             [::]:0                 LISTENING       33840
  TCP    [::]:8790              [::]:0                 LISTENING       5555
  UDP    0.0.0.0:8765           *:*                                    7777
"""

NETSTAT_GERMAN = """
  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    127.0.0.1:8775         0.0.0.0:0              ABHÖREN          4242
"""

TASKLIST_CSV = '"pythonw.exe","33840","Console","1","45.120 K"\r\n'
TASKLIST_NONE = "INFO: No tasks are running which match the specified criteria.\r\n"
TASKLIST_TABLE = "pythonw.exe                  33840 Console                    1     45.120 K\r\n"

LSOF = """COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
python3 12345 kit    7u  IPv4  0x1234      0t0  TCP 127.0.0.1:8775 (LISTEN)
"""


class ParserTests(unittest.TestCase):
    def test_netstat_finds_the_listener_once(self):
        self.assertEqual(parse_netstat_listeners(NETSTAT, 8765), [33840])

    def test_netstat_ignores_other_ports_udp_and_client_sides(self):
        self.assertEqual(parse_netstat_listeners(NETSTAT, 8790), [5555])
        self.assertEqual(parse_netstat_listeners(NETSTAT, 8775), [])
        self.assertEqual(parse_netstat_listeners(NETSTAT, 51234), [])  # ESTABLISHED only

    def test_netstat_localised_state(self):
        self.assertEqual(parse_netstat_listeners(NETSTAT_GERMAN, 8775), [4242])

    def test_netstat_empty(self):
        self.assertEqual(parse_netstat_listeners("", 8775), [])

    def test_tasklist(self):
        self.assertEqual(parse_tasklist_image(TASKLIST_CSV), "pythonw.exe")
        self.assertEqual(parse_tasklist_image(TASKLIST_TABLE), "pythonw.exe")
        self.assertIsNone(parse_tasklist_image(TASKLIST_NONE))

    def test_lsof(self):
        self.assertEqual(parse_lsof_owner(LSOF), ("python3", 12345))
        self.assertIsNone(parse_lsof_owner("COMMAND PID\n"))

    def test_describe_owner(self):
        self.assertEqual(describe_owner("pythonw.exe", 33840), "pythonw.exe (pid 33840)")
        self.assertEqual(describe_owner(None, 33840), "pid 33840")
        self.assertIsNone(describe_owner("x", None))


class FinderTests(unittest.TestCase):
    def test_windows_owner_from_netstat_and_tasklist(self):
        calls = []

        def run(cmd):
            calls.append(cmd)
            if cmd[0] == "netstat":
                return NETSTAT
            if cmd[0] == "tasklist":
                self.assertEqual(cmd[1:3], ["/FI", "PID eq 33840"])
                return TASKLIST_CSV
            raise AssertionError(cmd)

        self.assertEqual(find_port_owner(8765, run=run, platform="win32"), "pythonw.exe (pid 33840)")
        self.assertEqual([c[0] for c in calls], ["netstat", "tasklist"])

    def test_windows_unknown_owner(self):
        self.assertIsNone(find_port_owner(8775, run=lambda cmd: NETSTAT, platform="win32"))

    def test_other_os_lsof(self):
        self.assertEqual(find_port_owner(8775, run=lambda cmd: LSOF, platform="linux"), "python3 (pid 12345)")

    def test_failing_commands_are_none(self):
        def run(cmd):
            raise OSError("no netstat")
        self.assertIsNone(find_port_owner(8775, run=run, platform="win32"))
        self.assertIsNone(find_port_owner(8775, run=run, platform="linux"))


class MessageTests(unittest.TestCase):
    def test_port_in_use_line_names_owner_and_setting(self):
        line = port_in_use_message(8775, "pythonw.exe (pid 33840)")
        self.assertTrue(line.startswith("Port 8775 is taken by pythonw.exe (pid 33840) - change " + PORT_SETTING))
        self.assertIn("another program", port_in_use_message(8775, None))

    def test_bind_error_message_in_use_vs_other(self):
        in_use = OSError(10048, "Only one usage of each socket address is normally permitted")
        self.assertTrue(is_address_in_use(in_use))
        msg = bind_error_message(8775, in_use, finder=lambda port: "pythonw.exe (pid 1)")
        self.assertIn("pythonw.exe (pid 1)", msg)
        self.assertIn(PORT_SETTING, msg)
        other = OSError(13, "Permission denied")
        self.assertFalse(is_address_in_use(other))
        self.assertEqual(bind_error_message(8775, other, finder=lambda port: "never"), "cannot listen on port 8775: [Errno 13] Permission denied")
        self.assertFalse(is_address_in_use(ValueError("address already in use")))

    def test_real_double_bind_is_detected(self):
        a = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            a.bind(("127.0.0.1", 0))
            a.listen(1)
            port = a.getsockname()[1]
            b = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                with self.assertRaises(OSError) as ctx:
                    b.bind(("127.0.0.1", port))
                self.assertTrue(is_address_in_use(ctx.exception), repr(ctx.exception))
            finally:
                b.close()
        finally:
            a.close()


if __name__ == "__main__":
    unittest.main()
