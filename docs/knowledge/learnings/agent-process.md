# Aprendizados do processo dos Agents

**Status:** ativo
**Última revisão:** 28/10/2026

## Consolidar a rodada antes de publicar

- **Padrão:** `agent-round-complete-before-feedback`
- **Causa:** Code Review e QA encerravam a investigação no primeiro problema encontrado.
- **Impacto:** achados já detectáveis apareciam em rodadas posteriores, repetindo CI, modelo, correção e validação.
- **Prevenção:** Code Review percorre todos os arquivos e áreas de risco; QA percorre todos os critérios seguros e independentes, mesmo após uma falha.
- **Detecção:** o contrato estruturado rejeita arquivos, áreas de risco ou critérios sem resultado e evidência.
- **Evidência:** DEV-67 e histórico operacional registrado em [`automation-incidents.md`](automation-incidents.md).

## Recuperar publicação sem repetir análise

- **Padrão:** `agent-publish-reuse-approved-artifact`
- **Causa:** a repetição de um job de publicação falho também repetia jobs dependentes que chamavam o modelo.
- **Impacto:** consumo desnecessário da cota e risco de resultados diferentes para o mesmo contexto.
- **Prevenção:** recuperar o artefato estruturado da execução original e executar somente o publicador idempotente.
- **Detecção:** a recuperação exige run, PR, SHA e hash de contexto ainda válidos; qualquer divergência falha de forma fechada.
- **Evidência:** falha de publicação do Quality Gate Coordinator observada após o PR #48.

## Analisar prompt injection somente no conteúdo novo

- **Padrão:** `agent-prompt-injection-only-new-content`
- **Causa:** snapshots completos de arquivos alterados incluíam fixtures de segurança legítimas que já existiam na branch padrão.
- **Impacto:** o detector bloqueava a orquestração como `INCONCLUSIVE`, embora o PR não tivesse introduzido a instrução suspeita.
- **Prevenção:** verificar título, descrição e somente linhas adicionadas no diff; manter snapshots completos como contexto não confiável para a revisão.
- **Detecção:** testes cobrem conteúdo suspeito adicionado, conteúdo apenas contextual e fixtures presentes somente no snapshot.
- **Evidência:** falso positivo do Code Review no PR #49 da DEV-67.
