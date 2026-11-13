# Mac 与 Windows 真机联调

本轮验证两件事：控制者在一个群里分别点名两台设备，每台各建一个聊天、各回一次；然后由 Mac 发起一轮私聊共写，Windows 提供 Mac 未收到的测试资料，双方确认同一份终稿。实际运行会向测试群和测试好友发送 QQ 消息，并使用已登录的 Codex。

## 0. 准备测试账号和目录

- 准备 **Mac 测试 QQ、Win 测试 QQ、控制者 QQ**。两个测试 QQ 是不同账号，均未被现网读取器或另一桌面会话占用，互为好友。三者加入同一个名为 **Codex共享chat** 的测试群，记下群号。可以新建同名测试群。
- 两端用 Node 22.13+、Python 3.9+、已登录且支持 `--no-daemon` 的 Codex CLI。Mac 原生桥已验证 Apple Silicon / QQ 6.9.55-28172。Win 还需旧群监听器中已验收的 reader 源码和对应原生 Node/QQ 环境。分支只分发适配器。
- Win 建议在独立的测试 Windows 用户或虚拟机准备旧监听器。也可在原用户里用一份**仅含源码和运行依赖的独立工作目录**。其可写路径（QQ 数据、二维码、收件箱、日志）、进程管理和群绑定均须能指向测试实例。不要复制现网登录态、数据库或令牌。若原启动器只有全局锁、固定任务名或会停止所有同类进程，用下面的专用 reader 前台入口或独立虚拟机。
- 两端从新目录拉取同一分支，Mac 已有此版 checkout 时直接进入仓库根目录。

```sh
git clone --branch feat/group-mentions-cowriting --single-branch https://github.com/Rainyyyyyyy111/codex-qq-bridge.git codex-qq-bridge-fieldtest
cd codex-qq-bridge-fieldtest
git rev-parse HEAD
```

## 1. Mac 准备与启动

在仓库根目录打开 zsh。本次用测试 profile，以下三个后台均在前台终端运行。整个过程无需安装 LaunchAgent 或改 Codex 的 MCP 注册。

**终端 M1**。替换三个账号，首次启动前确认 profile 生成的目录尚未使用。若已存在，请在下列命令和其他 Mac 终端统一换一个新 profile 名。原 profile 的联调中断后，可沿用原目录及账号继续。

```zsh
P=fieldtest
b() { ./macos/bridge --profile "$P" "$@"; }
MAC_QQ='填Mac测试QQ'
WIN_QQ='填Win测试QQ'
OWNER_QQ='填控制者QQ'
qq_state=$(b paths | sed -n '1p')
work_state=$(b collab paths)
b paths
(
  set -eu
  umask 077
  [[ ! -e "$qq_state" && ! -e "$work_state" ]] || { echo '该 profile 已存在，请选新名称'; exit 1; }
  b collab pair "$WIN_QQ" "$MAC_QQ"
  /usr/bin/python3 - "$qq_state" "$OWNER_QQ" <<'PY'
import json, re, sys
from pathlib import Path
root, owner = sys.argv[1:]
if not re.fullmatch(r"[1-9][0-9]*", owner):
    raise SystemExit("请填写控制者 QQ 号")
with (Path(root) / "owner.json").open("x") as f:
    json.dump({"uin": owner}, f)
PY
  mkdir -p "$work_state"
  print -r -- '联调样例：Mac 第一阶段耗时 80 ms。' > "$work_state/collaboration-evidence.txt"
  b serve
)
```

**终端 M2**。所有新终端均先进入这份仓库根目录。复制下面的变量定义。通过只连接模式查看测试 worker 的 `status`，若有 `qrFile`，在本机打开，用 **Mac 测试 QQ** 扫码。同名群出现歧义时执行 `b choose 实际测试群号`。等 `ready: true` 后读取绑定，核对账号和群号。

```zsh
P=fieldtest
b() { ./macos/bridge --profile "$P" "$@"; }
qq_state=$(b paths | sed -n '1p')
work_state=$(b collab paths)
QQ_BRIDGE_CONNECT_ONLY=1 b status
# ready 后：
/usr/bin/python3 -c 'import json,sys; b=json.load(open(sys.argv[1])); print("QQ",b["uin"],"group",b["id"])' "$qq_state/binding.json"
```

核对无误后在 M2 启动群 @ 分发。保留这个终端。首次 `arm` 保存当前群序号，测试消息在这一步之后发送。

```zsh
b trigger arm && mkdir -p "$qq_state/mention-wake" && \
  env QQ_BRIDGE_STATE="$qq_state" QQ_BRIDGE_COLLAB_STATE="$work_state" QQ_BRIDGE_PROFILE="$P" QQ_BRIDGE_ROUTE="acct-$P" \
  /usr/bin/python3 -B macos/mention_dispatch.py --watch
```

**终端 M3**。启动配对私聊协作服务。

```zsh
P=fieldtest
b() { ./macos/bridge --profile "$P" "$@"; }
work_state=$(b collab paths)
codex_bin=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
[[ -x "$codex_bin" ]] || codex_bin=$(command -v codex)
b collab serve --codex "$codex_bin" --evidence-file "$work_state/collaboration-evidence.txt"
```

