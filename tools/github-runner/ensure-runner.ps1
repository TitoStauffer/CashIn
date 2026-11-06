# Lightweight check used by the Claude Code SessionStart hook. It never downloads or registers
# anything and always exits 0 so a runner problem cannot block a session; its output becomes
# session context, so it only prints when something needs attention.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try {
  . (Join-Path $PSScriptRoot 'runner-common.ps1')
  if (-not (Test-RunnerInstalled)) {
    Write-Output "[github-runner] O runner $RunnerName não está instalado nesta máquina; Code Review e QA do CI ficarão na fila. Para instalar (com confirmação do usuário): powershell -NoProfile -ExecutionPolicy Bypass -File tools/github-runner/install-runner.ps1"
    exit 0
  }
  $result = Start-RunnerProcess -WaitSeconds 0
  if ($result -ne 'already-running') {
    Write-Output "[github-runner] Runner $RunnerName estava parado e foi iniciado."
  }
} catch {
  Write-Output "[github-runner] Não foi possível verificar ou iniciar o runner: $($_.Exception.Message)"
}
exit 0
