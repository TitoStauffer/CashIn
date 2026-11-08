# Aprendizados do processo dos Agents

**Status:** ativo
**Última revisão:** 08/11/2026

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
- **Ocorrência no PR #60, revisão [`5795231298`](https://github.com/TitoStauffer/CashIn/pull/60#pullrequestreview-5795231298) (`781298d`):** ao trocar o runtime dos agentes para o Claude Code, `AGENTS.md` e trechos da documentação continuaram descrevendo o Codex como runtime ativo, e o isolamento "sem ferramentas" era garantido só pelos argumentos. Uma sondagem confirmou que, embora a sessão não registrasse ferramentas, carregava o `CLAUDE.md` global, executava hooks do usuário e ativava memória automática. A correção isola a configuração (`--setting-sources project`, `disableAllHooks`, `autoMemoryEnabled: false`, `claudeMdExcludes`, `--system-prompt` próprio), verifica o evento `init` em tempo de execução e recusa o resultado se houver ferramenta além de `StructuredOutput`, MCP ou hook, e atualiza toda a documentação na mesma entrega. A prevenção é comprovar a fronteira de segurança com evidência do próprio runtime, não com flags, e buscar o nome do runtime anterior em toda a documentação ao trocá-lo.
- **Reincidência no PR #60, revisão [`5799386919`](https://github.com/TitoStauffer/CashIn/pull/60#pullrequestreview-5799386919) (`75ba56541093680b4d5a7820f810334b631e0703`):** o `tools/github-reviewer/README.md` ainda trazia a autenticação do Codex e o `CODEX_HOME` como pré-requisitos do runtime padrão, e o orçamento de 750 KB como limite único do prompt. A correção separou os pré-requisitos do Claude (padrão) e do Codex (alternativa). Desta vez a busca incluiu, além do nome do runtime anterior, os termos operacionais associados a ele: variáveis de ambiente, limites e credenciais.
- **Reincidência no PR #67, revisão [`5814741410`](https://github.com/TitoStauffer/CashIn/pull/67#pullrequestreview-5814741410) (`8912f82ae9a302997b3314b4ff81c311f806d346`, MEDIUM bloqueante):** ao elevar o teto de uma resposta do loader do vault de 100 KB para 400 KB, o `tools/github-reviewer/README.md` e a nota `automation-incidents.md` continuaram afirmando os 100 KB e a regra operacional derivada deles, de manter cada fonte citada abaixo de ~73 KB — justamente o número que sustenta a decisão de dividir ou não um arquivo citado. A descrição do PR também declarava que nenhuma documentação era afetada. A correção atualizou os dois textos e a seção do PR na mesma entrega, e fixou o teto novo com regressões que falham se ele voltar. A prevenção é, ao mudar um limite da automação, procurar o número antigo e a regra prática que saiu dele, não apenas o nome da constante.

## Decodificar streams de processo de forma contínua

- **Padrão:** `stream-decode-utf8-across-chunks`
- **Causa:** o adaptador do Claude convertia cada chunk do `stdout` com `chunk.toString('utf8')`, de forma isolada. Um caractere multibyte dividido entre dois chunks virava `U+FFFD`, sem falhar o `JSON.parse` de cada linha.
- **Impacto:** acentos e travessões do relatório estruturado podiam ser publicados corrompidos. Como o Merge Readiness e o parser de evidências procuram cabeçalhos com `—`, `ç` e `õ`, uma rodada aprovada poderia ser tratada como ausente.
- **Prevenção:** decodificar com um `StringDecoder` mantido por todo o stream e descarregá-lo no fim. Limites declarados em bytes devem ser medidos com `Buffer.byteLength`, não com `string.length`.
- **Detecção:** a regressão divide o evento `result` em todos os pontos internos de cada caractere multibyte e entrega o stream byte a byte, conferindo o texto final. Outra regressão garante que o limite do stream conta bytes UTF-8.
- **Evidência:** PR #60, revisão [`5799386919`](https://github.com/TitoStauffer/CashIn/pull/60#pullrequestreview-5799386919), SHA `75ba56541093680b4d5a7820f810334b631e0703`.

## Hooks locais executam apenas cópias instaladas