## 2. Windows 准备与启动

以下使用 PowerShell。在本分支的仓库根目录打开 **W1**。在独立的旧监听器源码副本里准备 `outputs/qq-target-watch.cjs`、`outputs/qq-read-latest.cjs` 和原版 `outputs/qq-target.ps1`。安装器会改写这个副本。确认副本目录及其 `outputs` 不是现网目录或指向现网的链接。

将下面的变量定义也复制到后续的 **W2、W3、W4**，每个终端都用相同的实际值。若使用的原生 Node 与系统 node 不同，`$nativeNode` 用旧监听器核验过的 Node x64 绝对路径。业务侧的 `node` 需要支持 `node:sqlite`。`$codexExe` 用已登录、能运行 `app-server` 和 `--no-daemon exec` 的实际可执行文件。

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$watch = 'D:\QQ-fieldtest\watcher'       # 独立监听器源码副本
$qqData = 'D:\QQ-fieldtest\account'      # 首次运行时应不存在
$nativeNode = '填已核验的原生node.exe绝对路径'
$qqVersion = '填旧监听器固定的QQ版本目录'
$nativeDir = '填与该QQ版本匹配的原生模块目录'
$codexExe = '填已登录的codex.exe绝对路径'
$macQQ = '填Mac测试QQ'
$winQQ = '填Win测试QQ'
$ownerQQ = '填控制者QQ'
$group = '填同一个测试群号'
$out = Join-Path $watch 'outputs'
$dm = Join-Path $out 'paired-dm.cjs'
$mentions = Join-Path $out 'group-mentions.cjs'
$service = Join-Path $repo 'collaboration/service.cjs'
$workState = Join-Path $qqData 'collaboration-work'
$evidence = Join-Path $qqData 'win-evidence.txt'
```

**W1** 只在首次准备时执行这一段。原生文件和版本目录沿用旧部署已核验的只读运行依赖。安装器仅传入上面独立的 `$watch`。

```powershell
if (Test-Path -LiteralPath $qqData) { throw '请选择全新的测试账号目录' }
foreach ($name in 'qq-target-watch.cjs','qq-read-latest.cjs','qq-target.ps1') {
  if (!(Test-Path -LiteralPath (Join-Path $out $name) -PathType Leaf)) { throw "监听器副本缺少 $name" }
}
& (Join-Path $repo 'windows/install.ps1') -WatcherRoot $watch
node $dm $qqData pair $winQQ $macQQ
if ($LASTEXITCODE) { throw '测试私聊配对失败' }
node $mentions $qqData enable $winQQ $group $ownerQQ
if ($LASTEXITCODE) { throw '测试群绑定失败' }
[IO.File]::WriteAllText($evidence,'联调样例：Windows 第二阶段耗时 240 ms。',[Text.UTF8Encoding]::new($false))
```

接着在 **W1** 用测试 reader 启动**群监听模式**，它同时提供私聊传输。以下前台命令对应旧 reader 的 `addon dataDir qrFile --watch` 签名。先核对副本 reader 及其加载的 watcher，确保它们使用传入的 `dataDir`、测试群和测试目录；旧版如有固定群号或其他工作路径，只调整副本。依赖校验沿用旧启动器，核对 Node 哈希、QQ 版本与 `wrapper.node` 一致。若本机旧版入口签名不同，用该副本已验证的**测试群监听**启动命令，并显式传同一个 `$qqData`。只启一个 QQ 读取器。

```powershell
$reader = Join-Path $out 'qq-read-latest.cjs'
$addon = Join-Path $nativeDir 'wrapper.node'
$qr = Join-Path $qqData 'group-login.png'
$env:Path = "$nativeDir;$qqVersion\resources\app;$qqVersion;$env:Path"
Remove-Item Env:QQ_REUSE_OWN_SESSION -ErrorAction SilentlyContinue
Push-Location $nativeDir
try { & $nativeNode $reader $addon $qqData $qr --watch } finally { Pop-Location }
```

使用 **Win 测试 QQ** 完成登录。检查 reader 报出的群是测试群。**W2** 先查原生健康状态，直到 `friendVerified: true`、`pushSubscribed: true`、`history: "ready"`；然后启动群 @ 分发并保持运行。开头输出的 `group`、`account`、`owner` 应与测试绑定一致。

```powershell
node $dm $qqData health
$env:QQ_MENTION_CODEX = $codexExe
node $mentions $qqData dispatch
```

**W3** 启动测试协作服务，**W4** 用同一份变量定义查询。Windows 本轮通过 CLI 验收，无需注册 MCP。

```powershell
# W3
$cfg = node $dm $qqData info | ConvertFrom-Json
if ($cfg.accountUin -ne $winQQ -or $cfg.peerUin -ne $macQQ) { throw '账号配对与测试计划不一致' }
node $service serve --state $workState --socket $cfg.socket --token-file $cfg.tokenFile --codex $codexExe --evidence-file $evidence
```

```powershell
# W4
node $service health --state $workState
```

在 Mac **M4** 中进入仓库根目录，执行以下两行。两边均应显示 `ready: true`。这是本端就绪，下面两轮才验证真实送达。

```zsh
b() { ./macos/bridge --profile fieldtest "$@"; }
b collab health
```

## 3. 第一轮：群内点名、建聊、回群

1. 控制者先 @ **Mac 测试号** 问“冷启动是什么意思？”，再点 QQ 的“回复”引用它的回答，追问“再举一个例子”。Win 测试号重复一遍。核对每端在群里自然作答，另一台不抢答，也没有新建工作聊天。
2. 给每个账号各派一项需要一点时间的实际工作，例如 `执行：起草一份三段式发布说明，最后一行写 MAC-G01`（Win 换成 `WIN-G01`）。先看到带任务号的登记回执，再看到终稿。收件与终稿各有自己的去重记录。
3. 任务尚在运行时，引用登记回执先问“到哪一步了？”，再问“刚才说的冷启动为什么重要？”。应能在任务结束前查询已有记录、讨论普通问题。再引用任务回执说“把末行改为 MAC-G02”。若原轮已结束，允许在同一工作对话追加一轮。以终稿实际包含的新标记验收修改；登记回执仅表示桥接收件。
4. 查 M4 的 `b trigger status`，普通回答应显示 `chatIntent=answer/status`，没有工作 thread ID。任务有持久 thread ID。工作中修改的 `workDelivery=accepted` 表示原轮次接收，`next` 表示另排原聊天的下一轮，`uncertain` 需核对原记录。Win 可用 W2 分发日志、群内查询和 Codex 里的工作聊天核对。另用“基于 #任务序号 的终稿另开，写一句标题”检查派生任务。

只更新联调实例时，两端先在联调仓库运行 `git pull --ff-only`。Mac 前台运行的测试 native worker、群分发器分别从更新后的源码重新启动。Win 对独立测试监听器副本重新执行安装脚本并重启测试 reader、分发器。沿用原测试账号和目录，不必重新初始化。Win 如用自选协作目录，在 W2 启动分发器前设置 `$env:QQ_BRIDGE_COLLAB_STATE=$workState`。

## 4. 第二轮：Mac 发起，Windows 供稿并校稿

这是一组**合成计时数据**，验收的是实际腾讯 QQ 传输与共同写作。第一阶段的 80 ms 只预置在 Mac 资料里，第二阶段的 240 ms 只预置在 Windows 资料里。发起任务只写预算和分工。

**M4** 首次执行下列命令。保留 `request_key` 以及返回的 UUID。同一次提交遇到断连时沿用相同 key 和相同正文。

```zsh
request_key="fieldwrite-$(date +%Y%m%d-%H%M%S)"
result=$(printf '{"request_id":"%s","task":"合写一份串行耗时验收说明。Mac 首段用本机资料说明第一阶段，Windows 用其本机资料写第二阶段并注明来源。结尾用阿拉伯数字计算总计和相对 300 ms 预算的差额，注明是联调样例。"}\n' "$request_key" | b collab write)
printf '%s\n' "$result"
round_id=$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
b collab wait --id "$round_id" --timeout-ms 120000
```

超时只需用同一 UUID 再 `wait` 或 `status`。在 **W4** 用 Mac 返回的 UUID 读取本端保存的轮次：

```powershell
$roundId = '填Mac返回的UUID'
node $service status --state $workState --id $roundId
```

在 M4 运行 `b collab status --id "$round_id"`。逐项核对：

- 两端 `id` 相同、`mode=write`、`phase=complete`。Mac 是 `owner`，Windows 是 `reviewer`（协议中第二作者的角色名）。
- `writing.lead` 和 `writing.assignment` 能看出分工；`writing.contribution.passage`、`evidence` 能追到 Windows 提供的第二阶段依据。终稿写明 **320 ms，超预算 20 ms**，并说明为联调数据。
- 两端 `final.answer` 相同，`finalReceipt.event`、`revision` 和 `finalSha256` 逐项相同。Mac 的 `peerReceipt.platform` 为 `win32`，`peerReceipt.finalEvent` 与 `finalReceipt.event` 相同，摘要也相同。事件里应能看到 `brief → received → contribution → final → closed`；中途退修可有 `note/amend` 和新版 `final`。
- 将 UUID、最终版次、摘要、两条标记回复一起记为本轮结果。若状态是 `failed`，先保留 `reason` 和两端状态；停在 `awaiting_close` 时查对端校稿及回执。双方都已确认才算通过。

## 5. 收尾

先保存上述验收结果。Mac 在 M2、M3、M1 依次按 Ctrl+C；Windows 在 W4 用 `node $mentions $qqData disable` 撤销测试群绑定，再在 W3、W1 各按 Ctrl+C（W2 等分发器退出）。W4 可用 `node $dm $qqData unpair` 撤销测试私聊配对。若使用旧端自己的测试 supervisor，按它的实例名仅停止该测试实例。保留测试目录、回执和聊天用于核对。现网服务无需停止或重启。
