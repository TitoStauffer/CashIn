# GitHub App dos Agents

**Status:** ativo
**Última revisão:** 25/10/2026

## Responsabilidade

O GitHub App `CashIn -- DevAgents` autentica a publicação dos relatórios e da revisão formal. Code Review, QA e Quality Gate Coordinator usam a mesma identidade e assinaturas diferentes no conteúdo.

## Configuração no GitHub Actions

- Secrets: `CASHIN_APP_ID`, `CASHIN_APP_INSTALLATION_ID`, `CASHIN_APP_PRIVATE_KEY`.
- Variable: `CASHIN_APP_BOT_LOGIN`.
- Os valores nunca devem ser registrados no repositório, logs ou documentação.

As CLIs locais legadas aceitam nomes `GITHUB_APP_*`; os workflows hospedados usam `CASHIN_APP_*`. Não criar aliases sem necessidade: preserve o contrato de cada ponto de entrada.

## Segurança

- Tokens de instalação são temporários e não são persistidos.
- A chave privada deve existir apenas no cofre de secrets ou em arquivo local ignorado.
- Permissões devem ser mínimas: leitura das evidências necessárias e escrita em Pull Requests para relatórios/revisões.
- O App não recebe autorização de merge por esta integração.

## Fontes verificáveis

- [`tools/github-reviewer/README.md`](../../../tools/github-reviewer/README.md)
- [`tools/github-reviewer/src/github-app.mjs`](../../../tools/github-reviewer/src/github-app.mjs)
- [`.github/workflows/agent-orchestration.yml`](../../../.github/workflows/agent-orchestration.yml)
- [`.github/workflows/merge-readiness.yml`](../../../.github/workflows/merge-readiness.yml)
