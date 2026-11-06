# Runner self-hosted local (Codex Code Review e QA)

Os jobs **Codex Code Review** e **Codex QA** do workflow `agent-orchestration.yml` rodam no runner self-hosted `cashin-codex-plus-windows` (labels `self-hosted, Windows, X64, codex-plus`), porque o Codex CLI usa a assinatura ChatGPT já autenticada nesta máquina. Sem esse runner online, a orquestração fica na fila e o `Merge Readiness` permanece `INCONCLUSIVE`. Veja [`docs/hosted-agent-orchestration.md`](../../docs/hosted-agent-orchestration.md).

Estes scripts tornam a instalação reproduzível e não exigem administrador. Tudo fica em `%LOCALAPPDATA%\CashInGithubRunner`:

| Pasta | Conteúdo |
|---|---|
| `runner/` | `actions/runner` oficial, registro e `_work` dos jobs |
| `pwsh/` | PowerShell 7 portátil, exigido pelos jobs (`shell: pwsh`) |
| `scripts/` | Cópia de `runner-common.ps1` e `start-runner.ps1` usada pelo atalho de inicialização |
| `logs/runner.log` | Saída do runner |

## Pré-requisitos

- Windows x64 com o app Codex instalado e logado (o CLI fica em `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`).
- GitHub CLI autenticado (`gh auth status`) com uma conta administradora do repositório.

## Instalar ou reparar

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/github-runner/install-runner.ps1
```

O script baixa o runner e o PowerShell das releases oficiais, confere o SHA-256 fixado em `runner-common.ps1`, registra o runner com `--replace` (assume um registro offline de mesmo nome), cria o atalho `CashIn GitHub Runner.lnk` na pasta Inicializar do Windows e inicia o runner. Execuções seguintes reaproveitam o que já existe. Use `-Reregister` para forçar novo registro e `-NoStart` para não iniciar ao final. O token de registro é obtido pelo `gh` na hora, usado apenas pelo `config.cmd` e nunca gravado em arquivo versionado.

## Início automático

- **Login no Windows:** o atalho de inicialização executa `scripts/start-runner.ps1`.
- **Sessões do Claude Code:** o hook `SessionStart` em `.claude/settings.json` executa `ensure-runner.ps1`, que inicia o runner se estiver parado. Ele nunca baixa nem registra nada, sempre termina com sucesso e só escreve algo quando o runner precisa de atenção.

A cada início, o `codex.exe` mais recente é localizado novamente e o processo que inicia o runner recebe `CODEX_EXECUTABLE` e um `PATH` com o PowerShell portátil à frente; os jobs herdam esse ambiente. O runner no Windows não aplica um arquivo `.path` aos jobs, por isso o ambiente do processo é o mecanismo usado. Assim, atualizações do app Codex não quebram o runner.

## Atualizar versões

1. Consulte a release desejada: `gh api repos/actions/runner/releases/latest` e `gh api repos/PowerShell/PowerShell/releases/latest` (campo `digest` do asset `win-x64`).
2. Atualize versão e SHA-256 em `runner-common.ps1`.
3. Remova a pasta correspondente em `%LOCALAPPDATA%\CashInGithubRunner` com o runner parado e rode o instalador novamente.

O runner também se autoatualiza quando o GitHub exige uma versão mais nova.

## Remover

Com o runner parado, rode `runner\config.cmd remove --token <token>` (token de `gh api -X POST repos/TitoStauffer/CashIn/actions/runners/remove-token --jq .token`), apague `%LOCALAPPDATA%\CashInGithubRunner` e o atalho `CashIn GitHub Runner.lnk` da pasta Inicializar.
