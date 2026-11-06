# Deterministic checks for the local runner scripts, safe to run in CI or on any machine:
# nothing is downloaded, registered or started, and LOCALAPPDATA points to a temporary folder.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Child processes (ensure-runner.ps1, bash) write UTF-8; read their output with the same encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$scriptsDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptsDir '..\..')).Path
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

# 2. The SessionStart hook runs only the installed copy, never a script from the working tree.
$hookCommand = (Get-Content -Raw -Encoding UTF8 (Join-Path $repoRoot '.claude/settings.json') | ConvertFrom-Json).hooks.SessionStart[0].hooks[0].command
Assert-True ($hookCommand -notmatch 'CLAUDE_PROJECT_DIR') 'o hook não referencia scripts da árvore de trabalho ($CLAUDE_PROJECT_DIR)'
Assert-True ($hookCommand -match 'LOCALAPPDATA/CashInGithubRunner/scripts/ensure-runner\.ps1') 'o hook executa ensure-runner.ps1 da pasta instalada'

# 3. The installer never puts the registration token on the config.cmd command line.
$installer = Get-Content -Raw (Join-Path $scriptsDir 'install-runner.ps1')
Assert-True ($installer -notmatch '--token') 'install-runner.ps1 não passa --token ao config.cmd'
Assert-True ($installer -match '\$env:ACTIONS_RUNNER_INPUT_TOKEN = \$token' -and $installer -match 'Remove-Item Env:\\ACTIONS_RUNNER_INPUT_TOKEN') 'install-runner.ps1 entrega o token por variável de ambiente e a remove em seguida'

