# Codex QQ Bridge · macOS

这个适配器把一个 QQ 协同账号接到本机 Codex。每个账号有自己的登录目录、固定群、收件游标、发信回执、桌面任务队列和 MCP 服务。默认账号沿用原来的目录和 `/task mac` 路由。可以给另一个账号起名 `lab`，用 `/task acct-lab` 单独寻址它。

| 路径 | 触发方式 | 结果 |
| --- | --- | --- |
| 固定群收件 | Codex 调用 `read_latest` 或 `wait_next` | 查询最新一条，或从持久队列领取一条；控制账号的消息优先交付。 |
| 固定群发信 | 用户确认全文后调用 `send_text` | 发送到已绑定的群，按请求号去重。 |
| QQ 私聊（实验功能） | 本机先配置联系人别名，再调用 `read_dm_latest` 或 `send_dm_text` | 按需访问这一位联系人；只在手动调用时工作。 |
| 双端协作私聊 | 双方互设协作联系人，用户在任一端提出任务 | 发起端写初稿，对端给出证据和修改意见，发起端完成修订并回传结果。 |
| 群指令建聊 | 本机启用调度后，控制账号发送 `/task 路由 正文` | 对应的 Codex 创建一个无项目聊天，核对首条任务后在本地结案。 |

## 先跑离线验收

在本目录运行。需要 Node 20.14 或更新版本、Python 3.9 或更新版本，以及 zsh。完整集成测试使用 macOS；只测试协议时也可直接运行 Node 和 Python 的单元测试。

```sh
./test
```

测试在临时目录启动两套 worker、两个 MCP 客户端及模拟 QQ 接口。它们使用同名联系人和同一个请求号，实际走 stdio、Unix socket、落盘和重试。另有三账号任务路由、控制者身份、联系人撤销、并发认领、崩溃恢复、群消息回读和终态去重测试。测试数据均为合成值。

## 安装默认账号

已验证的原生环境是 Apple Silicon、/Applications/QQ.app、QQ 内部版本 6.9.55-28172。宿主用 Xcode Command Line Tools 的 clang 编译，安装还需要可以在 PATH 中调用 node 和 codex。QQ 更新后先单独运行 probe。

```sh
./bridge probe
./bridge install
./bridge status
codex mcp get qq-bridge --json
```

安装会探测原生模块、复制运行代码、注册当前 macOS 用户的 LaunchAgent，并向 Codex 注册 stdio MCP。打开新的 Codex 聊天后可调用工具。首次登录时 status 给出腾讯生成的二维码文件；用该协同账号扫码，等待 phase 变为 ready。之后登录同一 macOS 用户，launchd 会启动后台并尝试 QQ 快速登录。账号不接受快速登录时重新扫码。

固定群功能首先在此账号的群目录中精确查找「Codex共享chat」。如有同名群，先由本人选择候选群号，再运行 `./bridge choose 群号` 和 `launchctl kickstart "gui/$(id -u)/local.codex.qq-bridge"`。配对私聊在原生账号登录后独立就绪，可用 `./bridge collab health` 单独核对。

默认账号的目录和工具名与旧版兼容，已有的绑定、游标、回执和 SQLite 记录可由新版继续使用。升级前可在本机备份旧运行代码与私有状态。要在已运行的桥上做只读冒烟测试，执行下面的命令；它在临时目录独立加载 QQ 原生模块，再用当前源码的 MCP 客户端向运行中的默认后台读一次固定群，只输出检查结果。

```sh
/usr/bin/python3 -B verify_live.py
```

## 增加第二个账号

以下例子使用配置名 lab。名称长度为 1–24 个字符，从小写 ASCII 字母开始，其余字符允许小写字母、数字和连字符。每个命名配置须指定预期 QQ 号；扫码号与预期号不同会在绑定前停止。每个同时登录的配置使用不同协同账号。

