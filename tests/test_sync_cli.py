"""Exercise the actual sync command against a disposable HTTP endpoint."""

import copy
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "sync_health.py"
TOKEN = "test-only-token-12345678901234567890"
SNAPSHOT = {
    "source": "apple_health",
    "observations": [{"date": "2026-11-09", "metric": "steps", "value": 1234}],
}


@pytest.fixture
def endpoint():
    requests = []
    response = {"status": 200, "body": b'{"accepted": 1}', "headers": {}}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append((self.path, self.headers.get("Authorization"), json.loads(body)))
            self.send_response(response["status"])
            for key, value in response["headers"].items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(response["body"])

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests, response
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def run_cli(
    tmp_path, *, payload=SNAPSHOT, url=None, token=TOKEN, raw=None, path=None, script=SCRIPT
):
    if path is None:
        path = tmp_path / "daily.json"
        path.write_text(json.dumps(payload) if raw is None else raw, encoding="utf-8")
    env = os.environ.copy()
    env.pop("HEALTH_API_TOKEN", None)
    env.pop("HEALTH_API_URL", None)
    if script == SCRIPT:
        # Do not read another worker's private project configuration during tests.
        env["PYTHON_DOTENV_DISABLED"] = "1"
    else:
        env.pop("PYTHON_DOTENV_DISABLED", None)
    # The CLI honors production proxy/CA configuration. These tests connect directly
    # to an isolated local fixture rather than the execution environment's proxy.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    if token is not None:
        env["HEALTH_API_TOKEN"] = token
    if url is not None:
        env["HEALTH_API_URL"] = url
    return subprocess.run(
        [sys.executable, str(script), str(path)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )


@pytest.mark.parametrize("explicit_token", [None, TOKEN])
def test_loads_project_dotenv_without_overriding_environment(tmp_path, endpoint, explicit_token):
    url, requests, _ = endpoint
    project = tmp_path / "private-project"
    (project / "scripts").mkdir(parents=True)
    copied_script = project / "scripts" / "sync_health.py"
    assert SCRIPT.exists(), "The sync CLI must exist before it can load project configuration"
    shutil.copyfile(SCRIPT, copied_script)
    file_token = "dotenv-only-test-token-12345678901234567890"
    (project / ".env").write_text(
        f"HEALTH_API_URL={url}\nHEALTH_API_TOKEN={file_token}\n", encoding="utf-8"
    )
    result = run_cli(tmp_path, url=None, token=explicit_token, script=copied_script)
    assert result.returncode == 0, result.stderr
    expected_token = explicit_token or file_token
    assert requests == [("/v1/sync", f"Bearer {expected_token}", SNAPSHOT)]


def test_posts_normalized_snapshot_with_bearer_authentication(tmp_path, endpoint):
    url, requests, _ = endpoint
    result = run_cli(tmp_path, url=url + "/")
    assert result.returncode == 0, result.stderr
    assert requests == [("/v1/sync", f"Bearer {TOKEN}", SNAPSHOT)]
    assert "1" in result.stdout
    assert TOKEN not in result.stdout + result.stderr


@pytest.mark.parametrize(
    "token", [None, "", "too-short", "x" * 32 + "\n", "x" * 32 + "秘密", "x" * 32 + "\x01"]
)
def test_rejects_missing_or_invalid_token_before_network(tmp_path, endpoint, token):
    url, requests, _ = endpoint
    result = run_cli(tmp_path, url=url, token=token)
    assert result.returncode != 0
    assert "HEALTH_API_TOKEN" in result.stderr
    assert requests == []
    if token:
        assert token not in result.stdout + result.stderr


INVALID_PAYLOADS = [
    [],
    {"source": "apple_health", "observations": []},
    {"source": "watch_raw_samples", "observations": SNAPSHOT["observations"]},
    {"source": "apple_health", "observations": "1234"},
    {
        "source": "apple_health",
        "observations": [{"date": "2026-02-30", "metric": "steps", "value": 1}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09T00:00:00", "metric": "steps", "value": 1}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "1899-12-31", "metric": "steps", "value": 1}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "9999-01-01", "metric": "steps", "value": 1}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09", "metric": "blood_glucose", "value": 1}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09", "metric": "steps", "value": -1}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09", "metric": "steps", "value": True}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09", "metric": "steps", "value": "1234"}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09", "metric": "steps", "value": None}],
    },
    {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09", "metric": "steps", "value": float("inf")}],
    },
    {"source": "apple_health", "observations": SNAPSHOT["observations"] * 2},
    {**SNAPSHOT, "raw_samples": [{"private": "must-not-be-sent"}]},
]


@pytest.mark.parametrize("payload", INVALID_PAYLOADS)
def test_rejects_invalid_snapshot_without_sending_any_data(tmp_path, endpoint, payload):
    url, requests, _ = endpoint
    result = run_cli(tmp_path, url=url, payload=payload)
    assert result.returncode != 0
    assert "snapshot" in result.stderr.lower()
    assert requests == []
    assert "must-not-be-sent" not in result.stderr + result.stdout


