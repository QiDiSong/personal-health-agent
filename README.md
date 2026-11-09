# 个人健康管理 Agent

按“健康管理Agent”对话确定的架构实现：**聊天工具 + 自有健康数据库 + iPhone 数据同步接口**。后端使用 FastAPI / PostgreSQL，本地开发可使用 SQLite。

这是可运行的第一版源码。运行服务、配置聊天客户端以及 iPhone 上的健康授权是三个独立步骤；项目不会自动取得你的真实健康数据。

## 手机快速使用：免费手动导入

如果你要在手机 ChatGPT 中使用已有的「阿迪的健康日志」，最快的方式是：

**iPhone 健康 App → 头像 → 导出所有健康数据 → 在“文件”中解压 → 健康日志网页“聊天与数据”→ 选择 export.xml。**

导入后，在手机 ChatGPT 选择该插件查询已保存的运动和睡眠记录。无需额外购买同步 App，也无需先运行下面的独立 Python 后端。完整步骤和范围见[手机免费导入说明](docs/mobile-free-import.md)。

现有网页及插件源码位于 `sites/health-journal/`，使用 Site 的 D1 数据库；以下 FastAPI/PostgreSQL 后端仍是独立存储，尚未与手机插件自动互通。文件导入是手动操作，后台自动同步尚未配置。

## 可以做什么

- 记录、查询、纠正和删除饮食；热量使用 kcal，营养素使用 g。照片由聊天端估算，经你确认后调用记录工具。
- 保存自己设定的热量、蛋白质、步数、睡眠和目标体重；不自动猜测个人信息或制定热量处方。
- 同步体重、步数、活动热量、睡眠时长、静息心率和运动时长的每日汇总。
- 查询每日汇总、目标剩余量及最多 366 天的逐日趋势。
- 通过官方 MCP SDK 提供 9 个聊天工具，支持本机 stdio 和带 Bearer 认证的 Streamable HTTP。
- 用命令行生成每日 JSON 报告，可接入自己控制的定时任务。

缺失数据返回 `null`。没有饮食记录时，当天摄入量未知；这与已记录摄入为零不同。某餐没有蛋白质估算时，当天蛋白质合计也保持未知。

## 本地启动

需要 Python 3.12+。从项目根目录执行：

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-dev.lock
.venv/bin/pip install --no-deps -e .
python scripts/init_env.py
.venv/bin/health-agent
```

`init_env.py` 创建仅当前用户可读的 `.env`，生成随机 API 令牌、MCP 令牌和数据库密码，不覆盖已有文件、不打印令牌。服务默认仅监听 `127.0.0.1:8000`，首次启动创建空数据库。没有演示数据或预设个人目标。

健康检查：`http://127.0.0.1:8000/healthz`。所有 `/v1/*` 接口需要 `Authorization: Bearer <HEALTH_API_TOKEN>`。服务不会开启交互文档页面；请求和返回格式可查阅源码中的 Pydantic 模型和下面的示例。

## 使用 PostgreSQL

安装 Docker / Docker Compose 后，在项目根目录执行：

```bash
python scripts/init_env.py  # 已有 .env 时跳过
docker compose up --build -d
docker compose ps
```

Compose 会将 API 配置为 PostgreSQL；主机 `.env` 中的 SQLite 地址仍可供本地开发使用。数据库使用命名卷 `health-data`，不向主机开放数据库端口，API 仅开放本机端口。`docker compose down` 保留数据；删除卷会删除数据库。

首次启动通过 `create_all` 建表。V1 不包含跨版本结构迁移工具；今后修改数据结构应先备份并加入正式迁移，不应直接替换生产数据库。

备份示例，文件包含私密健康数据，需妥善保管：

```bash
umask 077
docker compose exec -T db pg_dump -U health -d health > health-backup.sql
```

数据库持久化不等于加密。部署时使用加密磁盘和访问受控的备份；V1 使用单用户共享密钥认证，不提供多人隔离。

## 连接聊天客户端

先启动 API，再使用项目虚拟环境中的 `health-agent-mcp`。将 [.mcp.json.example](.mcp.json.example) 中的两个绝对路径改成实际项目目录，在支持 stdio 的 MCP 客户端中登记。进程工作目录应为项目根目录，以便读取 `.env`；不支持 `cwd` 的客户端可通过其受保护的环境配置传入 `HEALTH_API_URL` 和 `HEALTH_API_TOKEN`。不要将真实令牌写入版本控制。

工具包括：

| 工具 | 用途 |
| --- | --- |
| `get_profile` / `update_goals` | 读取、修改时区与目标；目标传 null 可清除 |
| `record_meal` / `list_meals` | 记录和查询饮食；重试沿用同一个 `client_request_id` |
| `update_meal` / `delete_meal` | 按记录 id 纠正或删除 |
| `sync_health` | 写入每日健康快照 |
| `get_daily_summary` / `get_trends` | 读取汇总和趋势 |

