param([Parameter(Mandatory=$true)][string]$WatcherRoot)
$ErrorActionPreference = 'Stop'
$outputs = (Resolve-Path -LiteralPath (Join-Path $WatcherRoot 'outputs')).Path
$watcher = (Resolve-Path -LiteralPath (Join-Path $outputs 'qq-target-watch.cjs')).Path
$source = [IO.File]::ReadAllText($watcher)
$signature = 'function watch({session, callbacks, self, target, dataDir, ready}) {'
$installed = $source.Contains("require('./paired-dm.cjs').startPairedDm(")
$mentionsInstalled = $source.Contains("require('./group-mentions.cjs').startMentions(")
if ((!$installed -or !$mentionsInstalled) -and ([regex]::Matches($source, [regex]::Escape($signature))).Count -ne 1) {
    throw 'Expected one supported QQ watcher entry. Inspect the local watcher before installing.'
}
function Write-Atomic([string]$target, [byte[]]$bytes) {
    $temporary = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllBytes($temporary, $bytes)
        if ([IO.File]::Exists($target)) {
            [IO.File]::Replace($temporary, $target, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($temporary,$target)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}
function Replace-Unique([string]$text,[string]$old,[string]$new) {
    if (([regex]::Matches($text,[regex]::Escape($old))).Count -ne 1) {
        throw 'Unsupported local QQ login entry. Inspect the site-specific reader before installing.'
    }
    return $text.Replace($old,$new)
}
$readerFile = Join-Path $outputs 'qq-read-latest.cjs'
$controlFile = Join-Path $outputs 'qq-target.ps1'
$readerChanges = $null
$controlChanges = $null
if ((Test-Path -LiteralPath $readerFile) -and (Test-Path -LiteralPath $controlFile)) {
    $readerCode=[IO.File]::ReadAllText($readerFile)
    if (!$readerCode.Contains("require('./dm-only.cjs').loginState(")) {
        $nl = if ($readerCode.Contains("`r`n")) { "`r`n" } else { "`n" }
        $point='const [addon, dataDir, qrFile] = process.argv.slice(2);'
        $readerCode=Replace-Unique $readerCode $point ($point+$nl+"const dmOnly = process.argv[5] === '--dm-only' ? require('./dm-only.cjs').loginState(dataDir) : null;")
        $point='function startSession({uin, uid}) {'
        $readerCode=Replace-Unique $readerCode $point ($point+$nl+"  if (dmOnly && String(uin) !== dmOnly.accountUin) return exit('Scanned account differs from the local pair', 3);")
        $point="    if (process.argv[5] === '--watch') {"
        $branch=@'
    if (dmOnly) {
      groupsRequested = true;
      setImmediate(() => dmOnly.start({session,callbacks,self:{uin,uid},
        ready:() => clearTimeout(loginDeadline),offline:() => process.exit(4)})
        .catch(() => exit('Private-only QQ startup failed', 3)));
      return;
    }
'@
        $readerCode=Replace-Unique $readerCode $point (($branch -replace "\r?\n",$nl)+$nl+$point)
        $point='LocalLoginInfoList.filter(account => account.isQuickLogin)'
        $readerCode=Replace-Unique $readerCode $point 'LocalLoginInfoList.filter(account => account.isQuickLogin && (!dmOnly || String(account.uin) === dmOnly.accountUin))'
        $point='    fs.writeFileSync(qrFile,png);'
        $readerCode=Replace-Unique $readerCode $point ($point+$nl+"    if (dmOnly) dmOnly.mark('scan-required');")
        $readerChanges=$readerCode
    }
    $controlCode=[IO.File]::ReadAllText($controlFile)
    if (!$controlCode.Contains("Join-Path `$PSScriptRoot 'dm-host.ps1'")) {
        $nl = if ($controlCode.Contains("`r`n")) { "`r`n" } else { "`n" }
        $point='[ValidateSet('
        $controlCode=Replace-Unique $controlCode $point ($point+"'dm-start','dm-status','dm-stop',")
        $point="if (!`$lock.WaitOne(10000)) { throw 'Another monitor operation is in progress' }"+$nl+'try {'
        $branch=@'
    if ($Action -in 'dm-start','dm-status','dm-stop') {
        & (Join-Path $PSScriptRoot 'dm-host.ps1') -Action $Action -Node $node -Native $native -Data $data -Reader $reader -Supervisor $PSCommandPath
        return
    }
'@
        $controlCode=Replace-Unique $controlCode $point ($point+$nl+($branch -replace "\r?\n",$nl))
        $controlChanges=$controlCode
    }
}
foreach ($name in 'paired-dm.cjs','dm-only.cjs','dm-host.ps1','dm-login.html') {
    Write-Atomic (Join-Path $outputs $name) ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $name)))
}
if ($readerChanges) { Write-Atomic $readerFile ([Text.UTF8Encoding]::new($false).GetBytes($readerChanges)) }
if ($controlChanges) { Write-Atomic $controlFile ([Text.UTF8Encoding]::new($false).GetBytes($controlChanges)) }
$groupFiles = Join-Path $outputs 'mention-runtime'
[IO.Directory]::CreateDirectory($groupFiles) | Out-Null
foreach ($name in 'group.cjs','native.cjs','events.cjs','mention.cjs','mention_routing.py','trigger.py','triggerctl.py','mention_dispatch.py') {
    Write-Atomic (Join-Path $groupFiles $name) ([IO.File]::ReadAllBytes((Join-Path (Join-Path $PSScriptRoot '../macos') $name)))
}
Write-Atomic (Join-Path $outputs 'group-mentions.cjs') ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'group-mentions.cjs')))
if (!$mentionsInstalled) {
    $hook = "  void require('./group-mentions.cjs').startMentions({session,callbacks,self,dataDir}).catch(err=>console.error('Group mentions:',err.message));"
    $source = $source.Replace($signature,$signature + [Environment]::NewLine + $hook)
}
if (!$installed) {
    $hook = @'
  void require('./paired-dm.cjs').startPairedDm({session,callbacks,self,dataDir,onReady:ready,onOffline:()=>process.exit(4),
    onError:err=>console.error('Paired DM:',err.message)}).catch(err=>console.error('Paired DM startup:',err.message));
'@
    $newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }
    $updated = $source.Replace($signature, $signature + $newline + ($hook -replace "\r?\n",$newline))
    $source = $updated
}
if (!$installed -or !$mentionsInstalled) {
    Write-Atomic $watcher ([Text.UTF8Encoding]::new($false).GetBytes($source))
}
Write-Output "Paired DM and group mention adapters installed in $outputs"
