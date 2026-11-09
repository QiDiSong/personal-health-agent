"""Create local configuration once; never overwrite existing secrets."""

import os
import secrets
from pathlib import Path


def main():
    destination = Path(__file__).resolve().parents[1] / ".env"
    content = (
        f"HEALTH_API_TOKEN={secrets.token_urlsafe(48)}\n"
        f"HEALTH_MCP_TOKEN={secrets.token_urlsafe(48)}\n"
        "HEALTH_DATABASE_URL=sqlite:///./health.db\n"
        "HEALTH_TIMEZONE=Asia/Shanghai\n"
        "HEALTH_API_URL=http://127.0.0.1:8000\n"
        f"POSTGRES_PASSWORD={secrets.token_urlsafe(32)}\n"
    )
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise SystemExit(".env 已存在，未覆盖。") from None
    with os.fdopen(descriptor, "w") as handle:
        handle.write(content)
    print("已创建 .env，权限 0600；令牌未打印。")


if __name__ == "__main__":
    main()
