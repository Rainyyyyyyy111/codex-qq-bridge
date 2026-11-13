# Windows 配对私聊

本适配器使用已登录的 Windows QQ 监听器。首次启用需选择本机 QQ 协作账号和另一台设备的 QQ 协作账号，并能从本机 QQ 通讯录解析到对端。Mac 端选择相反的收发账号。Windows 在独立的命名管道提供协作事件与人工私聊入口；本地令牌文件只供当前 Windows 用户与系统访问。

## 安装并启用

需要现有的 `outputs/qq-target-watch.cjs`、已验收的原生 Node/QQ 运行环境和支持 `node:sqlite` 的 Node 22.13+。在统一仓库根目录执行以下命令。将变量替换为自己的目录；`$qqData` 应指向该 QQ 账号的独立状态目录。

```powershell
$repo = (Get-Location).Path
$watcherRoot = '<Windows QQ 监听器工作目录>'
$qqData = '<本机 QQ 账号状态目录>'
$peer = '<Mac 协作账号的 QQ 号>'
./windows/install.ps1 -WatcherRoot $watcherRoot
$dm = Join-Path $watcherRoot 'outputs/paired-dm.cjs'
node $dm $qqData pair $peer
```

上面的 `pair` 从现有收件箱读取本机已绑定账号。也可显式执行 `node $dm $qqData pair 本机QQ号 对端QQ号`，监听器启动时会核对实际登录身份。安装或配对命令自身只操作本地文件。更换对端时先执行 `unpair`，再执行 `pair` 并重新启动私聊入口。已有连接会在后续请求或发信前检查配对是否仍有效。

单独运行私聊时，在本机 QQ 监听器工作区执行以下命令。它复用原来已核验的 QQ 和 Node 版本，通过隔离账号目录尝试 QQ 原生快捷登录。只匹配已配对的本机账号。若发现其他读取器正在使用此账号目录，或官方 QQ 正占用该账号标准资料库，启动命令会报告占用。已有群监听也可承载私聊；两种模式共用同一账号时只启用一种。

```powershell
./outputs/qq-target.ps1 dm-start
./outputs/qq-target.ps1 dm-status
```

`dm-status` 在原生好友映射及私聊历史都就绪时显示 `ready`。如果快捷登录需要手机确认，本命令给出 `scan-required` 和本机登录页路径，打开该 HTML 页面并用本机协作账号扫码。二维码只存入当前用户的私有配对目录。再次运行 `dm-start` 可复用正在运行的私聊读取器。要停止这个私聊进程可用 `./outputs/qq-target.ps1 dm-stop`；已有群监听的生命周期由原入口管理。

## 群内点名建聊

群 @ 需要现有 Windows 群监听器和本版 `windows/install.ps1` 提供的群监听钩子，还需可执行的 Python 3.9+ 与 Codex CLI。私聊专用 `dm-start` 只监听私聊。需要同时收群 @ 和配对私聊时，在该账号的现有群监听模式中运行两套适配器。每个账号只运行一个原生读取器。

安装本版适配器后，在启动群监听器之前显式选择本机账号、群号和人类控制者。以下命令使用前文的 `$watcherRoot` 和 `$qqData`。

```powershell
$mentions = Join-Path $watcherRoot 'outputs/group-mentions.cjs'
node $mentions $qqData enable <本机协同QQ号> <群号> <控制者QQ号>
# 用原工作区的正常入口启动或重启群监听器，等待该群的 QQ 历史就绪。
node $mentions $qqData dispatch
```

`dispatch` 前台运行，首次启动以此时群序号为起点。控制者从 QQ 成员列表点名本机并附上正文，分发器会复核原群历史，给普通任务新建聊天，遇到原生回复引用或“继续 #42”则续接原聊天。写“基于 #42 的终稿另开”会创建独立聊天。每次只把对应轮次的最终回答发回同群。可用环境变量 `QQ_MENTION_PYTHON`、`QQ_MENTION_CODEX` 指定可执行文件。在另一终端执行 `node $mentions $qqData disable` 可撤销该绑定；重新启用或更换群后重新启动群监听器和分发器。旧端须能提供原生群推送、按序号读取历史及群文本发送。仓库的合成测试覆盖这些接口，Windows 真机群环境仍需确认。

## 让本机 Codex 接入

从一个终端启动独立的协作服务，另一终端可查询 `health` 或注册 MCP。两台设备应各用自己的协作状态目录。生成、复核、收件和普通群聊分别维护状态。

```powershell
$cfg = node $dm $qqData info | ConvertFrom-Json
$state = Join-Path (Split-Path -Parent $cfg.tokenFile) 'collaboration-work'
$service = Join-Path $repo 'collaboration/service.cjs'
node $service serve --state $state --socket $cfg.socket --token-file $cfg.tokenFile
```

在另一个终端用相同的 `$repo`、`$state` 执行。

```powershell
node (Join-Path $repo 'collaboration/service.cjs') health --state $state
codex mcp add qq-collab-win -- node (Join-Path $repo 'collaboration/mcp.cjs') --state $state
```

新的 Codex 聊天可用 `collab_write` 共写短稿、`collab_start` 发起复核、`collab_note` 补充证据、`collab_wait` 等待进展、`collab_status` 查询结果。需要普通私聊时，`peer_read_latest` 可按需查看配对会话的最新一条，`peer_send_text` 可发送用户明确指定的文字。启动服务时的 `--codex` 可指定 Codex 可执行文件，`--evidence-file` 可指定本机拟用于复核的证据资料。

## 人工私聊

读取当前配对会话最新消息用 `node $dm $qqData read`。要发送自己确认的文字，先在本地 UTF-8 文件中写入 `{"request_id":"note-001","text":"已核对第 3 条，证据见本机复核记录。"}`，再执行 `node $dm $qqData send 文件路径`。同一次提交使用相同的请求号与正文。读取普通私聊只返回数据；进入协作队列的消息须由配对账号通过原生好友会话送达，正文匹配 `QQCOLLAB/1` 协议和双方的账号地址。本机现行部署还提供 `qq-target.ps1 dm-info`、`dm-pair 对端QQ号`、`dm-unpair`、`dm-read` 与 `dm-send 文件路径`。

## 即时性与恢复

- 原生消息回调把协作帧落入本地 SQLite，随即唤醒正在等待事件的协作服务。同一原生消息 ID 只入队一次。每个消费者保存自己的读取游标，可以从已知位置重读。
- 启动时和每 15 秒核对一次 QQ 历史。若打开会话时的最新记录接口失败，可使用同好友会话的原生历史接口。离线超过一页时，以原生消息 ID 倒序翻页，随后按历史顺序入队。历史接口不可用或先前锚点无法找到时，`collab_info.history` 给出 `history-unavailable` 或 `history-gap`，保留原锚点供下一次检查。
- 出站先按请求号登记，再调用 QQ。原生接口接收后返回 `accepted`；提交结果丢失时保留 `unknown`，重复调用只返回原记录。对端实际处理进度由协作服务的事件确认。
- 人工发送、协议发送与接收均校验本地绑定。不同配对使用独立的数据库、令牌与管道。持久记录数量随协作事件与发送请求增长。

在仓库根目录执行 `node --test windows/paired-dm.test.cjs windows/dm-only.test.cjs` 可测试命名管道、令牌、即时唤醒、分页补收、重复投递、专用登录入口与发送中断。离线测试用合成 QQ 身份。本次真实 Windows QQ 验证覆盖独立账号登录、好友 UID、原生监听注册与历史就绪。跨设备真实私聊送达和腾讯网络延迟仍需双方上线验收。
