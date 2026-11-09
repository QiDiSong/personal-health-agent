# 阿迪的健康日志

现有 ChatGPT Sites 私有健康日志：网页和手机 ChatGPT 插件读取同一份 D1 数据库。

## 免费开始导入 Apple 健康

无需另外购买同步 App 或服务器。先使用现成的手动 XML 导入：

1. 在 iPhone「健康」App 打开头像，选择「导出所有健康数据」，保存到「文件」。
2. 在「文件」中轻点导出的 ZIP 解压，找到 `export.xml`。
3. 打开健康日志网页，用同一个账号登录，选择「聊天与数据」。
4. 在「Apple 健康」中选择解压后的 `export.xml`，等待导入完成。
5. 核对运动、睡眠记录，再在手机 ChatGPT 中选择健康日志插件查询。

必须选择 XML，不能直接选择 ZIP 或 `export_cda.xml`。原始 XML 在浏览器中解析，接口只接收提取后的运动、睡眠、体重记录。无需将完整健康导出文件发送到聊天。

这是手动导入，不代表开启后台自动同步；新增数据需要再次导出、导入。重复标识会更新已有记录。大文件的导出和解析速度取决于设备与历史数据量，不能保证任意大小都能在手机中处理。

官方步骤：[导出健康数据](https://support.apple.com/zh-cn/guide/iphone/iph5ede58c3d/27/ios/27)、[解压 ZIP](https://support.apple.com/zh-cn/102532)。

## 开发与验证

使用 Node.js 24，无第三方依赖：

```sh
npm test
npm run build
```

构建输出为 `dist/server/index.js`。部署保留现有 `.openai/hosting.json` 的站点身份、D1 绑定与 MCP 能力；所有记录仍按已认证的站点用户隔离保存。不要将真实健康数据或访问令牌加入源码。

个人页面显示的参考起点与身高分别读取私有运行配置 `PROFILE_BASELINE_KG` 和 `PROFILE_HEIGHT_CM`，未配置时保持未知。实际测量记录仍保存在 D1；配置值和数据库文件不写入 GitHub。
