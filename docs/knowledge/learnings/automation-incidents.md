# Aprendizados de incidentes da automação

**Status:** histórico vivo
**Última revisão:** 08/11/2026

## Evidência sempre pertence ao SHA

Comentários e aprovações antigos pareciam válidos depois de novos commits. A correção foi vincular relatórios, revisão formal e readiness ao HEAD completo e invalidar evidência desatualizada.

## Comentário não é aprovação formal

Um relatório textual aprovado não satisfaz a regra de revisão do GitHub. A publicação passou a registrar revisão formal com identidade distinta da autora quando suportado.

## Permissões incompletas produzem 403

Checks, status, branch protection e rulesets exigem permissões específicas do GitHub App e podem ser indisponíveis conforme o plano do repositório. O gate deve reportar a limitação como `INCONCLUSIVE`, nunca presumir proteção.

## Nomes de secrets fazem parte do contrato

A divergência entre `GITHUB_APP_*` e `CASHIN_APP_*` impediu autenticação. Cada CLI e workflow agora possui nomes documentados; aliases indiscriminados aumentam ambiguidade.

## Ordem do CI reduz desperdício

Título é validado antes dos jobs caros; API, Web e ferramentas executam antes do Sonar; Agents só iniciam após o CI aprovado. Isso reduz execuções inúteis e consumo do runner/Codex.

## Revisão precisa percorrer todo o diff

Interromper a análise no primeiro achado causou ciclos repetidos. O prompt de Code Review agora exige investigação completa e consolidação dos achados da rodada.

## Índice navegável não é seleção de contexto

Na primeira execução com o vault completo, seguir recursivamente todos os links do índice tentou hidratar todo o histórico de revisões e excedeu o limite seguro antes do Code Review. O índice e o estado atual continuam sempre disponíveis, mas somente o mapa e os arquivos alterados selecionam notas. Catálogos preservam metadados e links navegáveis sem carregar automaticamente cada fonte; qualquer item usado em uma decisão deve ser consultado separadamente.

