# Codex QQ Bridge

两台设备现在可以在配对 QQ 私聊中协作。一端给出初稿和要查证的问题，对端回传独立证据；发起端据此修订，并把同一份终稿交给双方。支持处理中补充、立即收件回执及断线后的恢复。[双端协作与真机验收](collaboration/README.md) · [Windows 私聊适配](windows/README.md)

配对端还可以用 `collab_write` 共写短稿。发起端写首段并指定缺口，对端按分工撰写正文。发起端合稿并提出结合两端材料的结论，对端校稿后可以确认或退修。[共写与退修](collaboration/README.md#配对私聊共写短稿)

在绑定群中，控制者可以用 `/task` 创建本地工作聊天。启用群 @ 功能后，从 QQ 成员列表点名本机协同账号并附上任务，会创建一个持久聊天，把首轮最终答复作为一条普通文本发回原群。[Mac 群 @](macos/README.md#群内点名建聊) · [Windows 群 @](windows/README.md#群内点名建聊)

## 平台与验收

[两台真机联调手册：隔离现网，验证群 @ 回群和私聊共写](LIVE-TEST.md)

[macOS 安装与联系人配置](macos/README.md) · [Windows 私聊专用启动与接入](windows/README.md)

| 能力 | 验证范围 |
| --- | --- |
| QQ 原生环境 | Apple Silicon，QQ 6.9.55-28172，独立加载登录、引擎和会话对象。 |
| 固定群 | 本次用新版 stdio MCP 连接既有本机后台，对已绑定群完成只读冒烟测试。 |
| 多账号与指定联系人私聊 | 使用合成身份，两个 worker 分别登录模拟 QQ，经 MCP 和 Unix socket 验证隔离、读写、重试和撤销。真实多账号登录和腾讯私聊收发待验收。 |
| Windows 配对私聊 | 本机真实 QQ 已验证登录、配对好友身份解析、推送订阅和历史读取就绪。私聊专用进程可独立于群监听运行。 |
| 群 @ 建聊和原群回复 | 在 Mac 上使用两个平台的群适配器、合成 QQ、实际 Python 分发进程及模拟 Codex App Server 验证建聊与一次回群。Windows 原生 QQ 现场仍待验收。 |
| 两端协作 | 双进程经过正式平台适配器、合成 QQ 传输和真实 Codex，完成了同一稿件的复核、修订与双方确认。两台物理设备间的腾讯网络收发与延迟仍待实测。 |

```sh
./macos/test
node --test ./collaboration/*.test.cjs ./windows/*.test.cjs
```

CI 运行离线测试。单独验证真实 QQ 需在已装配的 Mac 上运行 `/usr/bin/python3 -B macos/verify_live.py`。仓库只分发桥接器源码和合成测试资料，腾讯 QQ 由使用者在本机安装。
