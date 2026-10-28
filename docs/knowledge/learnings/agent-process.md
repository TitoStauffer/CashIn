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
- **Evidência:** PR #49, revisão [`5684284143`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684284143), SHA `47a5df0a1a714d1881ac4781ba29265c858731e8`.

## Manter resultados inconclusivos publicáveis

- **Padrão:** `agent-inconclusive-evidence-publishable`
- **Causa:** a conversão para `INCONCLUSIVE` preservava lacunas que o mesmo validador rejeitava na publicação.
- **Impacto:** limitações reais não eram registradas e a recuperação repetia a falha.
- **Prevenção:** normalizar áreas e critérios ausentes como inconclusivos, deduplicar evidências e validar novamente o resultado fechado antes da publicação.
- **Detecção:** regressão cobre runtime, artefato normalizado e publicador.
- **Evidência:** PR #49, revisão [`5684284143`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684284143), SHA `47a5df0a1a714d1881ac4781ba29265c858731e8`.

## Dar precedência segura a resultados mistos de QA

- **Padrão:** `agent-qa-mixed-results-fail-closed`
- **Causa:** `FAILED` exigia `CHANGES_REQUESTED`, enquanto `INCONCLUSIVE` exigia uma decisão incompatível na mesma rodada.
- **Impacto:** QA exaustivo com falha comprovada e limitação independente não possuía resultado publicável.
- **Prevenção:** publicar a rodada mista como `INCONCLUSIVE`, preservar todas as falhas e bloquear as etapas dependentes.
- **Detecção:** regressão combina um critério reprovado com outro não avaliado.
- **Evidência:** PR #49, revisão [`5684284143`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684284143), SHA `47a5df0a1a714d1881ac4781ba29265c858731e8`.

## Manter chaves únicas em manifestos JSON

- **Padrão:** `json-manifest-unique-keys`
- **Causa:** `package.json` continha duas entradas idênticas para `preflight-result`.
- **Impacto:** parsers descartavam silenciosamente uma definição e permitiam divergência futura.
- **Prevenção:** manter uma única definição por script e revisar o diff do manifesto.
- **Detecção:** parsing e revisão estrutural do manifesto durante testes e Code Review.
- **Evidência:** PR #49, revisão [`5684284143`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684284143), SHA `47a5df0a1a714d1881ac4781ba29265c858731e8`.

## Correlacionar artefatos à tentativa que os produziu

- **Padrão:** `agent-recovery-select-producing-attempt`
- **Causa:** a API de jobs com `filter=all` retorna todas as tentativas de uma execução, enquanto o nome previsível do artefato não identifica sozinho a tentativa produtora.
- **Impacto:** a recuperação podia rejeitar uma execução válida ou selecionar evidência de uma tentativa anterior.
- **Prevenção:** correlacionar `created_at` do artefato com o intervalo do job, selecionar a tentativa bem-sucedida mais recente e baixar pelo ID autenticado.
- **Detecção:** regressão cobre duas tentativas válidas e confirma a seleção exclusiva do artefato mais recente.
- **Evidência:** PR #49, revisão [`5684471719`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684471719), SHA `5628865a67bc944f7f6f3ccbe9cf414d4b447daa`.

## Validar envelopes externos antes de confiar nos campos

- **Padrão:** `agent-preflight-validate-untrusted-envelope`
- **Causa:** o preflight convertia JSON externo diretamente para o tipo interno e comparava o SHA do resultado com ele próprio.
- **Impacto:** decisão desconhecida, SHA inválido ou evidência incompleta podiam atravessar a validação estrutural.
- **Prevenção:** tratar JSON como `unknown`, validar o envelope completo e comparar com um SHA esperado fornecido de forma independente.
- **Detecção:** regressões rejeitam decisão desconhecida, SHA incompleto e ausência de evidência estruturada.
- **Evidência:** PR #49, revisão [`5684471719`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684471719), SHA `5628865a67bc944f7f6f3ccbe9cf414d4b447daa`.

## Vincular aprendizados à evidência exata

- **Padrão:** `vault-learning-exact-review-evidence`
- **Causa:** referências genéricas ao PR não permitiam localizar a rodada e o SHA que originaram o aprendizado.
- **Impacto:** auditoria e reutilização do conhecimento exigiam reconstrução manual do histórico.
- **Prevenção:** registrar link da revisão, identificador e SHA exatos em cada aprendizado derivado de Code Review ou QA.
- **Detecção:** revisão documental confirma a presença dos três identificadores na evidência.
- **Evidência:** PR #49, revisão [`5684471719`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684471719), SHA `5628865a67bc944f7f6f3ccbe9cf414d4b447daa`.

## Rejeitar datas inválidas antes de comparar intervalos

- **Padrão:** `temporal-validation-reject-nan`
- **Causa:** comparações relacionais com `NaN` retornam falso e podem transformar uma guarda por exclusão em validação permissiva.
- **Impacto:** a recuperação aceitava um artifact sem comprovar temporalmente qual tentativa o produziu.
- **Prevenção:** exigir timestamps finitos e intervalo ordenado antes de avaliar pertencimento temporal.
- **Detecção:** regressões cobrem cada data ausente, cada data inválida e intervalo invertido.
- **Evidência:** PR #49, revisão [`5684655538`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684655538), SHA `5a21a75806d40530ca55f1c17bccde45e209cdaf`.

## Manter documentação de segurança alinhada ao runtime

- **Padrão:** `security-docs-match-runtime`
- **Causa:** o detector foi restringido ao conteúdo novo do PR, mas dois trechos continuaram afirmando que snapshots completos também eram verificados.
- **Impacto:** a documentação prometia uma cobertura de segurança inexistente e poderia induzir decisões incorretas.
- **Prevenção:** atualizar documentação e implementação na mesma mudança sempre que o limite de confiança de uma guarda for alterado.
- **Detecção:** busca documental pelos termos da guarda e revisão do contrato de testes.
- **Evidência:** PR #49, revisão [`5684655538`](https://github.com/TitoStauffer/CashIn/pull/49#pullrequestreview-5684655538), SHA `5a21a75806d40530ca55f1c17bccde45e209cdaf`.
