# V1 验证记录 — 2026-11-09

所有测试使用合成数据和独立测试数据库；没有读取真实健康记录。

## 最终验证

- `.venv/bin/pytest -q`：139 passed，1 条上游 Starlette/httpx 测试客户端弃用警告。
- 在独立 PostgreSQL 17 容器中设置 `TEST_DATABASE_URL`，运行 `pytest tests/test_api.py -q`：58 passed。
- `.venv/bin/ruff check .` 与 `.venv/bin/ruff format --check .`：全部通过。
- 官方 MCP SDK `ClientSession`：真实 stdio 子进程及带独立 Bearer 认证的 Streamable HTTP 都通过工具发现、无效参数脱敏、写入饮食、写入健康快照、读取真实汇总测试。
- Docker 镜像构建成功；Compose 的 API 和 PostgreSQL 都通过健康检查。通过容器 API 写入合成餐食并读取汇总，随后验证重启持久化。
- 源码通过独立审查；审查的三个必改问题已经加入回归测试并修正：MCP 参数错误回显、PostgreSQL NUL 文本输入及数据库参数诊断泄露、超大记录 ID。

## 实现选择

沿用原对话确定的 FastAPI/PostgreSQL 方案。每日快照由设备端整理，服务端按来源/日期/指标覆盖，汇总优先 apple_health、manual、其他来源名称顺序。此规则防止跨来源相加，并不替代设备端原始样本合并。

新后端与当前账号已有的“阿迪的健康日志”Site/插件使用不同存储；本次没有改动、迁移或连接现有插件的数据。两者不能视为自动同步。

## 实际边界

没有公网部署、ChatGPT 账号安装/连接或 iPhone 真机 HealthKit 测试。手机需要实际可达的 HTTPS 服务和设备侧授权。ChatGPT 若要求 OAuth，需要额外的 MCP OAuth 网关；当前交付支持本机 stdio 及静态 Bearer 认证 HTTP MCP。照片估算由宿主聊天完成，后端接收用户确认的字段。定时汇总提供可执行 CLI 和 cron 示例，尚未替用户创建定时任务。

V1 首次建表使用 create_all，未来表结构变更需要迁移。SQLite 是本地模式，生产配置使用 PostgreSQL。服务没有多用户隔离或数据库级加密；部署环境负责磁盘与备份访问控制。
