"""MCP adapters; business rules remain in the authenticated health API."""

import argparse
import secrets
from typing import Annotated
from urllib.parse import urlsplit

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field, ValidationError
from starlette.responses import JSONResponse

from health_agent.bridge import BridgeSettings, HealthClient, HealthServiceError
from health_agent.schemas import MealCreate, MealUpdate, ProfileUpdate, SyncRequest

MealId = Annotated[int, Field(strict=True, ge=1, le=2147483647)]


class PrivateFastMCP(FastMCP):
    async def call_tool(self, name, arguments):
        # The SDK's generated outer argument model otherwise embeds input values in errors.
        try:
            return await super().call_tool(name, arguments)
        except ToolError as error:
            if isinstance(error.__cause__, HealthServiceError):
                raise ToolError(str(error.__cause__)) from None
            raise ToolError("无法执行健康工具，请检查工具名称、日期、单位和输入字段。") from None


def build_mcp(settings: BridgeSettings, *, client: HealthClient | None = None) -> FastMCP:
    api = client or HealthClient(settings)
    allowed_hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
    allowed_origins = ["http://127.0.0.1:*", "http://localhost:*"]
    if settings.mcp_public_origin:
        allowed_hosts.append(urlsplit(settings.mcp_public_origin).netloc)
        allowed_origins.append(settings.mcp_public_origin)
    mcp = PrivateFastMCP(
        "Personal Health Agent",
        instructions=(
            "个人健康记录工具。先查询已有目标和记录，缺失数据表示未知。"
            "营养数值为估计时说明来源；照片估算需用户确认后记录。"
            "client_request_id 在同一次记录的重试中保持不变。"
            "只依据用户设置的目标做生活管理，不做诊断或药物调整。"
        ),
        host=settings.mcp_host,
        port=settings.mcp_port,
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
        ),
    )
    read = ToolAnnotations(
        readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False
    )
    write = ToolAnnotations(
        readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False
    )
    edit = ToolAnnotations(
        readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False
    )

    @mcp.tool(annotations=read)
    async def get_profile() -> dict:
        """查询个人时区和已设置的健康目标；未设置目标返回 null。"""
        return await api.request("GET", "/v1/profile")

    @mcp.tool(annotations=edit)
    async def update_goals(changes: ProfileUpdate) -> dict:
        """修改用户明确指定的时区或目标；省略保持不变，null 清除目标。"""
        return await api.request(
            "PATCH", "/v1/profile", payload=changes.model_dump(mode="json", exclude_unset=True)
        )

    @mcp.tool(annotations=write)
    async def record_meal(meal: MealCreate) -> dict:
        """记录已确认的饮食估算；时间带偏移，单位 kcal/g；重试复用 client_request_id。"""
        return await api.request("POST", "/v1/meals", payload=meal.model_dump(mode="json"))

    @mcp.tool(annotations=read)
    async def list_meals(start: str | None = None, end: str | None = None) -> list:
        """按个人时区查询含首尾日期的饮食记录；省略日期查询今天，最多 366 天。"""
        params = {
            key: value for key, value in {"start": start, "end": end}.items() if value is not None
        }
        return await api.request("GET", "/v1/meals", params=params)

    @mcp.tool(annotations=edit)
    async def update_meal(meal_id: MealId, changes: MealUpdate) -> dict:
        """纠正已存在的饮食记录；保持原始重试标识不变。"""
        return await api.request(
            "PATCH",
            f"/v1/meals/{meal_id}",
            payload=changes.model_dump(mode="json", exclude_unset=True),
        )

    @mcp.tool(annotations=edit)
    async def delete_meal(meal_id: MealId) -> dict:
        """删除用户指定的饮食记录；删除后原始请求标识不能重新创建记录。"""
        return await api.request("DELETE", f"/v1/meals/{meal_id}")

    @mcp.tool(annotations=write)
    async def sync_health(snapshot: SyncRequest) -> dict:
        """同步来源明确的每日健康汇总；同来源、日期、指标覆盖更新。"""
        return await api.request("POST", "/v1/sync", payload=snapshot.model_dump(mode="json"))

    @mcp.tool(annotations=read)
    async def get_daily_summary(day: str | None = None) -> dict:
        """查询 YYYY-MM-DD 当天饮食、运动、睡眠、来源及目标剩余量；省略为今天。"""
        return await api.request("GET", "/v1/summary", params={"day": day} if day else None)

    @mcp.tool(annotations=read)
    async def get_trends(metric: str, start: str, end: str) -> dict:
        """查询最多 366 天的每日趋势；支持六项健康指标和 calories_kcal/protein_g/carbs_g/fat_g。"""
        return await api.request(
            "GET", "/v1/trends", params={"metric": metric, "start": start, "end": end}
        )

    return mcp


class BearerGuard:
    def __init__(self, app, token: str):
        self.app, self.token = app, token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            supplied = dict(scope["headers"]).get(b"authorization", b"")
            expected = ("Bearer " + self.token).encode()
            if not secrets.compare_digest(supplied, expected):
                response = JSONResponse(
                    {"error": "Unauthorized"},
                    status_code=401,
                    headers={"WWW-Authenticate": "Bearer"},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_http_app(settings: BridgeSettings, *, client=None):
    token = settings.mcp_token.get_secret_value() if settings.mcp_token else ""
    if len(token.strip()) < 32 or secrets.compare_digest(
        token, settings.api_token.get_secret_value()
    ):
        raise ValueError(
            "HTTP MCP requires a distinct HEALTH_MCP_TOKEN with at least 32 characters"
        )
    return BearerGuard(build_mcp(settings, client=client).streamable_http_app(), token)


def run():
    parser = argparse.ArgumentParser(description="Personal Health Agent MCP server")
    parser.add_argument("--transport", choices=["stdio", "streamable-http"], default="stdio")
    args = parser.parse_args()
    try:
        settings = BridgeSettings()
        if args.transport == "stdio":
            build_mcp(settings).run(transport="stdio")
        else:
            uvicorn.run(
                create_http_app(settings),
                host=settings.mcp_host,
                port=settings.mcp_port,
                access_log=False,
            )
    except (ValidationError, ValueError):
        parser.exit(2, "配置错误：检查健康服务地址和至少 32 字符的令牌；HTTP MCP 需独立令牌。\n")


if __name__ == "__main__":
    run()
