# Contrato de importação financeira

A API mantém sessões de importação por carteira para que o cliente possa enviar um arquivo, revisar a prévia e confirmar os lançamentos em uma única transação. Extratos bancários OFX 1.x e 2.x, faturas de cartão em OFX e arquivos CSV configuráveis são interpretados diretamente. A importação de fatura é descrita em [Faturas de cartão](#faturas-de-cartão).

## Limites e segurança

- O upload usa `application/octet-stream` e não persiste o arquivo bruto.
- O arquivo pode ter até 10 MB e a prévia pode conter até 10.000 movimentações.
- `x-file-name` contém o nome codificado com `encodeURIComponent` e `x-file-format` aceita `ofx` ou `csv`.
- Todas as operações exigem sessão autenticada e respeitam a carteira selecionada por `x-wallet-id`.
- Nas rotas que recebem conteúdo — `POST /financial-imports` e `POST /financial-imports/csv/inspect` — a autenticação e a resolução da carteira acontecem antes da leitura do corpo. Sem sessão a resposta é `401` e sem acesso à carteira é `404`, mesmo quando o arquivo enviado excede o limite; o `413` do limite só vale para uma requisição autorizada.
- Quem não é membro da carteira não cria sessão de importação alguma.
- Os logs da API registram de cada requisição apenas método, rota e endereço de origem, e de cada resposta apenas o código. Cabeçalhos e corpo nunca são registrados.
- Valores monetários permanecem como strings decimais com duas casas no contrato e como `numeric(14,2)` no PostgreSQL.

## Extratos OFX

- São aceitas as variantes bancárias OFX 1.x (SGML) e OFX 2.x (XML), em UTF-8, UTF-16, Windows-1252 ou ISO-8859-1.
- A conta de origem e a moeda são validadas; nesta etapa, somente `BRL` e um único extrato bancário por arquivo são aceitos. Arquivos com múltiplos blocos `STMTRS` são recusados antes da prévia para impedir a mistura de contas, moedas e identificadores.
- Valores positivos geram sugestão de entrada, valores negativos geram sugestão de saída e `TRNTYPE=XFER` gera transferência pendente de conciliação.
- `FITID` é preservado em `external_id`; uma impressão normalizada por data, valor assinado, tipo e descrição é armazenada em `record_hash` e comparada entre OFX, CSV e importações anteriores da mesma carteira.
- FITID já importado da mesma conta OFX é duplicidade confirmada e fica bloqueado. Coincidências pela impressão normalizada são possíveis duplicidades, com justificativa na prévia; o usuário pode revisá-las e escolher explicitamente “Importar mesmo assim”.
- O identificador bruto da conta não é exposto nem persistido como metadado. A sessão armazena somente sua impressão SHA-256, banco, tipo de conta e moeda.
- Registros malformados permanecem na prévia com motivo explícito quando isso é seguro. Data inválida pode ser corrigida; valor ou `FITID` inválido bloqueiam a linha.
- Descrições em `NAME` e `MEMO` preservam o conteúdo multilinha e o texto literal de seções XML `CDATA`; tags aparentes dentro de `CDATA` e comentários não alteram a estrutura do extrato, e sequências de espaço são normalizadas somente na descrição exibida.
- Uma fatura de cartão em OFX enviada como extrato bancário é recusada com mensagem que orienta a escolher a importação de fatura; o inverso também é recusado.

## Arquivos CSV

- A inspeção detecta delimitador (vírgula ou ponto e vírgula), presença de cabeçalho, codificação, formato de data e formato monetário, e devolve até dez linhas de amostra. Para recalcular colunas e amostra após uma correção manual, o cliente pode reenviar `x-csv-mapping` com a configuração codificada; a inspeção valida e usa somente os cinco campos de formato, sem exigir que o mapeamento de colunas sugerido inicialmente já esteja completo.
- São aceitos `utf-8`, `windows-1252` e `iso-8859-1`; datas podem usar `dd/MM/yyyy`, `MM/dd/yyyy` ou `yyyy-MM-dd`; valores podem usar a convenção `pt-BR` ou `en-US`.
- O mapeamento usa índices de coluna iniciados em zero. `date` é obrigatório; `description` e `externalId` são opcionais. Deve existir exatamente um formato financeiro: `amount` preenchido com `credit` e `debit` nulos, ou `amount` nulo com `credit` e `debit` preenchidos.
- O valor é normalizado como texto decimal, sem conversão por ponto flutuante. Valor positivo sugere entrada e negativo sugere saída; no modo separado, a coluna crédito gera entrada e a coluna débito gera saída.
- Linhas inválidas permanecem na prévia e indicam o número físico da linha e o motivo, enquanto a sequência persistida é ordinal e limitada à quantidade real de movimentações. Erros estruturais que impedem uma leitura segura do arquivo, incluindo caractere nulo, aspas inesperadas ou conteúdo depois do fechamento de um campo entre aspas, recusam a importação inteira sem alterar silenciosamente o conteúdo. Depois do fechamento de aspas, somente espaços, separador ou fim do registro são aceitos; `""` continua sendo o escape válido dentro do campo.
- Modelos reutilizáveis são escopados à carteira. O upload recebe uma configuração ad hoc em `x-csv-mapping` (JSON codificado com `encodeURIComponent`) ou o UUID de um modelo em `x-csv-mapping-id`, nunca ambos.

## Endpoints

| Método | Caminho | Resultado |
|---|---|---|
| `POST` | `/financial-imports` | Cria a sessão, processa o arquivo em memória e devolve a prévia. |
| `POST` | `/financial-imports/csv/inspect` | Inspeciona o CSV em memória e devolve configuração detectada, colunas, sugestão de mapeamento e amostra. |
| `GET` | `/financial-imports/csv-mappings` | Lista os modelos CSV da carteira no envelope `{ "items": [...] }`. |
| `POST` | `/financial-imports/csv-mappings` | Cria um modelo CSV na carteira. |
| `PATCH` | `/financial-imports/csv-mappings/:mappingId` | Atualiza nome e configuração de um modelo da carteira. |
| `GET` | `/financial-imports` | Lista o histórico da carteira no envelope `{ "items": [...] }`. |
| `GET` | `/financial-imports/:importId` | Devolve a sessão e seus itens. |
| `PATCH` | `/financial-imports/:importId/items/:itemId` | Atualiza data, descrição, tipo, categoria, subcategoria e, em faturas, a fatura de destino durante a prévia. |
| `POST` | `/financial-imports/:importId/confirm` | Cria todas as movimentações válidas atomicamente. |
| `POST` | `/financial-imports/:importId/undo` | Remove os lançamentos gerados se nenhum deles tiver sido alterado. |
| `DELETE` | `/financial-imports/:importId` | Descarta uma prévia ainda não confirmada e libera suas referências de classificação. |
| `GET` | `/financial-imports/rules` | Lista as regras de categorização da carteira no envelope `{ "items": [...] }`. |
| `POST` | `/financial-imports/rules` | Cria uma regra a partir de uma ação explícita do usuário. |
| `PATCH` | `/financial-imports/rules/:ruleId` | Substitui tipo, descrição, categoria, subcategoria e estado (`isActive`) da regra. |
| `DELETE` | `/financial-imports/rules/:ruleId` | Exclui a regra da carteira. |

Cada sessão traz `importedBy` com `userId`, `isCurrentUser` e `email`. O `email` só é preenchido para as importações do próprio leitor e, para o proprietário da carteira, para as de qualquer membro; nos demais casos vem `null` e o cliente identifica a importação como de outro membro. As sessões usam os estados `processing`, `preview`, `confirming`, `completed`, `failed` e `undone`. O resumo separa itens `valid`, `duplicate`, `invalid`, `uncategorized` e `imported`. `canUndo` e `undoBlockedReason` permitem que o cliente apresente a elegibilidade do desfazer sem presumir o estado. Falhas persistidas expõem somente uma mensagem segura em `failureMessage`. Uma importação interrompida antes da prévia permanece em `processing` por no máximo 15 minutos: depois disso o histórico, a leitura do detalhe e o próximo upload da carteira a encerram como `failed`, com o motivo em `failureMessage` e o instante em `failedAt`. No detalhe o encerramento só é tentado quando a própria sessão lida já está fora da janela, então a consulta de uma importação saudável continua sendo leitura pura — o cliente pode fazer polling do detalhe sem provocar escrita.

Linhas inválidas permanecem na prévia com motivo explícito. `canEdit` identifica as linhas que podem ser corrigidas pelo usuário; valor inválido, sequência de origem inválida, duplicidade confirmada ou sequência repetida não podem ser reparados manualmente. `canIncludeDuplicate` permite importar explicitamente somente possíveis duplicidades. A posição persistida é sempre única e os campos inválidos são armazenados de forma nula internamente, evitando que uma linha defeituosa descarte as demais.

## Faturas de cartão

O upload de fatura envia `x-credit-card-id` com o UUID de um cartão **ativo da carteira selecionada**; cartão de outra carteira, inexistente ou inativo devolve `404`. Em CSV, `x-card-amount-sign` é obrigatório e informa como o arquivo representa as compras: `purchases_positive` ou `purchases_negative`. Em OFX ele é recusado, porque o OFX já informa compras como débitos. Sem `x-credit-card-id`, `x-card-amount-sign` é recusado.

- **OFX:** o arquivo deve conter exatamente um bloco `CCSTMTRS` com `CCACCTFROM`, em `BRL`. O FITID é comparado entre importações do mesmo cartão.
- **Sinais:** todos os formatos são normalizados para compras negativas (`type: "expense"`) e créditos positivos (`type: "card_credit"`). Assim, a mesma compra tem a mesma impressão em OFX e CSV, e a duplicidade é detectada entre os dois formatos.
- **Tipos:** uma fatura aceita `expense` (compra), `card_credit` (estorno ou reembolso) e `transfer`. Uma linha positiva com `TRNTYPE=PAYMENT` ou descrição contendo "pagamento"/"pgto" é sugerida como `transfer`: é o pagamento da fatura anterior, conciliado com o extrato bancário e não importado. `income` é recusado em faturas, e `card_credit` é recusado em extratos bancários.
- **Fatura do item:** cada item recebe `statementClosingDate` e `statementDueDate` pelo fechamento do cartão (compra no dia do fechamento entra naquela fatura; no dia seguinte, na próxima; dias inexistentes usam o último dia do mês). O usuário pode mover o item para a fatura anterior ou a seguinte enviando `statementClosingDate` no `PATCH`; `null` volta ao cálculo pela data. Outra data devolve `400`.
- **Fatura paga:** item cuja fatura já foi paga fica `invalid` e reparável, com a data de fechamento no motivo. A confirmação revalida isso e devolve a sessão à prévia se uma fatura tiver sido paga depois.
- **Prévia:** a sessão expõe `kind` (`bank_statement` ou `credit_card_statement`), `creditCardId`, `creditCardName`, `creditCardClosingDay`, `creditCardDueDay` e `statements`. Este último lista, por fatura, `purchasesAmount`, `creditsAmount`, `totalAmount` (compras menos créditos) e `isPaid`, calculados sobre os itens válidos ou importados.
- **Confirmação:** compras viram despesas com a forma de pagamento de natureza `credit_card` mais antiga e ativa da carteira (sem ela, `409`) e entram na fatura do item. A forma de pagamento só é exigida quando a sessão tem compras: uma importação de fatura que carrega apenas estornos é confirmada sem ela. Se o cartão da fatura tiver sido inativado entre o upload e a confirmação, a resposta é `409`. Elas só saem do saldo quando a fatura é paga. Créditos viram abatimentos da fatura, nunca receitas. Um crédito é vinculado à compra original (`originalExpenseId`) somente quando exatamente uma compra do mesmo cartão tem a mesma descrição (ignorando prefixos como "Estorno de"), data anterior ou igual e saldo estornável suficiente; caso contrário, fica sem vínculo. Estornos parciais e totais são aceitos, sem perda de precisão.
- **Desfazer:** remove as compras e os créditos da sessão e as faturas que ficarem vazias. É recusado se algum lançamento tiver sido alterado ou se alguma fatura afetada já tiver sido paga (`undoBlockedReason` explica o motivo).
- **Duplicidade:** é procurada apenas entre importações do mesmo cartão. Extratos bancários só se comparam com extratos bancários.

As faturas em `GET /credit-cards/:creditCardId/statements` passam a expor `purchasesAmount`, `creditsAmount` e `credits`, e `totalAmount` passa a ser o saldo líquido. O pagamento integral cobra esse saldo líquido e é recusado com `409` quando os créditos cobrem as compras.

Limitações conhecidas:

- Estornos abatem a fatura e o valor pago, mas não reduzem `expenseTotal`, `creditPurchaseTotal` nem o gasto por categoria do dashboard, que continuam somando as compras pelo valor bruto (DEV-81).
- Excluir manualmente uma compra estornada mantém o crédito na fatura, sem vínculo (`originalExpenseId: null`). A fatura não é removida e pode ficar com `totalAmount` negativo (saldo credor), que não pode ser pago. Não existe transporte do saldo credor para a fatura seguinte.

## Pagamentos de fatura no extrato bancário

Um pagamento de cartão aparece no extrato como um débito comum, então a prévia de um extrato bancário sugere a conciliação por descrição, valor, data e faturas abertas da carteira.

- **Quando a sugestão acontece:** apenas para um débito cuja descrição aponte para cartão ou fatura (por exemplo "pagamento cartão", "pgto fatura"), e não para qualquer "pagamento". As candidatas são as faturas da carteira ainda não liquidadas, com saldo devedor e vencimento dentro de 15 dias da data do pagamento, no máximo cinco, ordenadas pela proximidade do vencimento.
- **Correspondência única:** o item é sugerido como `transfer` já conciliado (`creditCardStatementId`) e fica `valid` somente quando **uma única** candidata tem saldo devedor exatamente igual ao valor pago.
- **Correspondência ambígua:** o item é apresentado como `transfer` sem fatura, `uncategorized`, com as candidatas em `statementCandidates` e a instrução para escolher. Nada é confirmado automaticamente. Sem nenhuma candidata, o débito permanece a despesa que o parser sugeriu.
- **Uma fatura é sugerida a uma única linha:** uma fatura em aberto é paga uma vez, então a prévia não sugere a mesma fatura a duas linhas. Duas saídas do mesmo valor e data deixam a segunda `uncategorized` com a instrução para escolher — a fatura continua entre as candidatas dela, porque quem decide é o usuário. Se ele apontar as duas para a mesma fatura, a confirmação recusa com `409` e a mensagem nomeia a movimentação a corrigir.
- **Escolha do usuário:** o `PATCH` do item aceita `creditCardStatementId` em importações de extrato bancário. A fatura precisa ser da carteira, não liquidada e com saldo devedor; caso contrário responde `404` ou `409`. Somente `type: "transfer"` pode ser conciliado, e `null` desfaz a conciliação. Em importações de fatura de cartão o campo é recusado.
- **Confirmação:** cada pagamento conciliado cria um pagamento da fatura, e as compras não são lançadas de novo, então o total de despesas não conta a fatura duas vezes. Um `transfer` sem fatura continua bloqueando a confirmação. Se a fatura tiver sido liquidada entre a prévia e a confirmação, a resposta é `409`.
- **Desfazer:** remove os pagamentos criados e reabre a fatura que eles tinham liquidado, se ela voltar a ter saldo devedor.

### Pagamentos da fatura

O valor pago de uma fatura passa a viver em uma tabela de pagamentos, e não em uma coluna da fatura, para que um pagamento parcial também apareça no saldo. As faturas em `GET /credit-cards/:creditCardId/statements` expõem `paymentsAmount`, `outstandingAmount` (total menos pagamentos, nunca negativo) e `payments` (valor, data e origem `manual` ou `bank_statement`). `paidAmount` continua existindo e é a soma dos pagamentos, mas apenas quando a fatura está liquidada.

- `POST /credit-cards/:creditCardId/statements/:statementId/pay` aceita `amount` opcional. Sem ele, o pagamento liquida o saldo devedor, como antes; com ele, pode ser parcial.
- Um pagamento parcial reduz a fatura e **não** a liquida, então ela continua aceitando compras. A liquidação (`paidDate`) acontece quando os pagamentos cobrem o total, e é ela que bloqueia novas compras, novos pagamentos e o desfazer de importações.
- Pagar mais que o saldo devedor é aceito, porque é o fato bancário: a fatura é liquidada e a diferença fica como saldo credor, que não é transportado para a fatura seguinte.

## Transferências entre carteiras

Uma transferência entre duas carteiras não é receita nem despesa: o dinheiro sai de uma e entra na outra. A transferência é registrada uma única vez e cada lado é uma linha do extrato da carteira correspondente, que pode ser importada antes, depois ou nunca.

- **Quando a sugestão acontece:** na prévia de um **extrato bancário**. Uma linha que o arquivo marca como transferência (`TRNTYPE` `XFER` ou `TRANSFER` no OFX) é apresentada como `transfer` aguardando a carteira do outro lado. Uma saída ou entrada comum é apresentada como transferência apenas quando existe uma transferência registrada esperando exatamente aquele valor, com data até três dias de distância e o lado desta carteira ainda não conciliado — é assim que o segundo lado é reconhecido em extratos que não marcam a transferência.
- **Listas sempre presentes:** em uma prévia de extrato bancário, toda linha ainda editável (`canEdit`) traz `statementCandidates`, `transferCandidates` e `transferCounterpartWallets`, vazias quando não há opção. Lista vazia significa avaliada e sem opção, nunca "não avaliada". Linhas já importadas e linhas inválidas sem reparo não recebem essa garantia, porque não há ação a tomar sobre elas: podem vir sem as listas, e uma linha de tipo `transfer` ainda não importada continua recebendo `statementCandidates` mesmo sem `canEdit`, por outro caminho da leitura. O que `canEdit` garante é o conjunto completo e a razão.
- **`reconciliationUnavailableReason`:** dito apenas quando não há nenhuma opção, para distinguir os casos. `"not_a_transfer"`: nada foi avaliado, porque a linha não está gravada como `transfer` — é o estado de quem trocou o tipo na prévia e ainda não salvou. `"card_payment"`: só as faturas foram avaliadas, porque a descrição aponta pagamento de cartão e essa conciliação é a mais específica; nenhuma fatura em aberto correspondeu. `null`: não há opção a oferecer e nenhuma causa de conciliação a declarar — seja porque tudo que cabia foi avaliado e nada existe, seja porque a linha ficou fora da avaliação por falta de data válida ou por já ter uma fatura escolhida. Nesses dois últimos casos o impedimento verdadeiro já está no `errorMessage` da própria linha, e o campo não inventa uma causa. Havendo qualquer opção, o campo também é `null`.
- **Candidatas:** `transferCandidates` traz as transferências cujo lado nesta carteira está pendente, com a carteira do outro lado, o valor e a data; no máximo cinco, a de data mais próxima primeiro. Uma transferência só aparece para as duas carteiras que são os seus extremos.
- **Nome da carteira do outro lado:** `counterpartWalletName` vem preenchido somente enquanto o usuário continua associado àquela carteira. Se o acesso foi revogado depois que a transferência passou a existir, o nome vem `null` e o cliente identifica o outro lado de forma neutra. A candidata **permanece** e conciliar continua permitido: esta carteira é um dos extremos da transferência, o dinheiro já saiu dela, e recusar a conciliação deixaria a linha do extrato pendente para sempre. O identificador (`counterpartWalletId`) continua presente, porque é o que liga os dois lados da transferência que o próprio usuário originou.
- **Carteiras oferecidas:** `transferCounterpartWallets` traz as carteiras que a pessoa autenticada acessa, sem a própria carteira da importação. Carteira sem acesso nunca é oferecida nem aceita.
- **Correspondência única:** com exatamente uma transferência pendente compatível, o item é conciliado com ela e fica `valid`, porque os dois extremos dessa transferência já estão definidos. **Ambígua** (mais de uma) fica `uncategorized` com as candidatas expostas; nada é confirmado automaticamente.
- **Escolha do usuário:** o `PATCH` do item aceita `transferCounterpartWalletId` (a carteira do outro lado, que cria a transferência na confirmação) e `walletTransferId` (a transferência pendente que esta linha completa). A carteira precisa ser acessível e diferente da própria (`404` ou `400`); a transferência precisa ter esta carteira no extremo correspondente ao sinal da linha, com esse lado livre e o mesmo valor (`404` ou `409`). Uma transferência liquida uma fatura **ou** espelha outra carteira, nunca as duas (`400`). Em importações de fatura de cartão os dois campos são recusados.
- **Confirmação:** cada linha conciliada completa a transferência escolhida ou cria uma nova com a carteira escolhida, e nenhuma receita ou despesa é lançada. Um `transfer` sem nenhuma conciliação continua bloqueando a confirmação. Dois lados da mesma carteira não podem reivindicar a mesma transferência (`409`).
- **Desfazer:** libera o lado desta importação. A transferência permanece quando o outro lado continua conciliado, porque o dinheiro realmente mudou de lugar, e o lado liberado volta a ser oferecido como candidato; quando nenhum outro lado a sustenta, ela é removida.

## Regras de categorização

Uma regra associa um tipo (`income` ou `expense`) e uma descrição a uma categoria e, opcionalmente, a uma subcategoria da mesma carteira e natureza. A descrição é comparada de forma exata após normalização (NFKC, minúsculas e espaços colapsados), a mesma usada na detecção de duplicidades. Há no máximo uma regra por carteira, tipo e descrição normalizada; tentativas repetidas devolvem `409`. Transferências e créditos de fatura não recebem regras.

As regras nunca são aprendidas silenciosamente: só existem quando o usuário as cria pela gestão de regras ou confirma a criação a partir de um item salvo na prévia com categoria escolhida manualmente. Elas pertencem à carteira e são compartilhadas por todos os seus membros; regras de uma carteira não afetam outra.

Ao gerar uma nova prévia, regras ativas classificam somente itens sem categoria que não sejam inválidos nem duplicados. O item passa a `valid` com `categorizationSource: "rule"`, e o cliente informa que a categoria foi sugerida. Uma escolha do usuário prevalece: salvar o item com outra categoria, tipo ou descrição muda a origem para `manual`, e remover a categoria a limpa (`null`).

Categorias e subcategorias removidas não quebram as regras. A regra continua listada com `isStale: true` e nomes nulos, deixa de classificar movimentações e volta a funcionar quando o usuário a reclassifica. Regras desativadas (`isActive: false`) permanecem listadas, mas também não são aplicadas.

## Confirmação e desfazer

A confirmação importa somente itens válidos e ocorre em uma única transação PostgreSQL. A carteira é bloqueada durante a revalidação de duplicidades para impedir que confirmações concorrentes criem o mesmo lançamento; possíveis duplicidades encontradas no histórico ou entre itens editados da própria sessão devolvem a sessão à prévia e não importam nenhum item nessa tentativa. O consentimento para incluir uma coincidência é persistido com a impressão exata revisada, respeitado na confirmação e invalidado quando data, valor, tipo ou descrição mudam. Um FITID repetido na mesma conta continua bloqueado mesmo após consentimento da impressão. Qualquer outra falha reverte todos os lançamentos e mantém a sessão em `preview`, permitindo nova tentativa. Itens inválidos, duplicidades não aceitas ou sem categoria não geram lançamentos. O desfazer também é transacional e compara o `updated_at` de cada entrada ou saída com o valor capturado na confirmação. Se qualquer lançamento tiver sido alterado ou removido, a operação é recusada com `409`.

O descarte é permitido somente em `preview`, não cria movimentações e remove as referências a categoria e subcategoria dos itens para que cadastros não fiquem bloqueados por uma prévia abandonada. A sessão permanece no histórico como `failed`, com a mensagem explícita de que foi descartada pelo usuário.
