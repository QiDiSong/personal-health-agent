#!/usr/bin/env python3
"""Upload an already normalized Apple Health daily snapshot, never device samples."""

import argparse
import ipaddress
import json
import math
import os
import re
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv

MAX_FILE_BYTES = 1024 * 1024
METRIC_BOUNDS = {
    "weight_kg": (1, 500),
    "steps": (0, 200000),
    "active_energy_kcal": (0, 30000),
    "sleep_minutes": (0, 1440),
    "resting_heart_rate_bpm": (20, 250),
    "workout_minutes": (0, 1440),
}


def endpoint_url(base_url: str) -> str:
    """Require TLS for health data except on the local machine."""
    try:
        if any(
            character.isspace() or ord(character) < 32 or ord(character) == 127
            for character in base_url
        ):
            raise ValueError
        parts = urlsplit(base_url)
        host = parts.hostname
        # Accessing port also rejects malformed or out-of-range ports.
        _ = parts.port
        if (
            parts.scheme not in {"http", "https"}
            or not host
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
        ):
            raise ValueError
        is_local = host.lower() == "localhost"
        try:
            is_local = is_local or ipaddress.ip_address(host).is_loopback
        except ValueError:
            pass
        if parts.scheme == "http" and not is_local:
            raise ValueError
        httpx.URL(base_url)
    except (ValueError, httpx.InvalidURL, UnicodeError):
        raise ValueError(
            "HEALTH_API_URL must be an HTTPS base URL without credentials, query, or fragment; "
            "HTTP is allowed only for localhost or a loopback IP."
        ) from None
    return base_url.rstrip("/") + "/v1/sync"


def unique_object(pairs):
    """Reject ambiguous JSON instead of silently choosing the last repeated key."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError


def read_snapshot(path: Path) -> dict:
    try:
        with path.open("rb") as source:
            content = source.read(MAX_FILE_BYTES + 1)
    except OSError:
        raise ValueError("Cannot read snapshot file; check the path and permissions.") from None
    try:
        if len(content) > MAX_FILE_BYTES:
            raise ValueError
        payload = json.loads(
            content.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
        if not isinstance(payload, dict) or set(payload) != {"source", "observations"}:
            raise ValueError
        if payload["source"] != "apple_health":
            raise ValueError
        observations = payload["observations"]
        if not isinstance(observations, list) or not 1 <= len(observations) <= 1000:
            raise ValueError
        seen = set()
        for observation in observations:
            if not isinstance(observation, dict) or set(observation) != {"date", "metric", "value"}:
                raise ValueError
            day, metric, value = (observation["date"], observation["metric"], observation["value"])
            if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                raise ValueError
            if not 1900 <= date.fromisoformat(day).year <= 9998:
                raise ValueError
            if not isinstance(metric, str) or metric not in METRIC_BOUNDS:
                raise ValueError
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError
            minimum, maximum = METRIC_BOUNDS[metric]
            if not math.isfinite(value) or not minimum <= value <= maximum:
                raise ValueError
            if metric == "steps" and value != int(value):
                raise ValueError
            key = (day, metric)
            if key in seen:
                raise ValueError
            seen.add(key)
    except (ValueError, TypeError, OverflowError, RecursionError):
        raise ValueError(
            "Invalid snapshot: expected UTF-8 JSON under 1 MiB, source apple_health, and "
            "1–1000 unique daily metric observations with valid dates, units, and values."
        ) from None
    return payload


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, help="normalized daily snapshot JSON file")
    arguments = parser.parse_args(argv)
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    token = os.environ.get("HEALTH_API_TOKEN", "")
    if len(token) < 32 or any(not 33 <= ord(character) <= 126 for character in token):
        print(
            "HEALTH_API_TOKEN must contain at least 32 printable ASCII characters without whitespace.",
            file=sys.stderr,
        )
        return 2
    try:
        endpoint = endpoint_url(os.environ.get("HEALTH_API_URL", "http://127.0.0.1:8000"))
        payload = read_snapshot(arguments.snapshot)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    try:
        with httpx.Client(timeout=30, follow_redirects=False) as client:
            response = client.post(
                endpoint, json=payload, headers={"Authorization": f"Bearer {token}"}
            )
    except httpx.HTTPError:
        print(
            "Sync network connection failed; check server reachability and HTTPS certificates.",
            file=sys.stderr,
        )
        return 1
    if not 200 <= response.status_code < 300:
        print(
            f"Sync failed (HTTP {response.status_code}); response content was withheld.",
            file=sys.stderr,
        )
        return 1
    print(f"Synced {len(payload['observations'])} daily observations.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