```sh
./bridge --profile lab paths
state="$(./bridge --profile lab paths | sed -n '1p')"
umask 077
mkdir -p "$state"
# 仅在首次配置时执行，再用本地编辑器填写该协同账号的 QQ 号。
test -e "$state/settings.json" || printf '%s\n' '{"accountUin":"填写协同账号QQ号","contacts":{}}' > "$state/settings.json"
```

填写完成后运行以下命令，并为新账号扫码。该账号也必须加入同一目标群。paths 依次输出状态目录、安装目录、LaunchAgent 标签、MCP 名称和群任务路由。

```sh
./bridge --profile lab install
./bridge --profile lab status
codex mcp get qq-bridge-lab --json
```

| 资源 | 默认账号 | lab |
| --- | --- | --- |
| 状态目录名 | CodexQQBridge | CodexQQBridge-lab |
| 安装目录名 | CodexQQBridgeRuntime | CodexQQBridgeRuntime-lab |
| MCP 名称 | qq-bridge | qq-bridge-lab |
| launchd 标签 | local.codex.qq-bridge | local.codex.qq-bridge-lab |
| 群内任务 | /task mac | /task acct-lab |

状态和安装目录均位于当前用户的 Library/Application Support 下。状态目录包括账号数据、群号、owner.json、bridge.sock、发件回执、tasks.sqlite3 和队列。宿主通过独占文件锁防止同一配置重复启动。QQ 原生进程使用当前配置的隔离目录和文件沙箱。要换账号请使用新的命名配置。

## 为指定联系人开启私聊

该功能通过模拟 QQ 会话完成集成验收，腾讯私聊的真机收发仍待验证。当前真实群的安装可继续使用默认的三个群工具。

在获准接入私聊的配置目录内编辑 settings.json。accountUin 属于本机协同账号，contacts 的键是 Codex 可用的本地别名，值是目标联系人的 QQ 号。以下数字是测试值。

```json
{"accountUin":"101","contacts":{"desk":"202"}}
```

重启对应后台并重连该 MCP 客户端。工具列表会出现两个新工具，contact 参数只接受配置中的别名。

```sh
launchctl kickstart -k "gui/$(id -u)/local.codex.qq-bridge-lab"
```

| 工具 | 示例参数 | 行为 |
| --- | --- | --- |
| read_dm_latest | `{"contact":"desk"}` | 将配置中的 QQ 号解析为原生 UID，用 chatType=1 查询一条；校验会话与发送者身份后才交付，空会话返回 message=null。 |
| send_dm_text | `{"contact":"desk","text":"已确认的文字","request_id":"dm-001"}` | 按本机账号、指定联系人及正文摘要校验回执。原生发送前先落盘，相同请求重试只返回已知结果。 |

工具和后台同时校验账号与联系人。删除别名后旧客户端的后续调用也会被拒绝。用户在本地明确确认全文后才调用发送。DM 的 accepted 表示原生接口接受请求，unknown 表示结果待核对。发生断线沿用同一个请求号。私聊结果按数据交付，replyPolicy 为 none，即便内容看起来像 /task 也只返回文字。私聊工具当前依赖该配置的群服务已经 ready。

## 和 Windows 账号直接协作

从 ZIP 解压后进入顶层 `codex-qq-bridge` 目录。准备已互加好友的两个 QQ 协同账号、Apple Silicon Mac、已验证版本的 QQ、支持 `node:sqlite` 的 Node 22.13+ 和已登录的 Codex CLI。在下面命令中将 `WINDOWS_QQ` 和 `MAC_QQ` 换为实际账号。

```sh
./macos/bridge collab pair WINDOWS_QQ MAC_QQ
./macos/bridge install
./macos/bridge status
./macos/bridge collab health
```

已有配置或本机已登录过这个账号时，第一条只需 `./macos/bridge collab pair WINDOWS_QQ`。`pair` 会核对设置和已有登录绑定，保留联系人并优先复用已关联该 QQ 的别名。同一配对可重复执行。已有其他配对的用户可给另一账号建立独立 profile，所有命令使用相同的 `--profile 名称`。普通联系人继续使用手动收发工具，协作收件箱只处理配对好友发来的协议消息。

