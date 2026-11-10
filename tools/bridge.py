#!/usr/bin/env python3
"""Debug client for the mod's bridge (docs/PROTOCOL.md). Stdlib only.

  bridge.py call <method> ['<json params>']    one request, prints the result as JSON
  bridge.py listen [seconds]                   prints events as they arrive
  bridge.py wait-task <bot> [seconds]          waits until the bot has no active or queued task, prints the last result

Defaults target the local test instance; override with AIPLAYER_BRIDGE_PORT / AIPLAYER_BRIDGE_TOKEN_FILE.
"""
import json
import os
import socket
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("AIPLAYER_BRIDGE_PORT", "25591"))
TOKEN_FILE = os.environ.get(
    "AIPLAYER_BRIDGE_TOKEN_FILE", os.path.join(ROOT, "testserver", "config", "aiplayer", "bridge-token.txt")
)


class Bridge:
    def __init__(self, port=PORT, token_file=TOKEN_FILE, timeout=15.0):
        with open(token_file, encoding="utf-8") as fh:
            token = fh.read().strip()
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.buf = b""
        self.next_id = 0
        self.events = []
        self.hello = self.call("hello", {"token": token, "client": "bridge.py"})

    def _read_line(self, timeout=None):
        if timeout is not None:
            self.sock.settimeout(timeout)
        while b"\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("bridge closed the connection")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line.decode("utf-8"))

    def call(self, method, params=None, timeout=15.0):
        self.next_id += 1
        req = {"id": self.next_id, "method": method, "params": params or {}}
        self.sock.sendall((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
        while True:
            msg = self._read_line(timeout)
            if "event" in msg:
                self.events.append(msg)
                continue
            if msg.get("id") == self.next_id:
                if not msg.get("ok"):
                    err = msg.get("error", {})
                    raise RuntimeError(f"{err.get('code')}: {err.get('message')}")
                return msg.get("result")

    def next_event(self, timeout):
        if self.events:
            return self.events.pop(0)
        try:
            msg = self._read_line(timeout)
        except socket.timeout:
            return None
        return msg if "event" in msg else None

    def wait_task(self, bot, seconds=120.0, poll=0.5):
        """Blocks until the bot is idle; returns the most recently finished task."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            tasks = self.call("task.list", {"bot": bot})
            if tasks["active"] is None and not tasks["queue"]:
                return tasks["recent"][0] if tasks["recent"] else None
            time.sleep(poll)
        raise TimeoutError(f"bot {bot} still busy after {seconds}s")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    b = Bridge()
    if argv[1] == "call":
        params = json.loads(argv[3]) if len(argv) > 3 else {}
        print(json.dumps(b.call(argv[2], params), ensure_ascii=False, indent=1))
    elif argv[1] == "listen":
        deadline = time.time() + (float(argv[2]) if len(argv) > 2 else 1e9)
        while time.time() < deadline:
            ev = b.next_event(min(1.0, max(0.05, deadline - time.time())))
            if ev:
                print(json.dumps(ev, ensure_ascii=False), flush=True)
    elif argv[1] == "wait-task":
        print(json.dumps(b.wait_task(argv[2], float(argv[3]) if len(argv) > 3 else 120.0), ensure_ascii=False, indent=1))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (RuntimeError, OSError, TimeoutError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
