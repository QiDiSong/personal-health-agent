import json

import httpx

from health_agent.bridge import BridgeSettings, HealthClient
from health_agent.report import daily_report


async def test_report_fetches_summary_without_inventing_missing_data():
    summary = {
        "date": "2026-11-09",
        "metrics": {"weight_kg": None},
        "nutrition": {"calories_kcal": None},
    }
    client = HealthClient(
        BridgeSettings(api_token="test-token-" + "x" * 32, _env_file=None),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=summary)),
    )
    result = await daily_report("2026-11-09", client)
    assert json.loads(result) == summary
