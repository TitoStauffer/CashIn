# Aprendizados de incidentes da automação

**Status:** histórico vivo
**Última revisão:** 26/10/2026

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

## Fontes verificáveis

- Histórico Git e PRs do repositório.
- [`docs/hosted-agent-orchestration.md`](../../hosted-agent-orchestration.md)
- [`tools/github-reviewer/src/codex-cli-agent.ts`](../../../tools/github-reviewer/src/codex-cli-agent.ts)
