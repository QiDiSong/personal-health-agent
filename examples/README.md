# 合成测试数据

`apple-health-daily.synthetic.json` 中的日期和所有数值都是**合成数据**，不是用户的健康记录、目标或建议。它只展示六种指标及其单位；不要把它上传到自己的正式健康数据库。

将文件复制到自己的私有目录，用已经核对的每日汇总替换数值和日期，并删除没有实际数据的项目。不要用 `0` 或 `null` 代替缺失数据。测试服务器上可执行：

```bash
.venv/bin/python scripts/sync_health.py examples/apple-health-daily.synthetic.json
```

运行前需设置 `HEALTH_API_TOKEN`（至少 32 个可打印 ASCII 字符，无空白）。`HEALTH_API_URL` 默认是 `http://127.0.0.1:8000`；远程服务器必须使用 HTTPS。设置方法和 iPhone 步骤见 [Apple 健康同步说明](../docs/apple-health-sync.md)。
