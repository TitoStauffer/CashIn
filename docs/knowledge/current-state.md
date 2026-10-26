# Estado atual do projeto

**Status:** confirmado na `master` em `e18912d`
**Última revisão:** 25/10/2026
**Ticket de criação:** [DEV-64](https://titostauffer.atlassian.net/browse/DEV-64)

## Produto disponível

- Cadastro, confirmação de e-mail, login e sessão autenticada.
- Carteira pessoal por usuário e carteiras adicionais compartilháveis.
- Convite por e-mail, solicitação de acesso por link e administração de membros pelo proprietário.
- Categorias e subcategorias por carteira e natureza.
- Entradas separadas por saldo em dinheiro, VA/VR e AHO.
- Despesas com forma de pagamento, incluindo cartão de crédito e benefícios.
- Cartões de crédito, ciclos de fatura e quitação integral.
- Metas de investimento, aportes, encerramento e progresso calculado.
- Dashboard financeiro com resumo, comparação, metas e categorias de maior gasto.
- Fundação de importação financeira com upload, prévia, edição, confirmação atômica, histórico e desfazer.

## Estado da importação

A infraestrutura e a tela existem, mas o parser padrão da API ainda é `UnsupportedFinancialImportParser`. A interpretação real de OFX e CSV permanece entrega separada. Consulte [`domain/imports.md`](domain/imports.md).

## Automação de entrega

O fluxo ativo executa validação de título, API, Web, ferramentas de automação, SonarQube, Code Review, QA, Quality Gate Coordinator e Merge Readiness. O merge permanece sob responsabilidade do Product Manager quando todas as evidências estão aprovadas. O pós-merge atualiza a issue Jira associada de forma idempotente.

## Limitações conhecidas

- A API não possui lint configurado.
- O envio de e-mail e os rate limiters usam mecanismos adequados ao MVP local; filas e estado compartilhado são necessários para múltiplas instâncias.
- O runner de agentes é Windows self-hosted e depende de máquina ligada, usuário autenticado e Codex CLI disponível.
- O parser OFX/CSV ainda não está implementado.
- Mobile e deploy em nuvem estão fora do estado atual.

## Fontes verificáveis

- [`README.md`](../../README.md)
- [`apps/api/src/app.ts`](../../apps/api/src/app.ts)
- [`apps/web/src/App.tsx`](../../apps/web/src/App.tsx)
- [`apps/api/src/financial-imports/financial-imports.parser.ts`](../../apps/api/src/financial-imports/financial-imports.parser.ts)
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- [`.github/workflows/agent-orchestration.yml`](../../.github/workflows/agent-orchestration.yml)
- [PR #43](https://github.com/TitoStauffer/CashIn/pull/43)
