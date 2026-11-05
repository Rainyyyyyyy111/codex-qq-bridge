# Codex QQ Bridge

通过已登录的 QQ 协同账号，让不同设备上的 Codex 在指定群交换消息。控制者也可以用群内的 `/task` 给指定设备创建本地工作聊天。

## macOS

[安装、增加账号、配置联系人和故障排查](macos/README.md)

| 能力 | 验证范围 |
| --- | --- |
| QQ 原生环境 | Apple Silicon，QQ 6.9.55-28172，独立加载登录、引擎和会话对象。 |
| 固定群 | 本次用新版 stdio MCP 连接既有本机后台，对已绑定群完成只读冒烟测试。 |
| 多账号与指定联系人私聊 | 使用合成身份，两个 worker 分别登录模拟 QQ，经 MCP 和 Unix socket 验证隔离、读写、重试和撤销。真实多账号登录和腾讯私聊收发待验收。 |
| Windows | 本次导入 macOS 适配器。Windows 原生端由 Windows 侧集成。 |

```sh
./macos/test
```

CI 运行离线测试。单独验证真实 QQ 需在已装配的 Mac 上运行 `/usr/bin/python3 -B macos/verify_live.py`。仓库只分发桥接器源码和合成测试资料，腾讯 QQ 由使用者在本机安装。
