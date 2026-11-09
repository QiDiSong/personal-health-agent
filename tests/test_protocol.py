"""Real official SDK clients across stdio and authenticated HTTP, backed by a real API."""

import json
import os
import socket
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from health_agent.api import create_app
from health_agent.bridge import BridgeSettings
from health_agent.config import Settings
from health_agent.mcp_server import create_http_app

API_TOKEN = "protocol-api-token-" + "a" * 32
MCP_TOKEN = "protocol-mcp-token-" + "b" * 32


@contextmanager
def serving(app):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started, "test server did not start"
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()


@pytest.fixture
def api_url(tmp_path):
    app = create_app(
        Settings(
            api_token=API_TOKEN, database_url=f"sqlite:///{tmp_path}/protocol.db", _env_file=None
        )
    )
    with serving(app) as url:
        yield url
    app.state.engine.dispose()


async def exercise_session(session):
    await session.initialize()
    tools = await session.list_tools()
    assert len(tools.tools) == 9
    private = "synthetic-private-health-value"
    invalid = await session.call_tool(
        "record_meal",
        {
            "meal": {
                "eaten_at": "2026-11-09T12:00:00+08:00",
                "description": "测试",
                "calories_kcal": private,
                "client_request_id": "invalid-payload",
            }
        },
    )
    assert invalid.isError
    assert private not in str(invalid)
    created = await session.call_tool(
        "record_meal",
        {
            "meal": {
                "eaten_at": "2026-11-09T12:00:00+08:00",
                "description": "测试记录",
                "calories_kcal": 600,
                "client_request_id": "protocol-lunch",
            }
        },
    )
    assert not created.isError
    synced = await session.call_tool(
        "sync_health",
        {
            "snapshot": {
                "source": "apple_health",
                "observations": [{"date": "2026-11-09", "metric": "steps", "value": 6500}],
            }
        },
    )
    assert not synced.isError
    result = await session.call_tool("get_daily_summary", {"day": "2026-11-09"})
    assert not result.isError
    data = json.loads(result.content[0].text)
    assert data["nutrition"]["calories_kcal"] == 600
    assert data["nutrition"]["protein_g"] is None
    assert data["metrics"]["steps"] == 6500
    assert data["metrics"]["weight_kg"] is None
    assert data["sources"]["steps"] == "apple_health"


async def test_official_stdio_client_round_trip(api_url):
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "health_agent.mcp_server"],
        cwd=str(Path(__file__).resolve().parents[1]),
        env={**os.environ, "HEALTH_API_URL": api_url, "HEALTH_API_TOKEN": API_TOKEN},
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await exercise_session(session)


async def test_official_http_client_round_trip(api_url):
    settings = BridgeSettings(
        api_url=api_url, api_token=API_TOKEN, mcp_token=MCP_TOKEN, _env_file=None
    )
    with serving(create_http_app(settings)) as mcp_url:
        async with (
            httpx.AsyncClient(headers={"Authorization": f"Bearer {MCP_TOKEN}"}) as client,
            streamable_http_client(mcp_url + "/mcp", http_client=client) as (read, write, _),
            ClientSession(read, write) as session,
        ):
            await exercise_session(session)
