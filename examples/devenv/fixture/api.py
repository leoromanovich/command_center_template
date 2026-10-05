"""Small loopback-only PostgreSQL round-trip fixture for the CC runtime contract."""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import psycopg


LABEL = Path(__file__).with_name("label.txt").read_text().strip()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path not in ("/health", "/value"):
            self.reply(404, {"error": "unknown path"})
            return
        with psycopg.connect("") as connection:
            if self.path == "/health":
                connection.execute("SELECT 1").fetchone()
                self.reply(200, {"label": LABEL})
            else:
                row = connection.execute("SELECT value FROM pilot WHERE id = 1").fetchone()
                self.reply(200, {"value": row[0] if row else None})

    def do_POST(self):
        if self.path != "/value":
            self.reply(404, {"error": "unknown path"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("invalid body size")
            value = json.loads(self.rfile.read(length))["value"]
            if not isinstance(value, str):
                raise ValueError("value must be a string")
        except (ValueError, KeyError, TypeError):
            self.reply(400, {"error": "expected a short JSON string value"})
            return
        with psycopg.connect("") as connection:
            connection.execute(
                "INSERT INTO pilot VALUES (1, %s) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value",
                (value,),
            )
        self.reply(200, {"value": value})


if __name__ == "__main__":
    with psycopg.connect("") as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS pilot (id integer PRIMARY KEY, value text NOT NULL)")
    HTTPServer(("127.0.0.1", int(os.environ["PILOT_PORT"])), Handler).serve_forever()
