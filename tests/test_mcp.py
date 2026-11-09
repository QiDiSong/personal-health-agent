import json

import httpx
import pytest
from pydantic import ValidationError

from health_agent.bridge import BridgeSettings, HealthClient, HealthServiceError
from health_agent.mcp_server import build_mcp, create_http_app

TOKEN = "test-health-token-" + "x" * 32


def settings(**overrides):
    return BridgeSettings(api_token=TOKEN, _env_file=None, **overrides)


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "https://user:pw@example.com",
        "https://example.com/?token=x",
        "http://127.0.0.1:99999",
        "https://example.com\n/path",
    ],
)
def test_bridge_refuses_unsafe_remote_urls(url):
    with pytest.raises(ValidationError):
        settings(api_url=url)


@pytest.mark.parametrize("token", ["x" * 32 + "\n", "x" * 32 + " 空", "中" * 32])
def test_tokens_must_fit_an_http_bearer_header(token):
    with pytest.raises(ValidationError):
        BridgeSettings(api_token=token, _env_file=None)


async def test_tool_discovery_and_auth_forwarding():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"date": "2026-11-09", "metrics": {"steps": 5000}})

    client = HealthClient(settings(), transport=httpx.MockTransport(handler))
    mcp = build_mcp(settings(), client=client)
    tools = {tool.name: tool for tool in await mcp.list_tools()}
    assert len(tools) == 9
    assert tools["get_daily_summary"].annotations.readOnlyHint is True
    assert tools["delete_meal"].annotations.destructiveHint is True
    assert tools["record_meal"].annotations.idempotentHint is True
    result = await mcp.call_tool("get_daily_summary", {"day": "2026-11-09"})
    assert "5000" in str(result)
    assert requests[0].url.path == "/v1/summary"
    assert requests[0].url.params["day"] == "2026-11-09"
    assert requests[0].headers["authorization"] == f"Bearer {TOKEN}"


async def test_record_meal_preserves_unknown_macros_and_retry_key():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(201, json={"id": 1, **seen[-1]})

    mcp = build_mcp(
        settings(), client=HealthClient(settings(), transport=httpx.MockTransport(handler))
    )
    await mcp.call_tool(
        "record_meal",
        {
            "meal": {
                "eaten_at": "2026-11-09T12:00:00+08:00",
                "description": "午餐",
                "calories_kcal": 600,
                "client_request_id": "lunch-20261109",
            }
        },
    )
    assert seen[0]["client_request_id"] == "lunch-20261109"
    assert seen[0].get("protein_g") is None


@pytest.mark.parametrize("status", [401, 409, 422, 500])
async def test_bridge_never_exposes_response_secrets(status):
    client = HealthClient(
        settings(),
        transport=httpx.MockTransport(lambda request: httpx.Response(status, text=TOKEN)),
    )
    with pytest.raises(HealthServiceError) as exc:
        await client.request("GET", "/v1/profile")
    assert TOKEN not in str(exc.value)
    assert str(status) in str(exc.value)


async def test_bridge_refuses_redirects():
    client = HealthClient(
        settings(),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(307, headers={"location": "https://other.example"})
        ),
    )
    with pytest.raises(HealthServiceError):
        await client.request("GET", "/v1/profile")


async def test_mcp_validation_errors_do_not_echo_private_input():
    private = "synthetic-private-health-value"
    mcp = build_mcp(settings())
    with pytest.raises(Exception) as error:
        await mcp.call_tool(
            "record_meal",
            {
                "meal": {
                    "eaten_at": "2026-11-09T12:00:00+08:00",
                    "description": "午餐",
                    "calories_kcal": private,
                    "client_request_id": "validation-error",
                }
            },
        )
    assert private not in str(error.value)


async def test_mcp_advertises_database_compatible_record_id_bounds():
    mcp = build_mcp(settings())
    tools = {tool.name: tool for tool in await mcp.list_tools()}
    for name in ("update_meal", "delete_meal"):
        schema = tools[name].inputSchema["properties"]["meal_id"]
        assert schema["minimum"] == 1
        assert schema["maximum"] == 2147483647


def test_http_transport_requires_distinct_strong_token():
    with pytest.raises(ValueError):
        create_http_app(settings())
    with pytest.raises(ValueError):
        create_http_app(settings(mcp_token=TOKEN))


async def test_http_transport_authenticates_before_protocol_dispatch():
    app = create_http_app(settings(mcp_token="separate-mcp-token-" + "y" * 32))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        for path in ["/mcp", "/mcp/"]:
            response = await client.post(
                path, json={"jsonrpc": "2.0", "method": "initialize", "id": 1}
            )
            assert response.status_code == 401
            assert response.headers["www-authenticate"] == "Bearer"