$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("runner-scripts-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
$previousLocalAppData = $env:LOCALAPPDATA
$previousPath = $env:Path
try {
  $env:LOCALAPPDATA = $sandbox

  # 4. ensure-runner.ps1 never fails the session: without a runner it exits 0 and explains how to install.
  $hostExe = (Get-Process -Id $PID).Path
  $output = & $hostExe -NoProfile -NonInteractive -File (Join-Path $scriptsDir 'ensure-runner.ps1') 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  Assert-True ($exitCode -eq 0) "ensure-runner.ps1 termina com código 0 sem runner instalado (obtido: $exitCode)"
  Assert-True ($output -match 'não está instalado' -and $output -match 'install-runner\.ps1') 'ensure-runner.ps1 orienta a instalação quando o runner não existe'

  # 5. The hook command itself, run by bash with a fake "powershell" that records its arguments.
  $bash = @('C:\Program Files\Git\bin\bash.exe', '/bin/bash', '/usr/bin/bash') | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $bash) {
    $failures.Add('bash não encontrado para testar o comando do hook')
    Write-Output 'FAIL - bash não encontrado para testar o comando do hook'
  } else {
    $shimDir = Join-Path $sandbox 'shim'
    New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $shimDir 'powershell'), "#!/bin/sh`necho `"SHIM `$*`"`n")
    if ($env:OS -ne 'Windows_NT' -and (Get-Command chmod -ErrorAction SilentlyContinue)) { & chmod +x (Join-Path $shimDir 'powershell') }
    # The driver goes through a file: Windows PowerShell 5.1 mangles embedded quotes in native arguments.
    $driver = Join-Path $sandbox 'run-hook.sh'
    [System.IO.File]::WriteAllText($driver, @'
shim="$HOOK_SHIM"
if command -v cygpath >/dev/null 2>&1; then shim="$(cygpath -u "$shim")"; fi
export PATH="$shim:/usr/bin:/bin"
eval "$HOOK_CMD"
'@.Replace("`r`n", "`n"))
    $runHook = {
      param([string]$ShimDirectory)
      $env:HOOK_CMD = $hookCommand
      $env:HOOK_SHIM = $ShimDirectory
      $result = & $bash $driver 2>&1 | Out-String
      return [pscustomobject]@{ Output = $result; ExitCode = $LASTEXITCODE }
    }

    $missing = & $runHook $shimDir
    Assert-True ($missing.ExitCode -eq 0 -and $missing.Output -match 'não foram encontrados' -and $missing.Output -notmatch 'SHIM') 'sem cópia instalada, o hook termina com 0, orienta a instalação e não executa nada'

    $installedDir = Join-Path $sandbox 'CashInGithubRunner\scripts'
    New-Item -ItemType Directory -Force -Path $installedDir | Out-Null
    Set-Content -Path (Join-Path $installedDir 'ensure-runner.ps1') -Value '# installed copy'
    $installed = & $runHook $shimDir
    $calledPath = ([regex]::Match($installed.Output, '-File (.+)$', 'Multiline').Groups[1].Value).Trim() -replace '\\', '/'
    $expectedPath = (Join-Path $installedDir 'ensure-runner.ps1') -replace '\\', '/'
    Assert-True ($installed.ExitCode -eq 0 -and $calledPath -eq $expectedPath) "o hook executa a cópia instalada (obtido: $calledPath)"
    Assert-True ($installed.Output -notmatch [regex]::Escape(($scriptsDir -replace '\\', '/'))) 'o hook nunca executa ensure-runner.ps1 da árvore de trabalho'

    $noPowershell = & $runHook (Join-Path $sandbox 'empty')
    Assert-True ($noPowershell.ExitCode -eq 0 -and -not $noPowershell.Output.Trim()) 'sem powershell (fora do Windows), o hook termina com 0 em silêncio'
    Remove-Item Env:\HOOK_CMD, Env:\HOOK_SHIM -ErrorAction SilentlyContinue
  }

  # 6. Shared helpers behave as documented, isolated in the sandbox.
  . (Join-Path $scriptsDir 'runner-common.ps1')
  Assert-True ($InstalledScriptNames -contains 'ensure-runner.ps1') 'o instalador copia ensure-runner.ps1 para a pasta instalada'
  Assert-True (-not (Test-RunnerInstalled)) 'Test-RunnerInstalled é falso sem instalação'
  Assert-True ($null -eq (Get-LatestCodexExecutable)) 'Get-LatestCodexExecutable é nulo sem o app Codex'

  $older = Join-Path $CodexBinRoot 'old-hash'
  $newer = Join-Path $CodexBinRoot 'new-hash'
  New-Item -ItemType Directory -Force -Path $older, $newer | Out-Null
  Set-Content -Path (Join-Path $older 'codex.exe') -Value ''
  Set-Content -Path (Join-Path $newer 'codex.exe') -Value ''
  (Get-Item (Join-Path $older 'codex.exe')).LastWriteTime = (Get-Date).AddDays(-2)
  Assert-True ((Get-LatestCodexExecutable) -eq (Join-Path $newer 'codex.exe')) 'sem versão de arquivo, Get-LatestCodexExecutable usa o codex.exe mais recente'
  # A higher file version wins even when the file is older (e.g. a restored or re-copied build).
  function Get-ExecutableVersion([string]$Path) { if ($Path -like '*old-hash*') { return [version]'0.60.1' } return [version]'0.59.9' }
  Assert-True ((Get-LatestCodexExecutable) -eq (Join-Path $older 'codex.exe')) 'Get-LatestCodexExecutable escolhe o codex.exe de maior versão'

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

  # 7. Listener detection separates this installation from any other one.
  $ownPath = Join-Path $RunnerDir 'bin\Runner.Listener.exe'
  $split = Split-ListenerProcess -Processes @(
    [pscustomobject]@{ Path = $ownPath.ToUpperInvariant() },
    [pscustomobject]@{ Path = 'C:\old-runner\bin\Runner.Listener.exe' },
    [pscustomobject]@{ Path = $null }
  ) -ListenerPath $ownPath
  Assert-True (@($split.Own).Count -eq 1 -and @($split.Foreign).Count -eq 2) 'listener de outra pasta ou de caminho ilegível é tratado como de outra instalação'

  New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
  Set-Content -Path (Join-Path $RunnerDir '.runner') -Value '{}'
  Set-Content -Path (Join-Path $RunnerDir 'run.cmd') -Value ''
  function Get-ListenerProcess { return @([pscustomobject]@{ Path = 'C:\old-runner\bin\Runner.Listener.exe' }) }
  Assert-True ((Start-RunnerProcess -WaitSeconds 0) -eq 'foreign-listener') 'Start-RunnerProcess não inicia um segundo listener quando há outro em execução'
  function Get-ListenerProcess { return @([pscustomobject]@{ Path = $ownPath }) }
  Assert-True ((Start-RunnerProcess -WaitSeconds 0) -eq 'already-running') 'Start-RunnerProcess reconhece o listener desta instalação'

  # 8. The runner log is rotated before a start, keeping one previous file.
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $log = Join-Path $LogDir 'runner.log'
  [System.IO.File]::WriteAllBytes($log, (New-Object byte[] 2048))
  Assert-True (-not (Invoke-RunnerLogRotation -LogPath $log -MaxBytes 4096) -and (Test-Path $log)) 'log abaixo do limite não é rotacionado'
  Assert-True ((Invoke-RunnerLogRotation -LogPath $log -MaxBytes 1024) -and -not (Test-Path $log) -and (Test-Path "$log.1")) 'log acima do limite vira runner.log.1'

  # 9. Repair re-extracts unless the folder holds a complete extraction of the pinned archive.
  $archiveDir = Join-Path $sandbox 'archive'
  New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
  Set-Content -Path (Join-Path $archiveDir 'tool.exe') -Value ''
  Assert-True (-not (Test-ArchiveInstalled -Destination $archiveDir -Marker 'tool.exe' -ExpectedSha256 'ABC')) 'pasta sem marcador de extração precisa ser reinstalada'
  Write-ArchiveMarker -Destination $archiveDir -ExpectedSha256 'ABC'
  Assert-True (Test-ArchiveInstalled -Destination $archiveDir -Marker 'tool.exe' -ExpectedSha256 'abc') 'pasta com o arquivo e o SHA-256 fixado é mantida'
  Assert-True (-not (Test-ArchiveInstalled -Destination $archiveDir -Marker 'tool.exe' -ExpectedSha256 'def')) 'troca da versão fixada exige nova extração'
  Remove-Item (Join-Path $archiveDir 'tool.exe')
  Assert-True (-not (Test-ArchiveInstalled -Destination $archiveDir -Marker 'tool.exe' -ExpectedSha256 'abc')) 'pasta sem o executável marcador precisa ser reinstalada'
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
  $env:Path = $previousPath
  Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) { throw "$($failures.Count) verificação(ões) dos scripts do runner falharam." }
Write-Output 'Scripts do runner validados.'
