# Deterministic checks for the local runner scripts, safe to run in CI or on any machine:
# nothing is downloaded, registered or started, and LOCALAPPDATA points to a temporary folder.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptsDir = $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]
function Assert-True([bool]$condition, [string]$message) {
  if ($condition) { Write-Output "ok   - $message" } else { Write-Output "FAIL - $message"; $failures.Add($message) }
}

# 1. Every script parses without syntax errors and keeps a UTF-8 BOM for Windows PowerShell 5.1.
foreach ($name in 'runner-common.ps1', 'install-runner.ps1', 'start-runner.ps1', 'ensure-runner.ps1') {
  $path = Join-Path $scriptsDir $name
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
  Assert-True (@($errors).Count -eq 0) "$name não tem erros de sintaxe"
  $bytes = [System.IO.File]::ReadAllBytes($path)
  Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) "$name está em UTF-8 com BOM"
}

$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("runner-scripts-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
$previousLocalAppData = $env:LOCALAPPDATA
$previousPath = $env:Path
try {
  $env:LOCALAPPDATA = $sandbox

  # 2. The SessionStart hook never fails the session: without a runner it exits 0 and explains how to install.
  $hostExe = (Get-Process -Id $PID).Path
  $output = & $hostExe -NoProfile -NonInteractive -File (Join-Path $scriptsDir 'ensure-runner.ps1') 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  Assert-True ($exitCode -eq 0) "ensure-runner.ps1 termina com código 0 sem runner instalado (obtido: $exitCode)"
  Assert-True ($output -match 'não está instalado' -and $output -match 'install-runner\.ps1') 'ensure-runner.ps1 orienta a instalação quando o runner não existe'

  # 3. Shared helpers behave as documented, isolated in the sandbox.
  . (Join-Path $scriptsDir 'runner-common.ps1')
  Assert-True (-not (Test-RunnerInstalled)) 'Test-RunnerInstalled é falso sem instalação'
  Assert-True ($null -eq (Get-LatestCodexExecutable)) 'Get-LatestCodexExecutable é nulo sem o app Codex'

  $older = Join-Path $CodexBinRoot 'old-hash'
  $newer = Join-Path $CodexBinRoot 'new-hash'
  New-Item -ItemType Directory -Force -Path $older, $newer | Out-Null
  Set-Content -Path (Join-Path $older 'codex.exe') -Value ''
  Set-Content -Path (Join-Path $newer 'codex.exe') -Value ''
  (Get-Item (Join-Path $older 'codex.exe')).LastWriteTime = (Get-Date).AddDays(-2)
  Assert-True ((Get-LatestCodexExecutable) -eq (Join-Path $newer 'codex.exe')) 'Get-LatestCodexExecutable escolhe o codex.exe mais recente'

  $previousCodex = $env:CODEX_EXECUTABLE
  New-Item -ItemType Directory -Force -Path $PwshDir | Out-Null
  Set-Content -Path (Join-Path $PwshDir 'pwsh.exe') -Value ''
  Remove-Item -Recurse -Force $CodexBinRoot
  $env:CODEX_EXECUTABLE = $null
  $resolvedCodex = Set-RunnerEnvironment
  Assert-True ($null -eq $resolvedCodex -and -not $env:CODEX_EXECUTABLE) 'Set-RunnerEnvironment não exige o Codex, que é opcional'
  Assert-True ($env:Path.Split(';')[0] -eq $PwshDir) 'Set-RunnerEnvironment coloca o PowerShell portátil à frente do PATH'
  $env:Path = $previousPath
  $env:CODEX_EXECUTABLE = $previousCodex

  $startFailed = $false
  try { [void](Start-RunnerProcess -WaitSeconds 0) } catch { $startFailed = $_.Exception.Message -match 'não instalado' }
  Assert-True $startFailed 'Start-RunnerProcess recusa iniciar sem instalação'
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
  $env:Path = $previousPath
  Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) { throw "$($failures.Count) verificação(ões) dos scripts do runner falharam." }
Write-Output 'Scripts do runner validados.'
