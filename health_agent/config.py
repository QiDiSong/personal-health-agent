"""Environment configuration; secrets are required and hidden in representations."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError


def validate_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValueError("timezone must be a valid IANA timezone") from None
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HEALTH_", env_file=".env", extra="ignore", hide_input_in_errors=True
    )

    api_token: SecretStr
    database_url: str = Field(default="sqlite:///./health.db", repr=False)
    timezone: str = "Asia/Shanghai"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)

    @field_validator("api_token")
    @classmethod
    def strong_token(cls, value: SecretStr) -> SecretStr:
        token = value.get_secret_value()
        if len(token) < 32 or any(not 33 <= ord(character) <= 126 for character in token):
            raise ValueError(
                "HEALTH_API_TOKEN must contain at least 32 printable ASCII characters without whitespace"
            )
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        return validate_timezone(value)

    @field_validator("database_url")
    @classmethod
    def valid_database_url(cls, value: str) -> str:
        try:
            url = make_url(value)
        except (ArgumentError, TypeError, ValueError):
            raise ValueError("database_url must be a SQLite or PostgreSQL SQLAlchemy URL") from None
        if url.drivername not in {"sqlite", "sqlite+pysqlite", "postgresql", "postgresql+psycopg"}:
            raise ValueError("database_url must use SQLite or PostgreSQL with psycopg")
        if url.drivername == "postgresql":
            return url.set(drivername="postgresql+psycopg").render_as_string(hide_password=False)
        return value
