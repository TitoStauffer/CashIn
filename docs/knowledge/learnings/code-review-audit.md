# Auditoria histórica de Code Review

**Status:** concluída até o PR #43
**Data da coleta:** 25/10/2026

## Escopo e método

A auditoria consultou em modo somente leitura os 43 Pull Requests existentes no repositório e filtrou revisões formais e comentários inline publicados por `cashin-devagents`.

- 77 revisões formais do App: 52 `APPROVED` e 25 `CHANGES_REQUESTED`.
- 32 rodadas continham algum achado: 25 reprovadas e 7 aprovadas com observações `LOW`.
- 44 ocorrências declaradas: 1 `BLOCKER`, 13 `HIGH`, 22 `MEDIUM` e 8 `LOW`.
- 11 PRs tiveram ao menos uma rodada com `CHANGES_REQUESTED`.
- Um comentário inline repetia o `BLOCKER` formal do PR #18 e não foi contado novamente.

Os números representam ocorrências por rodada. Um mesmo problema reaparece quando foi republicado para outro SHA; a síntese em [`code-review-findings.md`](code-review-findings.md) agrupa reincidências.

O snapshot completo das 77 revisões, com estado, SHA, contagens e link para a fonte original, está em [`../evidence/code-review-index.md`](../evidence/code-review-index.md).

## Inventário por PR

### PR #11 — DEV-26

