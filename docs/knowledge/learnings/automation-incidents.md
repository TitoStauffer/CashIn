# Aprendizados de incidentes da automação

**Status:** histórico vivo
**Última revisão:** 28/10/2026

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

Na terceira rodada do [PR #44](https://github.com/TitoStauffer/CashIn/actions/runs/40399422898), os catálogos já estavam limitados, mas a criação inicial do vault selecionava todas as notas e suas 69 fontes locais verificáveis. O grafo completo somava aproximadamente 585 KB e excedia o teto de 450 KB antes da chamada ao modelo. A correção elevou somente o orçamento do vault para 650 KB, preservando os limites de 160 itens, 100 KB por resposta e o bloqueio sem truncamento. As regressões confirmam que um grafo acima do teto antigo é carregado integralmente e que um grafo acima do novo teto continua falhando fechado.

No [PR #50](https://github.com/TitoStauffer/CashIn/pull/50), o grafo ficou abaixo do teto isolado do vault, mas a soma de índices expandidos, fontes e duplicatas produziu um prompt de aproximadamente 603 KB. A reprodução com diagnóstico revelou ainda que o schema estruturado continha `uniqueItems`, palavra-chave rejeitada pelo modo estrito atual da API; como o processo descartava o `stdout` do Codex, a rodada registrava apenas o código de saída 1. A prevenção passou a tratar todo `README.md` do vault e `current-state.md` como navegação sem expansão transitiva, remover do prompt fontes já fornecidas pelo vault, executar o modelo fora da árvore do repositório para não recarregar `AGENTS.md` automaticamente, validar um orçamento final antes da chamada e preservar somente a mensagem segura de erro do evento JSON. O schema deixou a unicidade para a validação determinística já existente após a resposta. Notas selecionadas continuam carregando suas fontes exatas; os índices apenas orientam a seleção pelo mapa.

A reprodução corrigida ficou registrada pela identidade do GitHub App na revisão formal [#5686923604 do PR #50](https://github.com/TitoStauffer/CashIn/pull/50#pullrequestreview-5686923604), vinculada ao SHA `4fe8bc7d866e19f798e26936cf37d844fbb54ec8`. O Agent gerou decisão estruturada `CHANGES_REQUESTED`, cobriu os 11 arquivos alterados e as seis áreas de risco e identificou um bloqueio funcional real na retomada do dispatcher. Antes da chamada, a mesma entrada produziu um prompt de 387.122 bytes, abaixo do teto final de 500.000 bytes. A revisão durável comprova que a redução não omitiu a matriz de completude nem impediu a geração de evidência estruturada.

## Fixtures autenticadas não devem consumir o orçamento do próprio review

Uma fixture compactada e codificada em Base64, criada para reproduzir um contexto real, fez o PR que a introduziu ultrapassar o orçamento final do prompt ao aparecer integralmente no diff e novamente no snapshot de fontes. Arquivos `*.json.gz.base64` são texto para o Git e para a API, embora seu conteúdo seja um artefato gerado sem valor para inspeção direta do modelo.

A prevenção representa fixtures geradas no diretório de testes do reviewer somente por caminho, tamanho e SHA-256 no contexto dos Agents. A suíte continua decodificando e validando integralmente o artefato versionado; qualquer outro arquivo alterado continua sendo fornecido sem truncamento. A mesma rodada revelou que o `AGENTS.md` inalterado era fornecido tanto como política base confiável quanto como fonte do vault. Quando os conteúdos são idênticos, somente a política base é serializada; uma versão alterada permanece disponível para revisão.

Na revisão formal [#5686657727 do PR #51](https://github.com/TitoStauffer/CashIn/pull/51#pullrequestreview-5686657727), para o SHA `b446ee41f59bfed70b1399f8b25b6a2cb12b0f2e`, foi confirmado que a primeira correção ainda propagava qualquer texto escrito em `stderr`, contrariando a fronteira de diagnóstico seguro declarada. A correção substituiu `stderr` por uma mensagem genérica e passou a extrair detalhes somente do campo `error.message` (ou erro textual) de eventos JSON explicitamente identificados como `error` ou `turn.failed`. Casos negativos garantem que eventos de saída do modelo e erros em tipos não permitidos nunca sejam ecoados.

## Fontes verificáveis

- Histórico Git e PRs do repositório.
- [`docs/hosted-agent-orchestration.md`](../../hosted-agent-orchestration.md)
- [`tools/github-reviewer/src/codex-cli-agent.ts`](../../../tools/github-reviewer/src/codex-cli-agent.ts)
