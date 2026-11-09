# 阿迪的月度健康日志

现有 owner-private ChatGPT Site，网页、Windows 和手机 ChatGPT 插件读取同一份持久 D1 日志。每月从 iPhone「健康」导出一次，直接导入 ZIP，回看最近30天或历史月份。无需快捷指令、额外 App 或 Python 后端。

## 每月使用

1. iPhone「健康」→ 头像 →「导出所有健康数据」→ 保存 ZIP 到「文件」。苹果导出包含全部历史。
2. Safari 登录健康日志 →「导入每月健康文件」→ 选择 ZIP，等待完成。无需手动解压，也支持 `export.xml`。
3. 「月度健康」选择最近30天或一个具体月份；重复导入更新相同标识，历史记录持续保留。

[完整使用说明与指标范围](docs/monthly-health.md)。网页支持饮食营养、睡眠、具体训练、活动、体重和常见身体指标。手表不会识别吃了什么；没有记录在健康中的饮食可在网页或手机 ChatGPT 补记。估算会标明，未知不补成0。

ZIP/XML在浏览器解析，只上传结构化记录。文件上限200MiB，XML解压上限150MiB，不支持ZIP64；超大文件不能保证在手机解析。导入可分批保存，网络中断后可重新选择同一文件重试。手机端删除的数据不会自动删掉网页旧记录。首次应核对实际睡眠、运动和一天步数。

累计指标按单来源日总量取最大，避免叠加iPhone和Watch；体征使用有效样本最多的单一来源平均值，可能与Apple来源优先级统计不同。同日营养按字段优先Apple汇总，再用补记餐食合计，避免重复相加。

## 开发

使用Node.js24，固定esbuild0.28.2与fflate0.8.2构建；运行时依赖打包进Worker/本地ZIP读取脚本。第三方许可见[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

```sh
npm ci
npm run build
npm test
```

构建生成 `worker/archive-browser.js` 和 `dist/server/index.js`。前者跟踪在源码中以支持直接执行Node测试，修改压缩读取源码后需重新构建。保留现有 `.openai/hosting.json` 的站点身份、D1绑定和MCP能力。不要将真实健康文件、数据库或令牌加入Git。

个人显示配置 `PROFILE_BASELINE_KG` / `PROFILE_HEIGHT_CM` 仅由Sites秘密运行配置提供。可选的[原生快捷指令](docs/native-shortcuts-windows.md)入口仍保留；它需要额外一次性搭建，不是每月文件导入的前提。其 `PHONE_SYNC_GATEWAY_TOKEN` 仅用于所有者下载私人连接文件，设备凭证哈希存储并可撤销。