- Descrição do PR inicialmente não incluía `tools/github-reviewer`; corrigida antes da aprovação. [Revisão](https://github.com/TitoStauffer/CashIn/pull/11#pullrequestreview-5586988527).

### PR #16 — DEV-18

- Corpo do PR manteve contagem de testes e cobertura anteriores após novos commits, repetindo o achado em três SHAs. [Rodada 1](https://github.com/TitoStauffer/CashIn/pull/16#pullrequestreview-5590471305), [rodada 2](https://github.com/TitoStauffer/CashIn/pull/16#pullrequestreview-5590951918), [rodada 3](https://github.com/TitoStauffer/CashIn/pull/16#pullrequestreview-5590965857).

### PR #18 — DEV-29

- `BLOCKER`: Web chamou `/wallet-invites/accept`, enquanto a API expunha `/wallet-invitations/accept`; o fluxo real retornava 404. [Revisão](https://github.com/TitoStauffer/CashIn/pull/18#pullrequestreview-5591622458), [comentário inline](https://github.com/TitoStauffer/CashIn/pull/18#discussion_r4330214791).

### PR #24 — DEV-39

- `HIGH`: migration com `ON CONFLICT DO NOTHING` aceitava forma de pagamento preexistente com natureza errada ou inativa. [Revisão](https://github.com/TitoStauffer/CashIn/pull/24#pullrequestreview-5609195904).
- `LOW`: README continuava descrevendo VA e VR separados após a unificação. [Revisão](https://github.com/TitoStauffer/CashIn/pull/24#pullrequestreview-5609320295).

### PR #25 — DEV-37

- `MEDIUM`: exclusão anunciava progresso atualizado antes de a atualização terminar; uma falha exibia sucesso e erro contraditórios. [Revisão](https://github.com/TitoStauffer/CashIn/pull/25#pullrequestreview-5609054300).

### PR #29 — DEV-43

- `HIGH`: eventos do mesmo PR usavam chaves de concorrência diferentes, permitindo que readiness antigo fosse publicado por último. [Revisão](https://github.com/TitoStauffer/CashIn/pull/29#pullrequestreview-5605663297).

### PR #30 — DEV-44

- `HIGH`: `timer.unref()` permitia o processo encerrar antes do timeout e sem liberar a execução.
- `MEDIUM`: falha ao liberar a reserva era ignorada mesmo quando o resultado retornava `COMPLETED`.
- Evidência: [revisão](https://github.com/TitoStauffer/CashIn/pull/30#pullrequestreview-5605934772).

### PR #33 — DEV-46

- `HIGH`: o detector de prompt injection deixou de analisar o diff e permitiu que instruções presentes apenas nele alcançassem o modelo. [Revisão](https://github.com/TitoStauffer/CashIn/pull/33#pullrequestreview-5608351923).
- `LOW`: faltavam testes para arquivo removido, limite de bytes, binário e resposta sem base64. [Revisão](https://github.com/TitoStauffer/CashIn/pull/33#pullrequestreview-5608397261).

### PR #35 — DEV-48

- `MEDIUM`: redação textual de YAML não removia valores de `env` em mapeamentos flow válidos. [Revisão](https://github.com/TitoStauffer/CashIn/pull/35#pullrequestreview-5609434005).

### PR #36 — DEV-36

- `MEDIUM`: sucesso ao recarregar aportes não limpava o erro anterior; a ação de tentar novamente ficava sem efeito. [Revisão](https://github.com/TitoStauffer/CashIn/pull/36#pullrequestreview-5630867714).

### PR #38 — DEV-38

- `MEDIUM`: voltar rapidamente para carteira/período anterior fazia dados antigos reaparecerem enquanto a nova consulta estava pendente. [Revisão](https://github.com/TitoStauffer/CashIn/pull/38#pullrequestreview-5631278149).

### PR #39 — DEV-51

O PR concentrou 21 ocorrências bloqueantes ou informativas em 13 rodadas:

1. Desfazer não bloqueava os lançamentos cuja versão era verificada, permitindo excluir registro editado concorrentemente.
2. Itens inválidos mantinham data, valor ou sequência incompatíveis com o banco e derrubavam toda a prévia.
3. Upload retornava sessão sem itens e a Web mostrava prévia vazia.
4. Web contava `uncategorized` como confirmável, divergindo da API.
5. Descrição nula contrariava o tipo Web e causava `TypeError` antes da chamada.
   Evidência: [rodada inicial](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5633704229).
6. PATCH podia promover duplicado ou inválido a `valid`, apagando a causa anterior.
7. Edição e confirmação usavam locks em ordens incompatíveis, permitindo corrida e deadlock.
   Evidência: [segunda rodada](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5633860892).
8. Confirmação permanecia habilitada com rascunhos não salvos.
9. Resposta atrasada de outra carteira podia substituir o contexto atual.
   Evidência: [terceira rodada](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634010920).
10. Edição durante PATCH podia ser silenciosamente sobrescrita pela resposta. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634183629).
11. Troca de carteira com falha preservava arquivo escolhido na carteira anterior.
12. Descrição acima do limite do banco fazia rollback da prévia inteira.
    Evidência: [quinta rodada](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634297808).
13. Subcategoria válida com categoria malformada violava a constraint de shape. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634418250).
14. Referência UUID bem formada, porém inexistente ou incompatível, violava FK e descartava a prévia. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634520107).
15. `bodyLimit` do Fastify retornava erro genérico em vez do limite de 10 MB. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634639324).
16. Referências preservadas depois do desfazer impediam excluir categorias sem uso. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634735839).
17. Campos continuavam editáveis durante confirmação e as mudanças eram descartadas. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634881922).
18. Duplicidade podia virar inválido reparável por outro erro e depois ser confirmada.
19. Desfazer ou descartar atualizava a sessão, mas mantinha drafts antigos na tela.
    Evidência: [décima rodada](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5644763711).
20. Item não reparável do parser podia se tornar reparável por possuir também uma data corrigível. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5644848346).
21. Ano zero e caractere U+0000 passavam pela normalização, mas não eram persistíveis no PostgreSQL. [Revisão](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5644937242).

### PR #43 — DEV-63

- `HIGH`: atualização de checkbox pelo App podia gerar CI que cancelava a própria orquestração.
- `HIGH`: cancelamento de runner não garantia a ordem das publicações do Merge Readiness.
- `MEDIUM`: PATCH integral do corpo do PR podia sobrescrever edição concorrente.
  Evidência: [primeira rodada](https://github.com/TitoStauffer/CashIn/pull/43#pullrequestreview-5645356157).
- `HIGH`: corrigir somente o título não recuperava o CI completo que já havia falhado. [Segunda rodada](https://github.com/TitoStauffer/CashIn/pull/43#pullrequestreview-5645393420).
- `MEDIUM`: excluir execuções cujo ator era o App também excluía PR legítimo criado ou atualizado por ele.
- `MEDIUM`: correção de título enquanto o CI ainda estava ativo podia ser descartada e nunca recuperar o fluxo.
  Evidência: [terceira rodada](https://github.com/TitoStauffer/CashIn/pull/43#pullrequestreview-5645458028).

## Uso futuro

Ao encontrar um novo problema, acrescente a evidência neste inventário e atualize um padrão existente em [`code-review-findings.md`](code-review-findings.md). Crie um padrão novo somente quando a causa preventiva ainda não estiver coberta.