聊天行为说明见 [docs/agent-instructions.md](docs/agent-instructions.md)。例如：“记录今天午餐，估计 600 千卡，蛋白质尚不清楚”“把我的步数目标设为 8000”“看过去七天的睡眠和体重趋势”。工具层不需要 OpenAI API Key，推理和照片识别由连接工具的聊天客户端完成。

### 远程 MCP

```bash
.venv/bin/health-agent-mcp --transport streamable-http
```

默认地址 `http://127.0.0.1:8001/mcp`，所有请求都需要独立的 `HEALTH_MCP_TOKEN`。若经过自己的 HTTPS 反向代理，配置 `HEALTH_MCP_PUBLIC_ORIGIN=https://你的域名`；需要监听其他网卡时再配置 `HEALTH_MCP_HOST`。不要将未启用 HTTPS 的服务暴露到互联网。反向代理必须保留 Authorization 和 Host，并禁用健康请求体日志。

**直接连接自定义 MCP 目前受 ChatGPT 网页版及账号权限限制，不能据此承诺手机可用。** 支持静态 Bearer 头的 MCP 客户端可连接这个独立服务；ChatGPT 认证需遵循其支持的 OAuth 等方式，V1 不实现 OAuth 授权服务器。本机 stdio 也不能直接被 ChatGPT 网页或手机调用。手机当前使用的是上面已有的 Site 插件；仅部署这个独立后端或增加 OAuth 不会自动连接该插件。[官方连接限制](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## iPhone / Apple Watch 同步

完整操作见 [docs/apple-health-sync.md](docs/apple-health-sync.md)。iPhone 上的快捷指令在你授权后读取 Apple 健康，汇总为当天快照，再 POST 到 `/v1/sync`。Apple Watch 数据需先进入 iPhone 的 Apple 健康。服务器接收汇总数据，不直接读取 HealthKit。

规范化负载示例，数值仅用于说明，**不是你的健康记录**：

```json
{
  "source": "apple_health",
  "observations": [
    {"date": "2026-11-09", "metric": "steps", "value": 6500},
    {"date": "2026-11-09", "metric": "sleep_minutes", "value": 430}
  ]
}
```

命令行发送你自己准备的规范化 JSON：

```bash
.venv/bin/python scripts/sync_health.py /path/to/your-daily-snapshot.json
```

同步脚本从环境变量读取地址与令牌；支持项目 `.env`（详见同步说明）。重复提交相同来源、日期、指标会覆盖原值；当天累计步数从 3000 更新到 6500，结果为 6500。不同来源不相加：汇总优先 `apple_health`，其次 `manual`，再按来源名称排序，并返回所选来源。苹果手机与手表原始步数、睡眠重叠区间应先在采集端合并，不能直接把所有样本相加。

## 每日汇总和定时任务

```bash
.venv/bin/health-agent-report --day 2026-11-09
```

省略 `--day` 使用个人时区的今天。报告读取真实数据并输出 JSON，不会主动发消息或制造测量值。可先建一个仅当前用户可读的 `reports/` 目录，再在你自己的主机上加入 cron，例如每天 23:55 生成当天汇总（cron 所在主机的时区应与你期望一致）：

```cron
55 23 * * * cd /absolute/path/health-agent && umask 077 && .venv/bin/health-agent-report > reports/daily-latest.json
```

## 验证

```bash
.venv/bin/pytest -q
.venv/bin/ruff check .
npm --prefix sites/health-journal test
npm --prefix sites/health-journal run build
```

测试覆盖认证、非法输入、持久化、重复同步、饮食重试与纠错、时区边界、来源优先级、缺失数据、MCP 工具和同步客户端。实际 PostgreSQL 与 MCP 协议验证结果记录在 [docs/verification.md](docs/verification.md)。

网页部分使用 Node.js 24，无额外 npm 依赖；其测试通过实际页面导入逻辑和内存 SQLite 验证跨夜睡眠、设备标识变化、重复导入修正及账号隔离。

## API 约定

`GET/PATCH /v1/profile`、`GET/POST /v1/meals`、`PATCH/DELETE /v1/meals/{id}`、`POST /v1/sync`、`GET /v1/summary?day=YYYY-MM-DD`、`GET /v1/trends?metric=steps&start=YYYY-MM-DD&end=YYYY-MM-DD`。

饮食时间必须带 UTC 偏移，例如 `2026-11-09T12:30:00+08:00`；按已保存的 IANA 时区归属日期。日期范围含首尾，最多 366 天。睡眠单位为分钟、体重为 kg、静息心率为 bpm。热量目标与活动热量分别展示，V1 不自动将运动热量计入可吃额度。

饮食重试标识用于同一次记录：相同原始负载重试返回现有记录，改变负载返回 409；纠错使用 PATCH。删除后保留用于阻止意外重建的内部标识；它不是彻底擦除数据库的隐私删除接口。
