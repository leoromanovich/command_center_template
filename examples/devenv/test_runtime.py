"""Runtime acceptance: database round-trip and optional concurrent-feature barrier."""

import json
import os
import time
from pathlib import Path
from urllib.request import Request, urlopen


def request(path, value=None):
    data = None if value is None else json.dumps({"value": value}).encode()
    req = Request(f"http://127.0.0.1:{os.environ['PILOT_PORT']}{path}", data=data,
                  headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=5) as response:
        return json.load(response)


instance = os.environ["PILOT_INSTANCE"]
report = {
    "instance": instance,
    "label": request("/health")["label"],
    "api_port": int(os.environ["PILOT_PORT"]),
    "pg_port": int(os.environ["PGPORT"]),
    "pgdata": os.environ["PGDATA"],
}
assert request("/value") == {"value": None}, "test database must start empty"
assert request("/value", instance) == {"value": instance}
barrier = os.environ.get("PILOT_BARRIER")
if barrier:
    directory = Path(barrier)
    temporary = directory / f"{instance}.tmp"
    temporary.write_text(json.dumps(report))
    temporary.replace(directory / f"{instance}.ready")
    deadline = time.monotonic() + 180
    while len(list(directory.glob("*.ready"))) < 2:
        if time.monotonic() >= deadline:
            raise TimeoutError("second feature did not become ready")
        time.sleep(0.2)
assert request("/value") == {"value": instance}, "another feature modified this database"
Path(os.environ["DEVENV_ROOT"], "report.json").write_text(json.dumps(report))
print(f"API/PostgreSQL round-trip passed: {instance}")
