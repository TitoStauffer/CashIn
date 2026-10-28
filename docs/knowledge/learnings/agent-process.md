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

## Autenticar a procedência antes de recuperar artefatos

- **Padrão:** `agent-recovery-authenticate-provenance`
- **Causa:** nome, SHA e fingerprint do resultado comprovavam consistência, mas não que o artefato tinha sido produzido pelo workflow confiável.
- **Impacto:** um artefato de outra execução poderia chegar ao publicador privilegiado usando um nome previsível.
- **Prevenção:** validar workflow, evento, branch, repositório, job, etapa de upload e vínculo do artefato ao run antes do download.
- **Detecção:** regressões rejeitam outro workflow, upload falho e artefato associado a outro run.
- **Evidência:** achado HIGH do Code Review do PR #49.

## Manter resultados inconclusivos publicáveis

- **Padrão:** `agent-inconclusive-evidence-publishable`
- **Causa:** a conversão para `INCONCLUSIVE` preservava lacunas que o mesmo validador rejeitava na publicação.
- **Impacto:** limitações reais não eram registradas e a recuperação repetia a falha.
- **Prevenção:** normalizar áreas e critérios ausentes como inconclusivos, deduplicar evidências e validar novamente o resultado fechado antes da publicação.
- **Detecção:** regressão cobre runtime, artefato normalizado e publicador.
- **Evidência:** primeiro achado MEDIUM do Code Review do PR #49.

## Dar precedência segura a resultados mistos de QA

- **Padrão:** `agent-qa-mixed-results-fail-closed`
- **Causa:** `FAILED` exigia `CHANGES_REQUESTED`, enquanto `INCONCLUSIVE` exigia uma decisão incompatível na mesma rodada.
- **Impacto:** QA exaustivo com falha comprovada e limitação independente não possuía resultado publicável.
- **Prevenção:** publicar a rodada mista como `INCONCLUSIVE`, preservar todas as falhas e bloquear as etapas dependentes.
- **Detecção:** regressão combina um critério reprovado com outro não avaliado.
- **Evidência:** segundo achado MEDIUM do Code Review do PR #49.

## Manter chaves únicas em manifestos JSON

- **Padrão:** `json-manifest-unique-keys`
- **Causa:** `package.json` continha duas entradas idênticas para `preflight-result`.
- **Impacto:** parsers descartavam silenciosamente uma definição e permitiam divergência futura.
- **Prevenção:** manter uma única definição por script e revisar o diff do manifesto.
- **Detecção:** parsing e revisão estrutural do manifesto durante testes e Code Review.
- **Evidência:** achado LOW do Code Review do PR #49.
