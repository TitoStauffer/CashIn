# Estado atual do projeto

**Status:** atualizado pela DEV-116
**Última revisão:** 08/11/2026
**Ticket de criação:** [DEV-64](https://titostauffer.atlassian.net/browse/DEV-64)

## Produto disponível

- Cadastro, confirmação de e-mail, login e sessão autenticada.
- Carteira pessoal por usuário e carteiras adicionais compartilháveis.
- Convite por e-mail, solicitação de acesso por link e administração de membros pelo proprietário.
- Categorias e subcategorias por carteira e natureza.
- Entradas separadas por saldo em dinheiro, VA/VR e AHO.
- Despesas com forma de pagamento, incluindo cartão de crédito e benefícios.
- Cartões de crédito, ciclos de fatura, pagamento integral ou parcial e conciliação do pagamento com o extrato bancário. Estornos abatem a fatura e também os totais de despesa e o gasto por categoria do dashboard.
- Metas de investimento, aportes, encerramento e progresso calculado.
- Dashboard financeiro com resumo, comparação, metas e categorias de maior gasto.
- Fundação de importação financeira com upload, prévia, edição, confirmação atômica, histórico e desfazer.
- Regras de categorização por carteira, criadas só com confirmação do usuário e aplicadas às novas prévias.
- Importação autorizada antes de ler o arquivo, atribuída a quem a enviou no histórico e recuperável quando a requisição é interrompida.
- Importação de faturas de cartão (OFX e CSV), com cartão obrigatório, fatura calculada por item e corrigível na prévia, estornos como créditos na fatura e duplicidade por cartão. A página de cartões mostra os estornos e bloqueia o pagamento sem saldo devedor.

## Estado da importação

A infraestrutura e a tela existem. O parser padrão da API interpreta extratos bancários OFX 1.x e 2.x, faturas de cartão em OFX e CSV configurável, com inspeção, amostra e modelos reutilizáveis por carteira. Itens sem categoria podem receber sugestão de regras explícitas da carteira. Consulte [`domain/imports.md`](domain/imports.md).

## Automação de entrega

O fluxo ativo executa validação de título, API, Web, ferramentas de automação, SonarQube, Code Review, QA, Quality Gate Coordinator e Merge Readiness. Desde a DEV-116 cada rodada tem um trilho: o trilho leve dispensa o QA somente quando **todo** arquivo alterado é `*.md`, `*.test.*` ou `docs/knowledge/context-map.json`, e qualquer outro caminho exige o trilho completo. Todas as outras etapas continuam obrigatórias nos dois trilhos. Consulte [`automation/delivery-flow.md`](automation/delivery-flow.md). O merge permanece sob responsabilidade do Product Manager quando todas as evidências estão aprovadas. O pós-merge atualiza a issue Jira associada de forma idempotente.

## Limitações conhecidas

- A API não possui lint configurado.
- O envio de e-mail e os rate limiters usam mecanismos adequados ao MVP local; filas e estado compartilhado são necessários para múltiplas instâncias.
- O runner de agentes é Windows self-hosted e depende de máquina ligada, usuário autenticado e Claude Code CLI disponível (Codex CLI apenas como alternativa com `AGENT_RUNTIME=codex`).
- Múltiplos extratos ou faturas no mesmo arquivo continuam recusados.
- Transferências entre carteiras do mesmo usuário estão disponíveis de ponta a ponta: a prévia da importação concilia a linha com a carteira do outro lado ou com uma transferência já registrada, e o dashboard mostra o enviado e o recebido no fluxo de caixa, sem virar receita ou despesa.
- A conciliação do pagamento da fatura está disponível de ponta a ponta: a prévia da importação deixa escolher a fatura que o pagamento liquida, e a tela do cartão mostra os pagamentos, o que falta pagar e aceita pagamento parcial.
- Não existe papel somente-leitura em carteira compartilhada: todo membro pode importar. O e-mail de outro membro continua visível apenas ao proprietário.
- Mobile e deploy em nuvem estão fora do estado atual.

## Fontes verificáveis

Estas fontes comprovam o panorama, mas só devem ser abertas quando a afirmação correspondente for relevante ao ticket:

- `README.md`
- `apps/api/src/app.ts`
- `apps/web/src/App.tsx`
- `apps/api/src/financial-imports/financial-imports.parser.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/agent-orchestration.yml`
- [PR #43](https://github.com/TitoStauffer/CashIn/pull/43)
