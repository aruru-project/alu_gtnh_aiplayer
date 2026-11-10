#!/usr/bin/env python3
"""Minimal Minecraft RCON client (stdlib only).

Usage: rcon.py [--host H] [--port P] --password-file FILE command...
"""
import argparse
import socket
import struct
import sys


def _send(sock, req_id, kind, body):
    payload = struct.pack("<ii", req_id, kind) + body.encode("utf-8") + b"\x00\x00"
    sock.sendall(struct.pack("<i", len(payload)) + payload)


def _recv(sock):
    def read(n):
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("rcon connection closed")
            buf += chunk
        return buf

    (length,) = struct.unpack("<i", read(4))
    data = read(length)
    req_id, kind = struct.unpack("<ii", data[:8])
    return req_id, kind, data[8:-2].decode("utf-8", "replace")


def run(host, port, password, command, timeout=10.0):
    with socket.create_connection((host, port), timeout=timeout) as sock:
        _send(sock, 1, 3, password)
        req_id, _, _ = _recv(sock)
        if req_id == -1:
            raise PermissionError("rcon authentication failed")
        _send(sock, 2, 2, command)
        _, _, body = _recv(sock)
        return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=25576)
    ap.add_argument("--password-file", required=True)
    ap.add_argument("command", nargs="+")
    args = ap.parse_args()
    with open(args.password_file, encoding="utf-8") as fh:
        password = fh.read().strip()
    try:
        print(run(args.host, args.port, password, " ".join(args.command)))
    except (OSError, PermissionError) as exc:
        print(f"rcon error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