首次登录时查看 `status` 返回的 `qrFile`，在本机打开并用指定 Mac 协同账号扫码，然后再次运行 `collab health`。安装刚启动时控制端点可能尚未出现。健康结果应显示 `ready: true`，表示本机已核实好友 UID 且有可用的原生推送订阅或历史补读；双方的实际收发由双机验收验证。

如需让这一端参考独有资料，可在配对后将允许本机 Codex 引用的 UTF-8 节选（最多 8 KiB）存为 `./macos/bridge collab paths` 显示目录下的 `collaboration-evidence.txt`，再运行安装。协作 LaunchAgent 在 QQ 原生沙箱之外运行普通 Node 进程。以下示例从 `macos/` 目录执行。

新开 Codex 聊天即可使用独立的 `qq-collaboration` MCP（具名账号为 `qq-collaboration-lab`）。可要求“请和 Windows 一起评审这个方案，列出对端给出的证据和最终采纳的修改”。也可从本机终端提交已有草稿。

```sh
./bridge collab health
echo '{"request_id":"review-restart-1","task":"核对跨端重启后会不会重复领取","draft":"初稿假设双方共用一份状态库","question":"请用 Windows 端的实际约束检查这个假设"}' | ./bridge collab submit
./bridge collab status --id 返回的任务编号
./bridge collab wait --id 返回的任务编号 --timeout-ms 30000
```

原生消息回调先将对端帧按 QQ 消息 ID 去重、落盘，再立即唤醒等待中的本机进程。启动时及每 5 秒补查最近 32 条。已保存游标出现间隙时尝试分页追赶；原生接口缺少历史页时保留缺口。新启用的配对只接收启用时刻之后的帧。普通群聊、来自自己的消息、转发、其他私聊都不会推进合作。Mac 真机上的私聊回调时延和断线历史范围需要在目标 QQ 版本实测。

删除 `collaborationContact` 后，后台会拒绝新的协作收发。再次执行安装会移除本账号的协作 LaunchAgent 和独立 MCP。任务、协作私聊游标和回执保存在各自账号的本地状态目录。仅切换联系对象时，请给新配对单独的账号配置或状态目录，避免混用尚在进行的任务。

## 群内点名建聊

先为所选账号安装本版桥接，配置 `owner.json` 中的人类控制者 QQ 号，并确认绑定群就绪。在仓库的 `macos/` 中运行 `./bridge mention-enable`；具名账号使用 `./bridge --profile lab mention-enable`。该命令按本账号建立任务队列并启用目录唤醒的 LaunchAgent。已有本机旧版的任务、回群回执和默认目录沿用原记录。

控制者从 QQ 成员列表选择这个账号，随 @ 附上任务。例如“@Mac协同号 请整理今天的决定”。本机核对原生群号、发送者和 @ 目标，为普通任务建持久聊天。引用本机答复或写“继续 #42”可在原聊天追加一轮；写“基于 #42 的终稿另开”则带着指定稿件建独立聊天。分发器按本次轮次 ID 查最终答复，回到原群并标明“回复 #群序号”。进度和桌面手动追加的内容留在本机。长答复在群里显示节选。群消息 ID 是建聊和回群的去重依据。

用 `./bridge trigger status` 核对条目的 `origin`、`state` 与 `replyState`；发送结果不明时保留原回执供核对。要单独暂停 @ 分发，执行相同 profile 的 `mention-disable`。原有 `/task` 桌面调度继续领取自己的任务。

## 群消息、事件与桌面任务

桌面任务只把本条指令的正文交给新聊天，完整的 `/task` 指令最多 16,000 个 UTF-16 码元。群读工具和联系人私聊读工具每次返回一条，每条的 `elements` 数组按实际 JSON 的 UTF-8 编码最多 8 KiB，超出时结果带有 `truncated: true`。协议校验和发送回读使用原始消息。群后台的待领队列与 Codex 聊天记录分别保存；在同一聊天里连续调用工具时，先前的工具结果仍属于该聊天。