- **Padrão:** `local-hook-runs-installed-copy`
- **Causa:** o hook `SessionStart` versionado em `.claude/settings.json` executava `ensure-runner.ps1` a partir de `$CLAUDE_PROJECT_DIR`, ou seja, da árvore de trabalho da branch aberta, com `-ExecutionPolicy Bypass`.
- **Impacto:** abrir uma sessão do Claude Code numa branch não confiável executaria o script dessa branch na máquina que guarda as credenciais dos agentes, sem qualquer revisão. Uma mudança discreta num `.ps1` do PR bastaria.
- **Prevenção:** hooks e atalhos executam apenas a cópia que o instalador grava em `%LOCALAPPDATA%\CashInGithubRunner\scripts`. O instalador é rodado explicitamente, a partir de um checkout atualizado da `master`. Sem cópia instalada, o hook só orienta; sem `powershell`, termina em silêncio.
- **Detecção:** `tools/github-runner/test-runner-scripts.ps1` recusa um hook que referencie `$CLAUDE_PROJECT_DIR`. Ele também executa o comando real do hook com um `powershell` falso e confirma que só o caminho instalado é chamado.
- **Evidência:** PR #59, revisões [`5794488063`](https://github.com/TitoStauffer/CashIn/pull/59#pullrequestreview-5794488063) (SHA `b630254cb23ff73aa05d0479ce09bd8b3a86e911`) e [`5794654024`](https://github.com/TitoStauffer/CashIn/pull/59#pullrequestreview-5794654024) (SHA `1240b5b2650d700eb196805fe972eb8c62fdac75`). Corrigido na DEV-77.

## Critério de aceitação só vale o que o QA pode auditar

- **Padrão:** `acceptance-criterion-must-be-auditable`.
- **Evidência:** [relatório de QA do PR #81](https://github.com/TitoStauffer/CashIn/pull/81#issuecomment-6719965814), SHA `28a164c913b764db7d01442e2c2fb96e8e9b1a44`, decisão `INCONCLUSIVE` com 3 critérios `PASSED`, 1 `INCONCLUSIVE` e 0 `FAILED`.
- **Problema confirmado:** a verificação por mutação vinha sendo declarada como critério de aceitação nos PRs da frente de débitos. O QA não executa comandos, não há ferramenta de mutação configurada no repositório e a mutação não deixa rastro no CI do SHA avaliado — então o critério é, por construção, não avaliável. A regra do `AGENTS.md` manda produzir `INCONCLUSIVE` para critério não avaliado, e foi o que aconteceu: uma entrega sem defeito nenhum fechou a rodada bloqueada.
- **Causa-raiz:** confundir **padrão de evidência de desenvolvimento** com **critério de aceitação**. A mutação é excelente como o primeiro e imprestável como o segundo, porque o segundo precisa ser verificável por quem não é o autor.
- **Impacto:** cada PR da frente tendia a fechar `INCONCLUSIVE` por um motivo que não é defeito, consumindo uma rodada de agentes e uma rodada de correção. Pior, acostuma a tratar `INCONCLUSIVE` como ruído, que é justamente o oposto do que o estado existe para fazer.
- **Correção aplicada:** o critério foi reclassificado formalmente no ticket pelo papel de Product Manager; a mutação passou a ser declarada na seção de testes executados, como evidência de desenvolvimento, e os critérios de aceitação ficaram só com comportamento verificável pelo diff e pelas execuções de CI. A automação do passo de mutação no CI ficou na [DEV-112](https://titostauffer.atlassian.net/browse/DEV-112).
- **Regra preventiva:** antes de escrever um critério de aceitação, pergunte com que evidência **o QA** o fecharia: diff, metadados de check, snapshot de configuração ou contrato versionado. Se a resposta for "confiando no que o autor diz ter rodado", não é critério de aceitação — é evidência de desenvolvimento, e o lugar dela é a seção de testes executados. Vale para mutação, medição de desempenho local, inspeção manual de tela e qualquer verificação que não deixe rastro no SHA avaliado.
- **Detecção:** ler a própria lista de critérios de aceitação pela perspectiva do QA, item por item, antes de abrir o PR. O sinal é o critério cuja comprovação exigiria rodar algo.
