"""Authenticated client shared by MCP and scheduled reports."""

from urllib.parse import urlsplit

import httpx
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class BridgeSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HEALTH_",
        env_file=".env",
        extra="ignore",
        hide_input_in_errors=True,
    )

    api_url: str = "http://127.0.0.1:8000"
    api_token: SecretStr
    mcp_token: SecretStr | None = None
    mcp_host: str = "127.0.0.1"
    mcp_port: int = Field(default=8001, ge=1, le=65535)
    mcp_public_origin: str | None = None

    @field_validator("api_token", "mcp_token")
    @classmethod
    def strong_token(cls, value):
        if value is not None:
            token = value.get_secret_value()
            if len(token) < 32 or any(not 33 <= ord(char) <= 126 for char in token):
                raise ValueError("Token must contain at least 32 printable ASCII characters")
        return value

    @field_validator("api_url")
    @classmethod
    def safe_api_url(cls, value):
        if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("API URL cannot contain whitespace or control characters")
        url = urlsplit(value)
        _ = url.port
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Use an HTTP(S) API origin without credentials, query or fragment")
        if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Remote health services require HTTPS")
        return value.rstrip("/")

    @field_validator("mcp_public_origin")
    @classmethod
    def safe_public_origin(cls, value):
        if value is None:
            return value
        if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("MCP public origin cannot contain whitespace or control characters")
        url = urlsplit(value)
        _ = url.port
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.path not in {"", "/"}
            or url.query
            or url.fragment
        ):
            raise ValueError("MCP public origin must be an HTTPS origin")
        return value.rstrip("/")


class HealthServiceError(RuntimeError):
    """Safe, human-readable error without upstream payload or credentials."""


class HealthClient:
    def __init__(self, settings: BridgeSettings, transport=None):
        self.settings = settings
        self.transport = transport

    async def request(self, method: str, path: str, *, params=None, payload=None):
        headers = {"Authorization": f"Bearer {self.settings.api_token.get_secret_value()}"}
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.api_url + "/",
                headers=headers,
                timeout=30,
                follow_redirects=False,
                transport=self.transport,
            ) as client:
                response = await client.request(
                    method, path.lstrip("/"), params=params, json=payload
                )
        except httpx.HTTPError:
            raise HealthServiceError("无法连接健康服务，请检查地址和服务状态。") from None
        if not 200 <= response.status_code < 300:
            messages = {
                401: "健康服务认证失败，请检查服务配置。",
                404: "未找到该记录。",
                409: "记录冲突，请查询现有记录并使用正确的记录标识。",
                422: "输入不符合健康服务的数据规则，请检查日期、单位和数值。",
            }
            message = messages.get(response.status_code, "健康服务暂时无法完成请求。")
            raise HealthServiceError(f"{message} (HTTP {response.status_code})")
        if response.status_code == 204:
            return {"deleted": True}
        try:
            return response.json()
        except ValueError:
            raise HealthServiceError("健康服务返回了无法识别的数据。") from None
