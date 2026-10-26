# Vault de conhecimento do CashIn

**Status:** ativo
**Última revisão:** 26/10/2026
**Responsável:** equipe de engenharia e Agents que alterarem o comportamento documentado

Este diretório é a memória operacional versionada do projeto. Ele orienta a investigação inicial, registra decisões e aponta para as fontes verificáveis. Código, migrations, workflows e configurações continuam sendo as evidências executáveis.

## Como usar

1. Leia este índice e [`current-state.md`](current-state.md).
2. Abra apenas as notas relacionadas ao ticket.
3. Consulte os arquivos indicados em **Fontes verificáveis** antes de concluir algo ou editar código.
4. Registre divergências encontradas e atualize a nota afetada na mesma entrega.
5. Não armazene secrets, tokens, dados pessoais, logs integrais ou valores de ambientes reais.

O `context-map.json` seleciona automaticamente apenas as notas relacionadas aos caminhos alterados. Índices extensos declarados em `catalogs` continuam disponíveis para navegação, mas seus links não são carregados em massa; consulte a fonte original de um item antes de usá-lo em uma decisão.

## Roteiro por tipo de trabalho

| Trabalho | Leitura inicial |
| --- | --- |
| API ou regra de negócio | [`architecture/api.md`](architecture/api.md), depois a nota em `domain/` |
| Interface Web | [`architecture/web.md`](architecture/web.md), contrato funcional relacionado e nota em `domain/` |
| Banco ou migration | [`architecture/database.md`](architecture/database.md) e serviço/repositório do domínio |
| Carteiras e compartilhamento | [`domain/wallets.md`](domain/wallets.md) |
| Entradas, despesas, benefícios ou metas | [`domain/transactions.md`](domain/transactions.md) |
| Cartões e faturas | [`domain/credit-cards.md`](domain/credit-cards.md) |
| Importação OFX/CSV | [`domain/imports.md`](domain/imports.md) |
| CI, revisão, QA ou merge | [`automation/delivery-flow.md`](automation/delivery-flow.md) e runbook correspondente |
| GitHub App | [`automation/github-app.md`](automation/github-app.md) |
| Merge Readiness | [`automation/merge-readiness.md`](automation/merge-readiness.md) |
| Dispatcher/Jira | [`automation/jira-dispatcher.md`](automation/jira-dispatcher.md) |
| SonarQube | [`automation/sonarqube.md`](automation/sonarqube.md) |
| Aprendizados de Code Review | [`learnings/code-review-findings.md`](learnings/code-review-findings.md) e [`learnings/code-review-audit.md`](learnings/code-review-audit.md) |
| Evidências e validação do vault | [`evidence/README.md`](evidence/README.md) |
| Mudança estrutural | [`ADR-001 — modelo de carteiras`](decisions/ADR-001-wallet-model.md), [`ADR-002 — orquestração`](decisions/ADR-002-agent-orchestration.md) e arquitetura afetada |

## Mapa do vault

- [`current-state.md`](current-state.md): fotografia funcional e limitações conhecidas.
- [`architecture/system-overview.md`](architecture/system-overview.md): visão do sistema; o roteiro acima direciona para API, Web e banco.
- [`domain/transactions.md`](domain/transactions.md): regras de movimentações; o roteiro direciona para os demais contextos do domínio.
- [`automation/delivery-flow.md`](automation/delivery-flow.md): fluxo de entrega; o roteiro direciona para cada integração operacional.
- [`decisions/ADR-001-wallet-model.md`](decisions/ADR-001-wallet-model.md): índice inicial das decisões arquiteturais duráveis.
- [`learnings/README.md`](learnings/README.md): aprendizados obtidos em reviews, incidentes e ciclos de correção.
- [`evidence/README.md`](evidence/README.md): snapshots auditáveis, manifesto das fontes e relatório de validação.
- [`runbooks/failed-ci.md`](runbooks/failed-ci.md): diagnóstico inicial; há runbooks específicos para falhas de Agents e Jira.

## Regra de manutenção

Atualize o vault quando uma entrega mudar contrato público, regra de negócio, arquitetura, operação, segurança ou automação. Alterações internas sem impacto nessas áreas não exigem uma nova nota. Toda afirmação operacional deve apontar para uma fonte verificável ou ser marcada como hipótese/limitação.

Valide a estrutura e os links locais antes de publicar mudanças:

```powershell
pwsh -File tools/knowledge/test-validate-vault.ps1
pwsh -File tools/knowledge/validate-vault.ps1
```

## Fontes gerais

- [`AGENTS.md`](../../AGENTS.md)
- [`README.md`](../../README.md)
- [`docs/ci.md`](../ci.md)
- [`docs/hosted-agent-orchestration.md`](../hosted-agent-orchestration.md)
- [`docs/financial-imports-contract.md`](../financial-imports-contract.md)
- [`docs/dashboard-summary-contract.md`](../dashboard-summary-contract.md)
