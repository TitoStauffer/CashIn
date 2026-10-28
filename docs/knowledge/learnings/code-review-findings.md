# Aprendizados de Code Review

**Status:** auditado até o PR #46
**Última revisão:** 26/10/2026

Esta nota converte os achados históricos do Agent de Code Review em regras preventivas. O inventário e os links das revisões estão em [`code-review-audit.md`](code-review-audit.md).

## 1. Validar contratos atravessando as camadas

- **Evidências:** [PR #18](https://github.com/TitoStauffer/CashIn/pull/18#pullrequestreview-5591622458), [PR #39 — primeira rodada](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5633704229) e [limite de upload](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634639324).
- **Problema recorrente:** Web, API e banco aceitavam contratos individualmente plausíveis, mas incompatíveis em conjunto: rota divergente, nulabilidade incorreta, resposta sem itens, contadores diferentes e erro genérico antes do handler.
- **Causa-raiz:** testes isolados reproduziam mocks locais e não exercitavam o contrato real entre consumidor e provedor.
- **Impacto:** 404, prévia vazia, confirmação incorreta, falhas no cliente e mensagens que escondem a causa.
- **Regra preventiva:** toda alteração de contrato precisa de uma única definição coerente de rota, formato, nulabilidade, estado e erro em todas as camadas.
- **Detecção:** teste de integração da rota real e, para fluxos críticos, teste Web/API com respostas reais ou fixtures derivadas do contrato da API.

## 2. Dados inválidos também precisam ser persistíveis

- **Evidências:** rodadas do [PR #39 sobre representação inválida](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5633704229), [shape de categoria](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634418250), [referências incompatíveis](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634520107) e [compatibilidade PostgreSQL](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5644937242).
- **Problema recorrente:** itens reconhecidos como inválidos ainda carregavam datas, valores, texto ou referências capazes de violar constraints e derrubar toda a transação.
- **Causa-raiz:** a validação de negócio mudava o status, mas não normalizava o registro para uma representação aceita pelo armazenamento.
- **Impacto:** uma única linha defeituosa descartava a prévia inteira, inclusive registros válidos.
- **Regra preventiva:** quando o produto promete preservar entradas inválidas para revisão, deve existir uma representação persistível e segura para cada campo inválido.
- **Detecção:** testes com PostgreSQL real combinando uma linha válida e uma inválida para cada constraint, incluindo limites e caracteres não armazenáveis.

## 3. Estados bloqueantes devem ser monotônicos

- **Evidências:** [duplicidade promovida por PATCH](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5633860892), [duplicidade degradada para reparável](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5644763711) e [invalidação do parser perdida](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5644848346).
- **Problema recorrente:** uma correção parcial substituía o estado inteiro e apagava outro motivo independente que ainda bloqueava o item.
- **Causa-raiz:** o modelo guardava um estado ou texto agregado, sem preservar causas independentes e sua reparabilidade.
- **Impacto:** duplicidades e linhas não reparáveis podiam virar movimentações válidas.
- **Regra preventiva:** motivos bloqueantes acumulam; uma transição só libera o recurso quando todos os motivos ativos foram resolvidos. Duplicidade confirmada nunca é reparável por edição comum.
- **Detecção:** testes de máquina de estados com múltiplos motivos simultâneos e tentativas de promoção por API, sem depender da interface.

## 4. Concorrência exige uma ordem única e uma publicação linearizável

- **Evidências:** [PR #29](https://github.com/TitoStauffer/CashIn/pull/29#pullrequestreview-5605663297), [PR #30](https://github.com/TitoStauffer/CashIn/pull/30#pullrequestreview-5605934772), [locks de desfazer do PR #39](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5633704229), [edição contra confirmação](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5633860892) e [PR #43](https://github.com/TitoStauffer/CashIn/pull/43#pullrequestreview-5645356157).
- **Problema recorrente:** execuções concorrentes usavam chaves ou ordens de lock diferentes; cancelamento de runner era tratado como se cancelasse uma escrita remota; atualizações integrais usavam uma leitura antiga.
- **Causa-raiz:** cada caminho foi analisado isoladamente, sem definir o ponto de linearização compartilhado.
- **Impacto:** status antigo por último, deadlock, perda de edição, exclusão de registro atualizado, lease preso e sobrescrita da descrição do PR.
- **Regra preventiva:** defina ordem global de locks, chave de concorrência estável, revalidação imediatamente antes da escrita e reconciliação depois de resultado incerto.
- **Detecção:** testes com duas operações controladas por barreiras, invertendo a ordem de conclusão; testes de subprocesso para timeout e liberação de lease.

## 5. Estado assíncrono da interface pertence à requisição que o produziu

- **Evidências:** [PR #25](https://github.com/TitoStauffer/CashIn/pull/25#pullrequestreview-5609054300), [PR #36](https://github.com/TitoStauffer/CashIn/pull/36#pullrequestreview-5630867714), [PR #38](https://github.com/TitoStauffer/CashIn/pull/38#pullrequestreview-5631278149) e rodadas do PR #39 sobre [troca de carteira](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634010920), [edição durante PATCH](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634183629) e [troca com falha](https://github.com/TitoStauffer/CashIn/pull/39#pullrequestreview-5634297808).
- **Problema recorrente:** respostas atrasadas, mensagens antigas e rascunhos locais eram aplicados ao contexto atual sem provar que ainda pertenciam à carteira, período ou versão exibida.
- **Causa-raiz:** flags globais de loading/sucesso substituíam identidade e versão da operação.
- **Impacto:** dados financeiros antigos sob outra carteira, feedback contraditório e perda silenciosa de alterações.
- **Regra preventiva:** associe cada requisição ao contexto e à versão do rascunho; descarte resposta obsoleta e bloqueie ou mescle edições concorrentes explicitamente.
- **Detecção:** testes com promises controladas cobrindo troca A → B → A, falha seguida de recuperação e edição durante resposta pendente.

## 6. Migrações devem preservar personalizações e semântica

- **Evidência:** [PR #24](https://github.com/TitoStauffer/CashIn/pull/24#pullrequestreview-5609195904).
- **Problema recorrente:** `ON CONFLICT DO NOTHING` evitava erro técnico, mas aceitava um registro preexistente com semântica incompatível.
- **Causa-raiz:** idempotência foi tratada como ausência de exceção, sem validar o pós-estado do domínio.
- **Impacto:** despesas de benefício poderiam reduzir o saldo em dinheiro.
- **Regra preventiva:** migrations reconciliam colisões sem destruir personalizações e comprovam as invariantes no estado final.
- **Detecção:** testes de migration com conflito de nome, registro inativo, natureza divergente e reaplicação.

## 7. Projeções de entrada não confiável devem ser estruturais

- **Evidências:** [PR #33](https://github.com/TitoStauffer/CashIn/pull/33#pullrequestreview-5608351923), [PR #35](https://github.com/TitoStauffer/CashIn/pull/35#pullrequestreview-5609434005) e [PR #45](https://github.com/TitoStauffer/CashIn/pull/45#pullrequestreview-5657791056).
- **Problema recorrente:** retirar o diff do detector abriu um caminho para prompt injection; interpretar YAML por posição de linha deixou valores de `env` em formato flow escaparem à redação.
- **Causa-raiz:** redução de falso positivo e sanitização foram implementadas removendo cobertura ou usando heurística textual incompleta.
- **Impacto:** instruções não confiáveis alcançam o modelo e valores de ambiente podem ser expostos no contexto.
- **Regra preventiva:** analisar todas as fontes não confiáveis e usar parser estrutural ou rejeitar formato não suportado; segurança falha fechada.
- **Detecção:** corpus adversarial com payload apenas no diff/snapshot e variantes sintáticas válidas da configuração.
- **Ocorrência no PR #45 (`29385064394defd2b18ca1377b793ddd7502be3e`):** comentários do GitHub eram buscados pelo identificador, mas o retorno não era confrontado com o PR indicado no link. O impacto era aceitar evidência pertencente a outro PR. A correção preserva número do PR, tipo e identificador da referência e valida `id`, URL canônica e `pull_request_url` ou `issue_url`. A prevenção é manter testes negativos para comentários inline, conversas e referências contraditórias.

## 8. Workflows precisam ser testados como grafo de eventos

- **Evidências:** três rodadas do PR #43: [cancelamento e corrida](https://github.com/TitoStauffer/CashIn/pull/43#pullrequestreview-5645356157), [recuperação do título](https://github.com/TitoStauffer/CashIn/pull/43#pullrequestreview-5645393420) e [ator App/CI ainda ativo](https://github.com/TitoStauffer/CashIn/pull/43#pullrequestreview-5645458028).
- **Problema recorrente:** condições corretas dentro de um job produziam comportamento incorreto quando um evento acionava outro workflow ou participava do grupo de concorrência antes do `if`.
- **Causa-raiz:** testes verificavam trechos YAML e não a sequência completa de eventos.
- **Impacto:** Agents cancelados pelo próprio App, CI irrecuperável após corrigir título e PRs legítimos do App sem orquestração.
- **Regra preventiva:** documentar produtores e consumidores de cada evento, identidade do ator, contexto do check e regra de concorrência antes de alterar triggers.
- **Detecção:** teste contratual da sequência abertura/edição/publicação/conclusão e ensaio controlado em PR de baixo risco.

## 9. Evidência e documentação acompanham o HEAD

- **Evidências:** [PR #11](https://github.com/TitoStauffer/CashIn/pull/11#pullrequestreview-5586988527), rodadas do [PR #16](https://github.com/TitoStauffer/CashIn/pull/16#pullrequestreview-5590951918), [PR #24](https://github.com/TitoStauffer/CashIn/pull/24#pullrequestreview-5609320295) e [PR #45](https://github.com/TitoStauffer/CashIn/pull/45#pullrequestreview-5657791056).
- **Problema recorrente:** descrição do PR, contagem de testes, cobertura e README permaneceram com números ou comportamento anteriores.
- **Causa-raiz:** documentação era atualizada na abertura, sem reconciliação após novos commits.
- **Impacto:** reviewer e QA recebem evidência contraditória e consumidores leem contrato antigo.
- **Regra preventiva:** antes de mover para review e antes do merge, o Product Manager reconcilia descrição, checklists, comandos e documentação com o HEAD.
- **Detecção:** checklist factual do PR e revisão de documentação no diff; evitar números voláteis quando um link para o check é suficiente.
- **Ocorrência no PR #45 (`29385064394defd2b18ca1377b793ddd7502be3e`):** o índice e o estado atual eram carregados, porém suas referências só eram inspecionadas quando os próprios documentos também estavam entre os arquivos alterados ou roteados. Em PRs somente de código, uma fonte obrigatória podia ficar ausente sem falha. A correção sempre inclui índice e estado atual na inspeção, com deduplicação e falha fechada. A prevenção é testar explicitamente um PR de código sem alteração no vault.
- **Ocorrência no PR #45 (`7f2aaaa471eadacecc97fbb2f6fecc3a4e964278`):** notas selecionadas eram carregadas, mas as fontes citadas dentro delas não eram percorridas. O impacto era apresentar conhecimento sem comprovar suas evidências nem incluí-las no fingerprint. A correção percorre as notas selecionadas pelo mapa ou pela mudança como um grafo limitado e deduplicado; índices e catálogos permanecem navegação explícita para evitar carregar todo o histórico em cada PR. A prevenção exige regressão para nota selecionada → fonte local ou revisão, incluindo fonte ausente e evidência alterada. [Revisão](https://github.com/TitoStauffer/CashIn/pull/45#pullrequestreview-5657926601).
- **Ocorrência no PR #45 (`36e1389312f5d1b0b9269ae0c1e1aea02b944cc6`):** o extrator reconhecia apenas links Markdown inline e ignorava a forma válida `[Fonte][id]`. O impacto era omitir fontes locais e revisões remotas do contexto e do fingerprint. A correção resolve definições por referência, incluindo formas completas, colapsadas e abreviadas, e falha fechada para definições ausentes ou conflitantes. A prevenção é executar as mesmas regressões de fonte ausente e evidência alterada nas duas sintaxes. [Revisão](https://github.com/TitoStauffer/CashIn/pull/45#pullrequestreview-5658015311).
- **Ocorrência no PR #45 (`bb23977c81da38921f22d94afd34d947f910ef9d`):** ao remover código inline antes de interpretar Markdown, o extrator apagava o rótulo formatado em crases de um link válido e deixava de carregar seu destino. O impacto era omitir evidências locais ou remotas e ainda aprovar a validação do vault. A correção substitui somente o conteúdo do rótulo por um marcador neutro, preservando o destino, e mantém exemplos inteiramente dentro de código ignorados. A prevenção cobre fonte existente, fonte ausente e revisão remota com rótulos em crases. [Revisão](https://github.com/TitoStauffer/CashIn/pull/45#pullrequestreview-5658108678).
- **Ocorrência no PR #45 (`201866759cf63ef5c5a6d12f44ee2ce8dc9dcac6`):** a expressão usada para links inline incluía títulos opcionais no destino e não interpretava corretamente destinos delimitados por sinais de menor e maior. O impacto era produzir 404 para fontes válidas e bloquear toda a orquestração. A correção usa um parser delimitado para rótulo, destino, parênteses balanceados e título, com rejeição explícita de sintaxe não suportada. A prevenção cobre fontes locais, evidência remota, espaços, escapes, parênteses, títulos, imagens e links malformados. [Revisão](https://github.com/TitoStauffer/CashIn/pull/45#pullrequestreview-5658177396).
- **Ocorrência no PR #44 (`b24d1ab22cac5ea9e09d41503ee2c06e3039ee3e`):** o validador executado no CI interpretava menos formas de link Markdown que o carregador de contexto dos Agents. O impacto era aceitar fontes ausentes por referência ou rejeitar destinos válidos com títulos, sinais angulares e parênteses balanceados, produzindo uma validação enganosa. A correção alinha os formatos aceitos e a falha fechada do script PowerShell ao resolver e executa regressões do próprio validador no CI. A prevenção é manter casos equivalentes nos dois consumidores sempre que a sintaxe de fontes mudar. [Revisão](https://github.com/TitoStauffer/CashIn/pull/44#pullrequestreview-5659102433).
- **Ocorrência no PR #44 (`b24d1ab22cac5ea9e09d41503ee2c06e3039ee3e`):** a nota de importações apresentava a impressão digital como proteção contra reprocessamento, embora a implementação apenas calcule o hash e permita sessões distintas para o mesmo arquivo. O impacto era orientar agentes a confiar numa garantia inexistente contra duplicação financeira. A correção distingue identificação do conteúdo, idempotência da confirmação por sessão e deduplicação entre sessões ainda pendente. A prevenção é confrontar afirmações de segurança e idempotência com service, repository e constraints antes de marcá-las como confirmadas. [Revisão](https://github.com/TitoStauffer/CashIn/pull/44#pullrequestreview-5659102433).
- **Ocorrência no PR #44 (`b24d1ab22cac5ea9e09d41503ee2c06e3039ee3e`):** o mapa de contexto usava `docker-compose.yml`, mas o repositório usa `compose.yaml`. O impacto era não selecionar a nota de banco em mudanças exclusivas do Compose. A correção referencia o caminho real. A prevenção é validar rotas do mapa contra os arquivos versionados e cobrir renomes na revisão do vault. [Revisão](https://github.com/TitoStauffer/CashIn/pull/44#pullrequestreview-5659102433).
- **Ocorrência no PR #44 (`b24d1ab22cac5ea9e09d41503ee2c06e3039ee3e`):** a arquitetura nomeava a fábrica da API como `buildApp`, embora o identificador implementado seja `createApp`. O impacto era dificultar a localização direta e induzir futuras mudanças a usar um contrato inexistente. A correção usa o nome verificável no código. A prevenção é conferir identificadores documentados por busca exata no HEAD. [Revisão](https://github.com/TitoStauffer/CashIn/pull/44#pullrequestreview-5659102433).

## 10. Testes devem reproduzir o risco, não apenas a configuração

- **Evidências:** os achados anteriores, a observação de cobertura no [PR #33](https://github.com/TitoStauffer/CashIn/pull/33#pullrequestreview-5608397261) e a [segunda rodada do PR #45](https://github.com/TitoStauffer/CashIn/pull/45#pullrequestreview-5657926601).
- **Problema recorrente:** testes por regex, mocks felizes ou transformações puras passavam enquanto o contrato real, a transação ou o interleaving falhava.
- **Causa-raiz:** o teste comprovava implementação esperada, mas não a propriedade de segurança ou recuperação declarada.
- **Impacto:** ciclos sucessivos de correção para uma mesma feature.
- **Regra preventiva:** cada regressão deve falhar na versão defeituosa e atravessar a fronteira onde ocorreu o problema.
- **Detecção:** tabela de riscos no planejamento do teste: contrato, persistência, concorrência, contexto assíncrono, limite e falha parcial.
- **Ocorrência no PR #45 (`7f2aaaa471eadacecc97fbb2f6fecc3a4e964278`):** a pré-validação do limite somava referências locais já presentes nos snapshots e podia rejeitar um contexto com menos de 160 itens únicos. A correção calcula a união das identidades e reutiliza snapshots locais. A prevenção é testar o valor de fronteira com os mesmos documentos simultaneamente roteados e vinculados.
- **Ocorrência no PR #46 (`25427340afb0d8a0f356c2ebcb081a6f96c3742c`):** a deduplicação retirava da contagem qualquer arquivo já carregado pelo vault, inclusive código TypeScript. O impacto era permitir que referências do vault contornassem o limite fechado de 32 fontes alteradas. A correção restringe a deduplicação ao Markdown gerenciado pelo vault e ao mapa de contexto; código continua sujeito ao limite próprio. A prevenção testa 33 fontes alteradas também referenciadas pelo vault e exige bloqueio. [Revisão](https://github.com/TitoStauffer/CashIn/pull/46#pullrequestreview-5658565787).
- **Ocorrência no PR #46 (`25427340afb0d8a0f356c2ebcb081a6f96c3742c`):** um TypeScript alterado já presente no vault deixava de passar pelo carregador que descobre imports locais diretos. O impacto era omitir dependências relevantes e tornar incorreta a garantia de contexto completo. A correção mantém fontes de código no carregador genérico mesmo quando também são evidência do vault. A prevenção testa uma fonte citada pelo vault que importa uma dependência local inalterada e exige os dois snapshots. [Revisão](https://github.com/TitoStauffer/CashIn/pull/46#pullrequestreview-5658565787).

## 11. Parsers devem definir o escopo antes de extrair campos

- **Evidência:** [PR #48](https://github.com/TitoStauffer/CashIn/pull/48#pullrequestreview-5659944146).
- **Problema confirmado:** conta e moeda eram lidas da primeira ocorrência global, enquanto as movimentações de todos os blocos `STMTRS` eram agregadas. Campos de texto também eram encerrados na primeira quebra de linha.
- **Causa-raiz:** o parser buscava tags no documento completo sem primeiro delimitar o contêiner semântico e usava uma expressão escalar que confundia quebra de linha com fim de campo.
- **Impacto:** transações podiam ser atribuídas à conta e moeda erradas, `FITID` de contas diferentes podia colidir e descrições perdiam conteúdo silenciosamente.
- **Regra preventiva:** antes de ler campos repetíveis, delimite a unidade semântica suportada; rejeite cardinalidade não suportada antes de produzir saída. Valores escalares terminam na tag de fechamento XML ou na próxima tag SGML, nunca em uma quebra de linha.
- **Detecção:** teste adversarial com dois extratos, moedas diferentes e `FITID` coincidente; teste XML e SGML com `NAME` e `MEMO` multilinha, incluindo a descrição persistida na prévia.
- **Ocorrência no PR #48 (`35e2676298c92a821ee80959e285aaa01ff75e98`):** a correção inicial passou a aceitar quebras de linha, mas procurava a próxima tag antes de consumir uma seção `CDATA`. Marcação e entidades literais dentro do bloco podiam ser cortadas ou decodificadas como XML comum. A correção percorre o conteúdo escalar, decodifica entidades somente fora de `CDATA` e preserva literalmente cada seção. A prevenção cobre conteúdo misto, marcação e entidades dentro de `CDATA`, inclusive após persistência na prévia. [Revisão](https://github.com/TitoStauffer/CashIn/pull/48#pullrequestreview-5681580406).