@pytest.mark.parametrize("raw", ['{"source":', '{"source":"apple_health","source":"other"}', "NaN"])
def test_rejects_malformed_or_ambiguous_json(tmp_path, endpoint, raw):
    url, requests, _ = endpoint
    result = run_cli(tmp_path, url=url, raw=raw)
    assert result.returncode != 0
    assert "snapshot" in result.stderr.lower()
    assert requests == []


def test_missing_input_file_is_reported_without_traceback(tmp_path, endpoint):
    url, requests, _ = endpoint
    result = run_cli(tmp_path, url=url, path=tmp_path / "missing.json")
    assert result.returncode != 0
    assert "snapshot file" in result.stderr.lower()
    assert "Traceback" not in result.stderr
    assert requests == []


@pytest.mark.parametrize(
    ("metric", "value"),
    [
        ("weight_kg", 0),
        ("weight_kg", 501),
        ("steps", 200001),
        ("steps", 1.5),
        ("active_energy_kcal", 30001),
        ("sleep_minutes", 1441),
        ("resting_heart_rate_bpm", 19),
        ("resting_heart_rate_bpm", 251),
        ("workout_minutes", 1441),
    ],
)
def test_rejects_values_outside_api_bounds(tmp_path, endpoint, metric, value):
    url, requests, _ = endpoint
    payload = {
        "source": "apple_health",
        "observations": [{"date": "2026-11-09", "metric": metric, "value": value}],
    }
    result = run_cli(tmp_path, url=url, payload=payload)
    assert result.returncode != 0
    assert "snapshot" in result.stderr.lower()
    assert requests == []


def test_rejects_more_than_1000_observations(tmp_path, endpoint):
    url, requests, _ = endpoint
    result = run_cli(
        tmp_path,
        url=url,
        payload={
            "source": "apple_health",
            "observations": SNAPSHOT["observations"] * 1001,
        },
    )
    assert result.returncode != 0
    assert "snapshot" in result.stderr.lower()
    assert requests == []


def test_rejects_oversized_input_file(tmp_path, endpoint):
    url, requests, _ = endpoint
    result = run_cli(tmp_path, url=url, raw=" " * (1024 * 1024 + 1))
    assert result.returncode != 0
    assert "snapshot" in result.stderr.lower()
    assert requests == []


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "http://127.0.0.1.example.com",
        "http://192.168.1.20:8000",
        "http://localhost.example.com",
        "ftp://example.com",
        "https://user:private-url-secret@example.com",
        "https://example.com?token=private-url-secret",
        "https://example.com/#private-url-secret",
        "https://example.com/\x01private-url-secret",
        "https://[not-an-ip]/private-url-secret",
        "not-a-url-private-url-secret",
    ],
)
def test_requires_safe_remote_https_url_without_embedded_secrets(tmp_path, url):
    result = run_cli(tmp_path, url=url)
    assert result.returncode != 0
    assert "HEALTH_API_URL" in result.stderr
    assert "private-url-secret" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize("status", [302, 401, 422, 500])
def test_http_errors_do_not_echo_server_body_or_token(tmp_path, endpoint, status):
    url, requests, response = endpoint
    response.update({"status": status, "body": f"{TOKEN} private-health-value".encode()})
    result = run_cli(tmp_path, url=url)
    assert result.returncode != 0
    assert str(status) in result.stderr
    assert len(requests) == 1
    assert TOKEN not in result.stdout + result.stderr
    assert "private-health-value" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr


def test_redirect_cannot_forward_health_data_to_another_endpoint(tmp_path, endpoint):
    url, requests, response = endpoint
    response.update({"status": 307, "headers": {"Location": url + "/stolen"}})
    result = run_cli(tmp_path, url=url)
    assert result.returncode != 0
    assert len(requests) == 1


def test_network_failure_is_safe_and_actionable(tmp_path):
    result = run_cli(tmp_path, url="http://127.0.0.1:1")
    assert result.returncode != 0
    assert "connect" in result.stderr.lower() or "network" in result.stderr.lower()
    assert TOKEN not in result.stderr + result.stdout
    assert "Traceback" not in result.stderr


def test_https_url_passes_validation_before_network_failure(tmp_path):
    result = run_cli(tmp_path, url="https://127.0.0.1:1")
    assert result.returncode != 0
    assert "network" in result.stderr.lower()
    assert "HEALTH_API_URL" not in result.stderr


def test_all_supported_metrics_are_forwarded_without_adding_missing_values(tmp_path, endpoint):
    url, requests, _ = endpoint
    payload = {
        "source": "apple_health",
        "observations": [
            {"date": "2026-11-09", "metric": "weight_kg", "value": 60.5},
            {"date": "2026-11-09", "metric": "steps", "value": 1234},
            {"date": "2026-11-09", "metric": "active_energy_kcal", "value": 225.5},
            {"date": "2026-11-09", "metric": "sleep_minutes", "value": 420},
            {"date": "2026-11-09", "metric": "resting_heart_rate_bpm", "value": 65},
            {"date": "2026-11-09", "metric": "workout_minutes", "value": 20},
        ],
    }
    original = copy.deepcopy(payload)
    result = run_cli(tmp_path, url=url, payload=payload)
    assert result.returncode == 0, result.stderr
    assert requests[0][2] == original
