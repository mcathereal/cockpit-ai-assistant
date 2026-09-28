#!/usr/bin/env python3
"""AI Assistant - Host tool server (MCP, Streamable HTTP).

Exposes a small, fixed allowlist of KVM/libvirt host tools as an MCP server so
external agents (Claude, opencode, ...) can use them. It is the counterpart to
the MCP client inside the Cockpit plugin.

Design:
  * stdlib only (http.server + json) - no pip, no build step.
  * JSON-RPC 2.0 over HTTP POST on one endpoint (default /mcp); replies with
    application/json. GET returns a short info page.
  * Read-only by default. Write tools (vm_start/vm_shutdown/vm_stop) are only
    advertised and executed when AI_ASSISTANT_MCP_ALLOW_WRITE=1.
  * Every request must carry  Authorization: Bearer <token>  (unless
    --no-auth is given for local debugging).
  * Tool arguments are validated by regex; subprocess is always started with an
    argv list, never through a shell.

Usage:
  ./mcp-host-server.py --token-file /etc/ai-assistant-mcp/token --port 8765
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "cockpit-ai-assistant-host"
SERVER_VERSION = "1.0.0"
MAX_OUTPUT = 12000
RUN_TIMEOUT = 30

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9@_.:+-]{1,64}$")
READ_PREFIXES = (
    "/var/log/",
    "/etc/libvirt/",
    "/proc/meminfo",
    "/proc/cpuinfo",
    "/proc/loadavg",
    "/etc/os-release",
    "/sys/class/net/",
)

ALLOW_WRITE = os.environ.get("AI_ASSISTANT_MCP_ALLOW_WRITE", "0") == "1"


def _tool(name, title, description, props=None, required=None, write=False):
    return {
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": props or {},
            "required": required or [],
            "additionalProperties": False,
        },
        "_write": write,
    }


READ_TOOLS = [
    _tool("vm_list", "List VMs", "List all libvirt domains (running and stopped)."),
    _tool("vm_info", "VM info", "domin-info for one domain.",
          {"name": {"type": "string", "description": "Domain name"}}, ["name"]),
    _tool("vm_xml", "VM XML", "Filtered `virsh dumpxml` output (identity, cpu, devices, disks, interfaces).",
          {"name": {"type": "string"}}, ["name"]),
    _tool("vm_snapshots", "VM snapshots", "snapshot-list for one domain.",
          {"name": {"type": "string"}}, ["name"]),
    _tool("vm_console_log", "VM console log", "Last lines of /var/log/libvirt/qemu/<name>.log.",
          {"name": {"type": "string"}, "tail": {"type": "integer", "minimum": 1, "maximum": 200}}, ["name"]),
    _tool("journal", "Journal", "journalctl for one unit (no pager).",
          {"unit": {"type": "string"}, "tail": {"type": "integer", "minimum": 1, "maximum": 300}}, ["unit"]),
    _tool("dmesg", "Kernel log", "Kernel errors and warnings (dmesg --level=err,warn -T).",
          {"tail": {"type": "integer", "minimum": 1, "maximum": 300}}),
    _tool("read_file", "Read log file", "Tail a file from the read allowlist (logs, /proc, /sys, libvirt config).",
          {"path": {"type": "string"}, "tail": {"type": "integer", "minimum": 1, "maximum": 200}}, ["path"]),
    _tool("host_status", "Host status", "RAM, disk, load, IPs, routes and VM list in one call."),
]

WRITE_TOOLS = [
    _tool("vm_start", "Start VM", "Start a domain (virsh start).", {"name": {"type": "string"}}, ["name"], True),
    _tool("vm_shutdown", "Shutdown VM", "Graceful shutdown (virsh shutdown).", {"name": {"type": "string"}}, ["name"], True),
    _tool("vm_stop", "Stop VM (hard)", "Immediate power off (virsh destroy).", {"name": {"type": "string"}}, ["name"], True),
]


def visible_tools():
    return READ_TOOLS + (WRITE_TOOLS if ALLOW_WRITE else [])


def clamp_int(value, default, low, high):
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(low, min(high, n))


def run(argv):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=RUN_TIMEOUT)
    except FileNotFoundError:
        return "FEHLER: Befehl nicht gefunden: %s" % argv[0]
    except subprocess.TimeoutExpired:
        return "FEHLER: Zeitueberschreitung"
    out = (p.stdout or "") + (p.stderr or "")
    return out[:MAX_OUTPUT] or "(keine Ausgabe)"


def tail(text, n):
    lines = text.splitlines()
    return "\n".join(lines[-n:]) if len(lines) > n else text


def check_name(name):
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ValueError("Ungueltiger Domain-Name")
    return name


def check_path(path):
    if not isinstance(path, str) or ".." in path:
        raise ValueError("Ungueltiger Pfad")
    if not any(path.startswith(p) for p in READ_PREFIXES):
        raise ValueError("Pfad nicht erlaubt")
    return path


def call_tool(name, args):
    args = args or {}
    if name == "vm_list":
        return run(["virsh", "list", "--all"])
    if name == "vm_info":
        return run(["virsh", "dominfo", check_name(args.get("name"))])
    if name == "vm_xml":
        raw = run(["virsh", "dumpxml", check_name(args.get("name"))])
        keep = ("<name>", "<uuid>", "<memory", "<vcpu", "<os ", "<features", "<cpu>", "<on_",
                "<clock", "<interface", "<source", "<target", "<disk", "<driver", "<hostdev",
                "<channel", "<guest_agent", "<memballoon")
        lines = [l for l in raw.splitlines() if any(k in l for k in keep)]
        return "\n".join(lines) or raw[:3000]
    if name == "vm_snapshots":
        return run(["virsh", "snapshot-list", check_name(args.get("name")), "--hlm"])
    if name == "vm_console_log":
        dom = check_name(args.get("name"))
        return read_file("/var/log/libvirt/qemu/%s.log" % dom, clamp_int(args.get("tail"), 120, 1, 200))
    if name == "journal":
        unit = args.get("unit")
        if not isinstance(unit, str) or not UNIT_RE.match(unit):
            raise ValueError("Ungueltiger Unit-Name")
        return run(["journalctl", "-u", unit, "--no-pager", "-n", str(clamp_int(args.get("tail"), 150, 1, 300))])
    if name == "dmesg":
        return tail(run(["dmesg", "--level=err,warn", "-T"]), clamp_int(args.get("tail"), 100, 1, 300))
    if name == "read_file":
        return read_file(check_path(args.get("path")), clamp_int(args.get("tail"), 120, 1, 200))
    if name == "host_status":
        parts = [
            "== RAM ==\n" + run(["free", "-h"]),
            "== DISK ==\n" + run(["df", "-h", "--total", "--exclude-type=tmpfs", "--exclude-type=devtmpfs"]),
            "== UPTIME/LOAD ==\n" + run(["uptime"]),
            "== IP (brief) ==\n" + run(["ip", "-brief", "addr", "show"]),
            "== ROUTE ==\n" + run(["ip", "route", "show"]),
            "== VMs ==\n" + run(["virsh", "list", "--all"]),
        ]
        return "\n\n".join(parts)
    if name in ("vm_start", "vm_shutdown", "vm_stop"):
        if not ALLOW_WRITE:
            raise ValueError("Schreib-Tools sind deaktiviert (AI_ASSISTANT_MCP_ALLOW_WRITE=1 setzen)")
        verb = {"vm_start": "start", "vm_shutdown": "shutdown", "vm_stop": "destroy"}[name]
        return run(["virsh", verb, check_name(args.get("name"))])
    raise ValueError("Unbekanntes Tool: %s" % name)


def read_file(path, n):
    try:
        with open(path, "r", errors="replace") as fh:
            return tail(fh.read(), n)
    except OSError as exc:
        return "FEHLER: %s" % exc


def rpc_result(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def rpc_error(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def handle_rpc(msg):
    method = msg.get("method")
    rid = msg.get("id")
    if method == "initialize":
        return rpc_result(rid, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method in ("notifications/initialized", "initialized"):
        return None
    if method == "ping":
        return rpc_result(rid, {})
    if method == "tools/list":
        tools = [{k: v for k, v in t.items() if not k.startswith("_")} for t in visible_tools()]
        return rpc_result(rid, {"tools": tools})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        tool = next((t for t in visible_tools() if t["name"] == name), None)
        if not tool:
            return rpc_error(rid, -32602, "Unbekanntes Tool: %s" % name)
        try:
            text = call_tool(name, params.get("arguments"))
            is_error = text.startswith("FEHLER:")
        except ValueError as exc:
            return rpc_result(rid, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
        except Exception as exc:  # noqa: BLE001
            return rpc_result(rid, {"content": [{"type": "text", "text": "FEHLER: %s" % exc}], "isError": True})
        return rpc_result(rid, {"content": [{"type": "text", "text": text}], "isError": is_error})
    return rpc_error(rid, -32601, "Methode nicht unterstuetzt: %s" % method)


class Handler(BaseHTTPRequestHandler):
    server_version = "%s/%s" % (SERVER_NAME, SERVER_VERSION)
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mcp] %s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        if payload is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _authorized(self):
        if self.server.token is None:
            return True
        header = self.headers.get("Authorization", "")
        return header == "Bearer " + self.server.token

    def _drain(self):
        """Read and discard the request body so keep-alive stays in sync."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 0:
                self.rfile.read(length)
        except Exception:
            pass

    def do_GET(self):
        self._send(200, {
            "name": SERVER_NAME,
            "version": SERVER_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "tools": [t["name"] for t in visible_tools()],
            "transport": "Streamable HTTP (POST JSON-RPC to this path)",
            "writeEnabled": ALLOW_WRITE,
        })

    def do_POST(self):
        if not self._authorized():
            self._drain()
            self.close_connection = True
            body = json.dumps({"error": "unauthorized"}).encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Connection", "close")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            self._send(400, {"error": "invalid JSON"})
            return
        batch = isinstance(data, list)
        msgs = data if batch else [data]
        out = []
        for msg in msgs:
            if not isinstance(msg, dict):
                continue
            res = handle_rpc(msg)
            if res is not None:
                out.append(res)
        if not out:
            self._send(202)
            return
        self._send(200, out if batch else out[0])


def main(argv):
    port = 8765
    bind = "0.0.0.0"
    token = os.environ.get("AI_ASSISTANT_MCP_TOKEN")
    token_file = None
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--port" and args:
            port = int(args.pop(0))
        elif a == "--bind" and args:
            bind = args.pop(0)
        elif a == "--token-file" and args:
            token_file = args.pop(0)
        elif a == "--no-auth":
            token = None
            token_file = None
        elif a in ("-h", "--help"):
            print(__doc__)
            return 0
    if token_file:
        try:
            with open(token_file) as fh:
                token = fh.read().strip()
        except OSError as exc:
            print("Token-Datei nicht lesbar: %s" % exc, file=sys.stderr)
            return 1
    srv = ThreadingHTTPServer((bind, port), Handler)
    srv.token = token
    srv.daemon_threads = True
    print("%s %s on http://%s:%d/  (auth: %s, write: %s)" % (
        SERVER_NAME, SERVER_VERSION, bind, port,
        "on" if token else "OFF", "on" if ALLOW_WRITE else "off"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))