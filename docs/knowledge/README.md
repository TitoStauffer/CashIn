# Vault de conhecimento do CashIn

**Status:** ativo
**Última revisão:** 25/10/2026
**Responsável:** equipe de engenharia e Agents que alterarem o comportamento documentado

Este diretório é a memória operacional versionada do projeto. Ele orienta a investigação inicial, registra decisões e aponta para as fontes verificáveis. Código, migrations, workflows e configurações continuam sendo as evidências executáveis.

## Como usar

1. Leia este índice e [`current-state.md`](current-state.md).
2. Abra apenas as notas relacionadas ao ticket.
3. Consulte os arquivos indicados em **Fontes verificáveis** antes de concluir algo ou editar código.
4. Registre divergências encontradas e atualize a nota afetada na mesma entrega.
5. Não armazene secrets, tokens, dados pessoais, logs integrais ou valores de ambientes reais.

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
| Mudança estrutural | ADRs em [`decisions/`](decisions/) e arquitetura afetada |

## Mapa do vault

- [`current-state.md`](current-state.md): fotografia funcional e limitações conhecidas.
- [`architecture/`](architecture/): visão do sistema, API, Web e banco.
- [`domain/`](domain/): regras de negócio consolidadas por contexto.
- [`automation/`](automation/): fluxo de entrega e integrações operacionais.
- [`decisions/`](decisions/): decisões arquiteturais duráveis em formato ADR.
- [`learnings/`](learnings/): aprendizados obtidos em reviews, incidentes e ciclos de correção.
- [`runbooks/`](runbooks/): diagnóstico e recuperação passo a passo.

## Regra de manutenção

Atualize o vault quando uma entrega mudar contrato público, regra de negócio, arquitetura, operação, segurança ou automação. Alterações internas sem impacto nessas áreas não exigem uma nova nota. Toda afirmação operacional deve apontar para uma fonte verificável ou ser marcada como hipótese/limitação.

## Fontes gerais

- [`AGENTS.md`](../../AGENTS.md)
- [`README.md`](../../README.md)
- [`docs/ci.md`](../ci.md)
- [`docs/hosted-agent-orchestration.md`](../hosted-agent-orchestration.md)
- [`docs/financial-imports-contract.md`](../financial-imports-contract.md)
- [`docs/dashboard-summary-contract.md`](../dashboard-summary-contract.md)