Na rodada seguinte do [PR #44](https://github.com/TitoStauffer/CashIn/actions/runs/40398776847), todas as notas alteradas foram corretamente incluídas, porém os catálogos de auditoria e aprendizados ainda não estavam declarados como tal. Seus links históricos voltaram a hidratar dezenas de revisões e excederam o limite antes da chamada ao modelo. A correção mantém o conteúdo integral desses catálogos no contexto, mas exige consulta individual da evidência original somente quando ela sustentar uma decisão. A regressão usa um catálogo alterado com 200 referências e confirma que nenhuma delas é carregada automaticamente.

Na terceira rodada do [PR #44](https://github.com/TitoStauffer/CashIn/actions/runs/40399422898), os catálogos já estavam limitados, mas a criação inicial do vault selecionava todas as notas e suas 69 fontes locais verificáveis. O grafo completo somava aproximadamente 585 KB e excedia o teto de 450 KB antes da chamada ao modelo. A correção elevou somente o orçamento do vault para 650 KB, preservando os limites de 160 itens, os então 100 KB por resposta e o bloqueio sem truncamento. As regressões confirmam que um grafo acima do teto antigo é carregado integralmente e que um grafo acima do novo teto continua falhando fechado.

No [PR #50](https://github.com/TitoStauffer/CashIn/pull/50), o grafo ficou abaixo do teto isolado do vault, mas a soma de índices expandidos, fontes e duplicatas produziu um prompt de aproximadamente 603 KB. A reprodução com diagnóstico revelou ainda que o schema estruturado continha `uniqueItems`, palavra-chave rejeitada pelo modo estrito atual da API; como o processo descartava o `stdout` do Codex, a rodada registrava apenas o código de saída 1. A prevenção passou a tratar todo `README.md` do vault e `current-state.md` como navegação sem expansão transitiva, remover do prompt fontes já fornecidas pelo vault, executar o modelo fora da árvore do repositório para não recarregar `AGENTS.md` automaticamente, validar um orçamento final antes da chamada e preservar somente a mensagem segura de erro do evento JSON. O schema deixou a unicidade para a validação determinística já existente após a resposta. Notas selecionadas continuam carregando suas fontes exatas; os índices apenas orientam a seleção pelo mapa.

No [PR #77](https://github.com/TitoStauffer/CashIn/pull/77), o mesmo teto de 650 KB voltou a abortar o Code Review antes de qualquer análise. Medido no mesmo HEAD, o fechamento do vault somava 56 itens e 748.603 bytes, mas o `docs/knowledge` inteiro tinha 166 KB em 29 notas: o que ocupava o orçamento eram **arquivos-fonte citados pelas notas**, carregados por inteiro, com 51,5 KB em `apps/web/src/imports/FinancialImportsPage.tsx` e 38,9 KB em `apps/api/src/financial-imports/postgres-financial-imports.repository.ts`. O aprendizado é que elevar o teto, feito três vezes antes, não resolve este padrão: amarrado ao tamanho do **código**, o orçamento do vault volta a estourar a cada entrega, e a falha é total. A prevenção separa item obrigatório de item opcional, em vez de um número maior. Índice, `current-state`, mapa, notas e evidências do GitHub continuam derrubando a execução quando não couberem, agora com mensagem que nomeia o documento; a fonte apenas citada por uma nota entra como marcador com caminho, tamanho e SHA-256, o mesmo formato já usado para fixtures geradas. A citação permanece verificada no HEAD — fonte inexistente continua sendo erro — e o marcador não apaga o snapshot do arquivo alterado, que é o que precisa ser revisado. As regressões cobrem fonte citada acima do teto virando marcador, nota do vault acima do teto continuando a falhar fechado e corpo do arquivo alterado preservado no prompt apesar do marcador.

A primeira rodada da correção ainda recorria ao mesmo modo de falha, e o Code Review do [PR #78](https://github.com/TitoStauffer/CashIn/pull/78) pegou: separar obrigatório de opcional não basta se o orçamento for distribuído por **ordem de chegada**. A ordem real de `loadVaultContext` admite corpos opcionais antes dos obrigatórios lidos no fim — a travessia de links intercala fonte citada com nota alcançada por link, e as evidências do GitHub vêm por último —, e nada reconsiderava um corpo já admitido. Com `D` documentos obrigatórios, `S` fontes citadas e `E` evidências, o guloso admitia `S` até o teto e deixava folga menor que a maior fonte rejeitada, então o obrigatório só caberia se `E` fosse menor que essa folga: a revisão continuava abortando por inteiro e só a mensagem mudava. A correção aloca por **prioridade**: quando um item obrigatório não cabe, os corpos opcionais já admitidos cedem o seu, maiores primeiro, até ele caber; só então falha fechado. Rebaixar libera bytes, nunca itens, então o teto de itens continua falhando fechado sozinho. Medição que faltava na primeira rodada: no fechamento do PR #77 são 85.904 bytes obrigatórios, 661.662 de fontes citadas e `E = 0`, então aquele caso é destravado pela degradação; já um PR que seleciona as notas de automação tem `E = 10` — é ali que a ordem de chegada quebraria.

A reprodução corrigida ficou registrada pela identidade do GitHub App na revisão formal [#5686923604 do PR #50](https://github.com/TitoStauffer/CashIn/pull/50#pullrequestreview-5686923604), vinculada ao SHA `4fe8bc7d866e19f798e26936cf37d844fbb54ec8`. O Agent gerou decisão estruturada `CHANGES_REQUESTED`, cobriu os 11 arquivos alterados e as seis áreas de risco e identificou um bloqueio funcional real na retomada do dispatcher. Antes da chamada, a mesma entrada produziu um prompt de 387.122 bytes, abaixo do teto final de 500.000 bytes. A revisão durável comprova que a redução não omitiu a matriz de completude nem impediu a geração de evidência estruturada.

## Fixtures autenticadas não devem consumir o orçamento do próprio review

Uma fixture compactada e codificada em Base64, criada para reproduzir um contexto real, fez o PR que a introduziu ultrapassar o orçamento final do prompt ao aparecer integralmente no diff e novamente no snapshot de fontes. Arquivos `*.json.gz.base64` são texto para o Git e para a API, embora seu conteúdo seja um artefato gerado sem valor para inspeção direta do modelo.

A prevenção representa fixtures geradas no diretório de testes do reviewer somente por caminho, tamanho e SHA-256 no contexto dos Agents. A suíte continua decodificando e validando integralmente o artefato versionado; qualquer outro arquivo alterado continua sendo fornecido sem truncamento. A mesma rodada revelou que o `AGENTS.md` inalterado era fornecido tanto como política base confiável quanto como fonte do vault. Quando os conteúdos são idênticos, somente a política base é serializada; uma versão alterada permanece disponível para revisão.

Na revisão formal [#5686657727 do PR #51](https://github.com/TitoStauffer/CashIn/pull/51#pullrequestreview-5686657727), para o SHA `b446ee41f59bfed70b1399f8b25b6a2cb12b0f2e`, foi confirmado que a primeira correção ainda propagava qualquer texto escrito em `stderr`, contrariando a fronteira de diagnóstico seguro declarada. A correção substituiu `stderr` por uma mensagem genérica e passou a extrair detalhes somente do campo `error.message` (ou erro textual) de eventos JSON explicitamente identificados como `error` ou `turn.failed`. Casos negativos garantem que eventos de saída do modelo e erros em tipos não permitidos nunca sejam ecoados.

## Checkout confiável em `workflow_run` deve usar contexto disponível

- **Incidente:** a execução de orquestração `41344172296` falhou nos seis checkouts antes de iniciar os agentes; o log recebeu o SHA correto, mas o checkout terminou com uma ref interna vazia.
- **Causa:** passar um SHA puro explicitamente em `ref` faz o `actions/checkout` separar o commit esperado de uma ref nomeada. No runner Windows, a validação posterior rejeitou a ref vazia mesmo após buscar o commit.
- **Impacto:** Code Review, QA e Quality Gate Coordinator ficaram sem execução mesmo com o CI do PR aprovado.
- **Correção:** omitir `ref` nos seis checkouts para o action preservar a ref confiável e o SHA imutável do contexto do evento; o despacho manual permanece restrito à `master`.
- **Prevenção:** o teste de contrato exige seis checkouts sem `ref` explícito e rejeita qualquer ocorrência de `github.workflow_sha` no workflow.

## Falhas internas precisam tornar o job reexecutável

- **Incidente:** no PR #50, o QA recebeu HTTP 503 antes de produzir seu artefato. O passo falhou, mas `continue-on-error` manteve o job verde; `rerun failed jobs` repetiu apenas o consolidado e reutilizou a ausência de QA.
- **Impacto:** a recuperação padrão do GitHub não alcançou a etapa que precisava ser repetida e exigiu reexecução direcionada pela API.
- **Correção:** depois da tentativa de upload, cada estágio falha o próprio job quando o comando terminou com erro sem decisão e SHA estruturados. Resultados válidos continuam disponíveis para publicação.
- **Prevenção:** testes de contrato exigem a propagação nos três estágios e a documentação operacional distingue falha de infraestrutura de decisão do Agent.

## Mergeabilidade deve ser verificada antes dos Agents

- **Incidente:** Code Review, QA e Coordinator aprovaram o PR #50 antes de o Merge Readiness final detectar que a branch estava `behind` da `master`.
- **Impacto:** atualizar a branch mudou o HEAD e invalidou toda a rodada, consumindo novamente o runner e os Agents.
- **Correção:** cada estágio confirma pela comparação GitHub que o HEAD contém o SHA atual da base antes de carregar o contexto ou chamar o modelo.
- **Prevenção:** estados `behind`, `diverged`, desconhecidos e referências inválidas possuem regressões fail-closed.

## Fontes citadas pelo vault precisam caber no loader

No PR #62 (DEV-56, SHA `a1c9c0a`), o Code Review hospedado falhou antes de chamar o modelo com "GitHub evidence response exceeds the supported size". O motivo: `postgres-financial-imports.repository.ts` e `FinancialImportsPage.tsx`, citados em `domain/imports.md`, cresceram para ~74,6 KB, e a API de conteúdo do GitHub devolve o arquivo em base64. Com isso, a resposta passou do limite de 100 KB por resposta do loader do vault (`vault-context.ts`). Na prática, um arquivo citado precisa ficar abaixo de ~73 KB de fonte. A correção extraiu a lógica de fatura para `postgres-card-statement-imports.ts` e dividiu a página de importação em componentes menores, sem afrouxar o limite. Ao fazer crescer um arquivo citado no vault, confira o tamanho dele antes do push.

O mesmo loader voltou a falhar no [PR #66](https://github.com/TitoStauffer/CashIn/pull/66) (DEV-88, SHA `0263232`), com duas rodadas de agentes derrubadas antes de qualquer análise. A resposta de `/contents` de `postgres-financial-imports.repository.ts` já media 95.744 bytes na `master` — a 4 KB do teto, o que quebraria a revisão de qualquer PR seguinte — e passou a 103.206 bytes com aquela entrega. A primeira tentativa de correção ficou na branch do próprio PR e não surtiu efeito: o workflow de orquestração executa código confiável da `master`, nunca o do PR em revisão, então o limite novo só vale depois de integrado. A correção definitiva veio em PR próprio ([#67](https://github.com/TitoStauffer/CashIn/pull/67#pullrequestreview-5814741410), DEV-90), que não altera o arquivo grande e por isso consegue ser revisado: `MAX_SINGLE_RESPONSE_BYTES` passou de 100 KB para 400 KB, elevando o teto efetivo de fonte de ~73 KB para ~300 KB, com os limites agregados de 160 itens e 650 KB preservados. A prevenção mudou de forma: não é mais manter cada arquivo citado abaixo de ~73 KB, e sim corrigir a ferramenta quando o teto não acomodar um arquivo real, e tratar o tamanho do arquivo como problema de manutenção em entrega própria ([DEV-89](https://titostauffer.atlassian.net/browse/DEV-89)). Ao mudar um limite da orquestração, ajuste na mesma entrega o README e esta nota, porque é deste número que saem as decisões de dividir ou não um arquivo citado.

## Evidência atrasada não é evidência ausente

- **Incidente:** na orquestração do [PR #76](https://github.com/TitoStauffer/CashIn/pull/76) (DEV-94), execução `42443479440` em 08/11/2026 03:37 UTC, o job `Codex Code Review` morreu com exceção antes de qualquer análise: "GitHub Actions job steps are missing or exceed the supported limit". Publicação, QA e Coordinator ficaram `skipped` e o gate ficou `INCONCLUSIVE` esperando um relatório que nunca viria.
- **Causa:** a mesma mensagem cobria três condições — lista ausente, lista vazia e lista acima de 40 passos — e quem disparou foi a **vazia**. Medido depois no mesmo HEAD `6b1861d`, os três jobs estavam íntegros, com 16, 12 e 12 passos. A evidência era legível depois e ilegível naquele instante: a orquestração parte do evento `workflow_run` do CI, então o GitHub já publicou a conclusão do job enquanto `/actions/jobs/{id}` ainda pode responder `steps: []`. Outra falha igual às 02:06 UTC e sucessos às 02:38 e 03:06 são o padrão de um transitório, não de um defeito determinístico.
- **Impacto:** intermitente e total enquanto dura. Qualquer PR podia ter a revisão abortada antes de começar, com recuperação só manual por `workflow_dispatch` da orquestração.
- **Correção:** a lista vazia passa a ser reconsultada até quatro vezes, com três segundos de espera, antes de virar recusa. Esgotadas as tentativas, continua falhando fechado. Lista ausente ou que não seja array é recusada na primeira leitura, porque é payload malformado e não atraso de publicação — repetir a leitura só adiaria a mesma recusa. As três condições passaram a ter mensagens próprias.
- **Prevenção:** uma mensagem única para três condições custou uma investigação inteira, porque o log mandou olhar o limite de 40 antes da causa real. Ao agrupar condições sob uma exceção, dê mensagem própria a cada uma. As regressões cobrem "primeira leitura vazia, segunda completa", "sempre vazia" com a contagem de tentativas, lista ausente sem nova tentativa e a mensagem distinta de cada condição.
- **Limite da correção:** a orquestração executa código confiável da `master`, então a tolerância só vale depois do merge — o mesmo detalhe que já tinha anulado uma primeira tentativa de correção no PR #66.

## Uma entrega grande vira PRs revisáveis

Depois da divisão em módulos, o mesmo PR #62 passou a alterar 37 arquivos, e o Code Review hospedado recusou com "Pull Request changes too many files for a complete agent review context": o limite é de 32 arquivos (`MAX_SOURCE_FILES` em `agent-review-inputs.ts`). A entrega foi dividida em duas partes, cada uma revisada por completo:
- a Tarefa DEV-82, com API, banco e documentação, compatível com o Web existente;
- o PR da DEV-56, só com o Web, que fecha a história.

Planeje histórias grandes como uma sequência de PRs independentes desde o início, em vez de reduzir o contexto da revisão.

## Fontes verificáveis

- Histórico Git e PRs do repositório.
- [`docs/hosted-agent-orchestration.md`](../../hosted-agent-orchestration.md)
- [`tools/github-reviewer/src/codex-cli-agent.ts`](../../../tools/github-reviewer/src/codex-cli-agent.ts)
- [`tools/github-reviewer/src/agent-ci-evidence.ts`](../../../tools/github-reviewer/src/agent-ci-evidence.ts)
