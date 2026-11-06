# Shared settings and helpers for the local self-hosted runner that executes the
# Codex Code Review and QA jobs (label "codex-plus"). Compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest

$script:RunnerRepository = 'TitoStauffer/CashIn'
$script:RunnerName = 'cashin-codex-plus-windows'
# config.cmd always adds the default labels (self-hosted, Windows, X64); only custom labels go here.
$script:RunnerCustomLabels = 'codex-plus'

# Pinned official releases. Update version and SHA-256 together (see README).
$script:RunnerVersion = '2.338.2'
$script:RunnerSha256 = 'a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc'
$script:PwshVersion = '7.6.9'
$script:PwshSha256 = 'ce7484804c0f0ad4dda10c958e71acdaf7eebfb22505c1b480f89e0e9f1da94d'

$script:InstallRoot = Join-Path $env:LOCALAPPDATA 'CashInGithubRunner'
$script:RunnerDir = Join-Path $script:InstallRoot 'runner'
$script:PwshDir = Join-Path $script:InstallRoot 'pwsh'
$script:ScriptsDir = Join-Path $script:InstallRoot 'scripts'
$script:LogDir = Join-Path $script:InstallRoot 'logs'
$script:CodexBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$script:StartupShortcutName = 'CashIn GitHub Runner.lnk'

function Test-RunnerInstalled {
  return (Test-Path (Join-Path $script:RunnerDir '.runner')) -and (Test-Path (Join-Path $script:RunnerDir 'run.cmd'))
}

function Get-RunnerProcess {
  $listenerPath = Join-Path $script:RunnerDir 'bin\Runner.Listener.exe'
  return @(Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $listenerPath } catch { $false }
  })
}

# The Codex desktop app stores its CLI under a hash-named folder that changes on every update,
# so the executable is resolved again on each start instead of being pinned.
function Get-LatestCodexExecutable {
  if (-not (Test-Path $script:CodexBinRoot)) { return $null }
  $candidate = Get-ChildItem -Path $script:CodexBinRoot -Filter 'codex.exe' -Recurse -Depth 1 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  return $null
}

# Job steps inherit the environment of the process that starts the runner. The Windows runner
# does not apply a ".path" file to job steps, so PATH and CODEX_EXECUTABLE are set on this process.
function Set-RunnerEnvironment {
  $codex = Get-LatestCodexExecutable
  if (-not $codex) {
    throw "Codex CLI não encontrado em $script:CodexBinRoot. Abra o app Codex e faça login antes de iniciar o runner."
  }
  $pwshPath = Join-Path $script:PwshDir 'pwsh.exe'
  if (-not (Test-Path $pwshPath)) {
    throw "PowerShell 7 portátil não encontrado em $script:PwshDir. Rode install-runner.ps1 novamente."
  }

  $pathEntries = @($script:PwshDir)
  foreach ($scope in 'User', 'Machine') {
    $value = [Environment]::GetEnvironmentVariable('Path', $scope)
    if ($value) { $pathEntries += $value.Split(';') | Where-Object { $_ } }
  }
  $env:Path = ($pathEntries | Select-Object -Unique) -join ';'
  $env:CODEX_EXECUTABLE = $codex
  return $codex
}

function Start-RunnerProcess {
  param([int]$WaitSeconds = 0)

  if (-not (Test-RunnerInstalled)) {
    throw "Runner não instalado em $script:RunnerDir. Rode tools/github-runner/install-runner.ps1."
  }
  if (@(Get-RunnerProcess).Count -gt 0) { return 'already-running' }

  [void](Set-RunnerEnvironment)
  New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null
  $log = Join-Path $script:LogDir 'runner.log'
  $runCmd = Join-Path $script:RunnerDir 'run.cmd'
  Start-Process -FilePath $env:ComSpec `
    -ArgumentList '/d', '/c', "`"`"$runCmd`" >> `"$log`" 2>&1`"" `
    -WorkingDirectory $script:RunnerDir `
    -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ($WaitSeconds -gt 0 -and (Get-Date) -lt $deadline) {
    if (@(Get-RunnerProcess).Count -gt 0) { return 'started' }
    Start-Sleep -Milliseconds 500
  }
  return $(if (@(Get-RunnerProcess).Count -gt 0) { 'started' } else { 'starting' })
}
