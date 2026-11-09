"""Emit a real summary for a local cron job; no external messages are sent."""

import argparse
import asyncio
import json

from pydantic import ValidationError

from health_agent.bridge import BridgeSettings, HealthClient, HealthServiceError


async def daily_report(day: str | None, client: HealthClient) -> str:
    summary = await client.request("GET", "/v1/summary", params={"day": day} if day else None)
    return json.dumps(summary, ensure_ascii=False, indent=2)


def run():
    parser = argparse.ArgumentParser(description="读取真实数据，输出每日健康汇总 JSON")
    parser.add_argument("--day", help="YYYY-MM-DD；默认使用个人时区的今天")
    args = parser.parse_args()
    try:
        print(asyncio.run(daily_report(args.day, HealthClient(BridgeSettings()))))
    except ValidationError:
        parser.exit(2, "配置错误：检查 HEALTH_API_URL 和 HEALTH_API_TOKEN。\n")
    except HealthServiceError as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    run()