- read_latest 校验群号后返回当前最新一条，包括本人消息。wait_next 按 owner 优先、同级 FIFO 领取，忽略本人和未知发送者；超时范围 0–45000 毫秒。状态文件一次替换同时保存游标、近期 ID、待领消息和事件。领取后客户端断连可能错过这次交付。
- send_text 使用独立的 request_id。accepted 表示原生接口接受，confirmed 表示在绑定群回读匹配到关联 ID，observed_in_group 表示回读匹配了含唯一请求号的正文。繁忙群的回读可以继续到后续历史页。
- 两个协同端可使用两行协议。第一行是 `QQCOOP/1 REQUEST|DONE|FAILED UUIDv4 收件QQ号`，第二行起是工作内容。收件号码、原生 senderUin 和事件号均须匹配。REQUEST 可在本地授权后回一次 DONE 或 FAILED。到期或收到终态即结案。群消息里的收件号是协议路由，群内发信仍对群成员可见。
- 要开启建聊，在本机对应状态目录配置 owner.json，例如 `{"uin":"303"}`，填写真实的人类控制者 QQ 号并重启该后台。默认账号执行 `./bridge trigger arm`，lab 账号执行 `./bridge --profile lab trigger arm`，保存启用时的群序号。按 dispatcher.md 在 Codex 桌面配置该账号自己的定时调度，固定命令路径和配置名。实际运行取决于 Codex 桌面调度；安装桥接服务与启用建聊是两个步骤。
- 对于 `/task` 路由，只有原生 senderUin 命中控制者、单个普通文本元素且无 @ 的记录可触发。支持 `/task mac /task acct-lab 正文`。群内其他账号、引用与转发不能建聊。SQLite 认领后核对 host/thread ID 与首条任务。创建结果不明时保留原记录供核对。
- 使用 `./bridge --profile lab trigger status` 查某个账号的进度。要暂停建聊，暂停对应桌面调度。群和私聊的普通收件都不会自动回信。

## 排错和停用

| 观察到的结果 | 核对方式 |
| --- | --- |
| 原生模块或 QQ 版本不匹配 | 运行 probe 核对 QQ 内部版本、arm64、Electron、Node 和服务对象。 |
| 不能登录或尚未就绪 | 使用 status 查看二维码或当前阶段，只在本机查该配置的 kernel.log。 |
| 命名账号被拒绝 | 将扫码账号与本地 settings.json 的 accountUin、既有绑定核对。 |
| 私聊显示绑定改变或无法解析 UID | 核对本机账号和别名；重启服务及客户端。受支持的 QQ 版本必须能为指定好友解析 UID。 |
| 建聊中断 | 用 trigger status 核对原记录与 Codex 桌面历史；已认领任务只做核对，避免重复建聊。 |

移除 lab 服务时先暂停其桌面调度。若已启用配对，还需删除 lab 的 `collaborationContact` 并运行 `./bridge --profile lab install`，让安装器一并撤除协作服务和协作 MCP。然后执行以下命令。私有数据可由操作者单独归档。

```sh
launchctl bootout "gui/$(id -u)/local.codex.qq-bridge-lab"
rm "$HOME/Library/LaunchAgents/local.codex.qq-bridge-lab.plist"
codex mcp remove qq-bridge-lab
```

## Windows 集成

`worker.cjs`、`host.c`、`run` 和 `install` 连接 Mac 原生 QQ。两个平台共同使用仓库中的 `collaboration/` 完成配对协作。对端需要在它自己的 QQ 账号上配置反向配对。[Windows 配置](../windows/README.md) · [双端流程与验收](../collaboration/README.md)

原生接口参考了 [NapCat 的消息适配](https://github.com/NapNeko/NapCatQQ/blob/v2.6.14/src/core/apis/msg.ts) 和 [UIN 到 UID 的映射调用](https://github.com/NapNeko/NapCatQQ/blob/v2.6.14/src/core/apis/user.ts)。运行只依赖用户已有的腾讯 QQ 和本机工具。
