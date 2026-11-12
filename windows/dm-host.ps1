param(
    [Parameter(Mandatory=$true)][ValidateSet('dm-start','dm-status','dm-stop')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Node,
    [Parameter(Mandatory=$true)][string]$Native,
    [Parameter(Mandatory=$true)][string]$Data,
    [Parameter(Mandatory=$true)][string]$Reader,
    [Parameter(Mandatory=$true)][string]$Supervisor
)
$ErrorActionPreference = 'Stop'
# The existing supervisor holds its account mutex while invoking this script.
$pair = & $Node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'paired-dm.cjs') $Data info | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot read local pairing' }
$scope = Join-Path $Data 'paired-dm'
$record = Join-Path $scope 'dm-only-status.json'
$loginImage = Join-Path $scope 'dm-login.png'
$loginPage = Join-Path $scope 'dm-login.html'
$accountPathArg = '(?:^|[="\s])' + [regex]::Escape($Data.TrimEnd('\','/')) + '[\\/]?(?=["\s]|$)'
$hostsUsingData = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine -match $accountPathArg -or ($_.ExecutablePath -eq $Node -and $_.CommandLine.Contains($Data)))
})
$privateReaders = @($hostsUsingData | Where-Object {
    $_.ExecutablePath -eq $Node -and $_.CommandLine.Contains($Reader) -and $_.CommandLine.TrimEnd().EndsWith('--dm-only')
})
if ($Action -eq 'dm-status') {
    $result = [ordered]@{ paired=[bool]$pair.enabled; phase='stopped' }
    if ($privateReaders.Count -eq 1) {
        $result.processId = $privateReaders[0].ProcessId
        $result.phase = 'starting'
        if (Test-Path -LiteralPath $record) {
            $saved = Get-Content -LiteralPath $record -Raw -Encoding utf8 | ConvertFrom-Json
            if ($saved.pid -eq $result.processId) { $result.phase = $saved.phase }
        }
        if ($result.phase -eq 'scan-required' -and (Test-Path -LiteralPath $loginImage)) { $result.loginPage = $loginPage }
        if ($result.phase -in 'ready','verifying-friend','friend-or-history-unavailable') {
            $probe = & $Node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'paired-dm.cjs') $Data health | ConvertFrom-Json
            $result.friendVerified = $probe.friendVerified
            if ($probe.friendVerified) {
                $result.pushSubscribed = $probe.pushSubscribed
                $result.history = $probe.history
                $result.historyDetail = $probe.historyDetail
                $result.phase = if ($probe.history -eq 'ready') { 'ready' } else { 'friend-verified' }
            }
        }
    }
    [pscustomobject]$result | ConvertTo-Json -Compress
    return
}
if ($Action -eq 'dm-stop') {
    foreach ($proc in $privateReaders) { Stop-Process -Id $proc.ProcessId -ErrorAction Stop }
    if (Test-Path -LiteralPath $loginImage) { Remove-Item -LiteralPath $loginImage }
    Write-Output 'Private-only QQ reader stopped'
    return
}
if (!$pair.enabled) { throw 'Configure the local pair before private-only startup' }
if ($privateReaders.Count -eq 1) { Write-Output "Private-only QQ reader already running PID=$($privateReaders[0].ProcessId)"; return }
if ($hostsUsingData.Count) { throw 'Another account process is using this QQ state directory' }

# Keep the existing installation's pinned QQ addon and Node runtime checks.
$settings = [IO.File]::ReadAllText($Supervisor)
$version = [regex]::Match($settings,"(?m)^\s*\x24version\s*=\s*'([^'\r\n]+)'").Groups[1].Value
$expected = [regex]::Match($settings,"Get-FileHash\s+-LiteralPath\s+\x24node\)\.Hash\s+-ne\s+'([0-9A-Fa-f]{64})'").Groups[1].Value
if (!$expected -or ![IO.Path]::IsPathRooted($version)) { throw 'Unknown pinned QQ runtime. Verify the existing account supervisor.' }
if ((Get-FileHash -LiteralPath $Node).Hash -ne $expected) { throw 'Node version mismatch' }
$addon = Join-Path $Native 'wrapper.node'
$vendor = Join-Path $version 'resources/app/wrapper.node'
if ((Get-FileHash -LiteralPath $addon).Hash -ne (Get-FileHash -LiteralPath $vendor).Hash) { throw 'QQ addon mismatch' }

# An official QQ process can use a different data directory for this same account.
# If it has the standard account DB open, leave that session to its current owner.
$documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
$official = Join-Path (Join-Path $documents ('Tencent Files/' + $pair.accountUin)) 'nt_qq/nt_db'
if (Test-Path -LiteralPath $official) {
    foreach ($file in (Get-ChildItem -LiteralPath $official -File | Where-Object { $_.Extension -eq '.db' -or $_.Name.EndsWith('.db-wal') })) {
        try { $handle=[IO.File]::Open($file.FullName,'Open','Read','None'); $handle.Dispose() }
        catch { throw 'The official QQ profile for this paired account is in use; existing session preserved' }
    }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'dm-login.html') -Destination $loginPage -Force
if (Test-Path -LiteralPath $loginImage) { Remove-Item -LiteralPath $loginImage }
$arguments = '--disable-warning=ExperimentalWarning "{0}" "{1}" "{2}" "{3}" --dm-only' -f $Reader,$addon,$Data,$loginImage
$originalPath = $env:Path
$originalReuse = $env:QQ_REUSE_OWN_SESSION
try {
    $env:Path = "$Native;$version\resources\app;$version;$env:SystemRoot\System32"
    $env:QQ_REUSE_OWN_SESSION = '1'
    $process = Start-Process -WindowStyle Hidden -FilePath $Node -ArgumentList $arguments -WorkingDirectory $Native -PassThru
} finally {
    $env:Path = $originalPath
    $env:QQ_REUSE_OWN_SESSION = $originalReuse
}
Write-Output "Private-only QQ reader started PID=$($process.Id)"
