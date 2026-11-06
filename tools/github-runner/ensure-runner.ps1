# Lightweight check used by the Claude Code SessionStart hook. The hook runs only the copy installed
# in %LOCALAPPDATA%\CashInGithubRunner\scripts, never this file from a working tree. It never
# downloads or registers anything and always exits 0 so a runner problem cannot block a session;
# its output becomes session context, so it only prints when something needs attention.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try {
  . (Join-Path $PSScriptRoot 'runner-common.ps1')
  if (-not (Test-RunnerInstalled)) {
    Write-Output "[github-runner] O runner $RunnerName não está instalado nesta máquina; Code Review e QA do CI ficarão na fila. Para instalar (com confirmação do usuário): powershell -NoProfile -ExecutionPolicy Bypass -File tools/github-runner/install-runner.ps1"
    exit 0
  }
  # Waits briefly so the message reflects whether the listener process really came up.
  $result = Start-RunnerProcess -WaitSeconds 10
  if ($result -eq 'started') {
    Write-Output "[github-runner] Runner $RunnerName estava parado e foi iniciado."
  } elseif ($result -eq 'foreign-listener') {
    Write-Output "[github-runner] Há um processo Runner.Listener de outra instalação em execução; $RunnerName não foi iniciado para evitar um segundo listener. Encerre o processo antigo."
  } elseif ($result -eq 'starting') {
    Write-Output "[github-runner] Runner $RunnerName estava parado; a inicialização foi disparada, mas o processo ainda não foi confirmado. Consulte $LogDir\runner.log."
  }
} catch {
  Write-Output "[github-runner] Não foi possível verificar ou iniciar o runner: $($_.Exception.Message)"
}
exit 0
