# Contrato de importação financeira

A API mantém sessões de importação por carteira para que o cliente possa enviar um arquivo, revisar a prévia e confirmar os lançamentos em uma única transação. Extratos bancários OFX 1.x e 2.x e arquivos CSV configuráveis são interpretados diretamente; faturas de cartão permanecem uma entrega separada.

## Limites e segurança

- O upload usa `application/octet-stream` e não persiste o arquivo bruto.
- O arquivo pode ter até 10 MB e a prévia pode conter até 10.000 movimentações.
- `x-file-name` contém o nome codificado com `encodeURIComponent` e `x-file-format` aceita `ofx` ou `csv`.
- Todas as operações exigem sessão autenticada e respeitam a carteira selecionada por `x-wallet-id`.
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
- Faturas de cartão em OFX não fazem parte deste fluxo e são recusadas com mensagem específica.

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
| `PATCH` | `/financial-imports/:importId/items/:itemId` | Atualiza data, descrição, tipo, categoria e subcategoria durante a prévia. |
| `POST` | `/financial-imports/:importId/confirm` | Cria todas as movimentações válidas atomicamente. |
| `POST` | `/financial-imports/:importId/undo` | Remove os lançamentos gerados se nenhum deles tiver sido alterado. |
| `DELETE` | `/financial-imports/:importId` | Descarta uma prévia ainda não confirmada e libera suas referências de classificação. |
| `GET` | `/financial-imports/rules` | Lista as regras de categorização da carteira no envelope `{ "items": [...] }`. |
| `POST` | `/financial-imports/rules` | Cria uma regra a partir de uma ação explícita do usuário. |
| `PATCH` | `/financial-imports/rules/:ruleId` | Substitui tipo, descrição, categoria, subcategoria e estado (`isActive`) da regra. |
| `DELETE` | `/financial-imports/rules/:ruleId` | Exclui a regra da carteira. |

As sessões usam os estados `processing`, `preview`, `confirming`, `completed`, `failed` e `undone`. O resumo separa itens `valid`, `duplicate`, `invalid`, `uncategorized` e `imported`. `canUndo` e `undoBlockedReason` permitem que o cliente apresente a elegibilidade do desfazer sem presumir o estado. Falhas persistidas expõem somente uma mensagem segura em `failureMessage`.

Linhas inválidas permanecem na prévia com motivo explícito. `canEdit` identifica as linhas que podem ser corrigidas pelo usuário; valor inválido, sequência de origem inválida, duplicidade confirmada ou sequência repetida não podem ser reparados manualmente. `canIncludeDuplicate` permite importar explicitamente somente possíveis duplicidades. A posição persistida é sempre única e os campos inválidos são armazenados de forma nula internamente, evitando que uma linha defeituosa descarte as demais.

## Regras de categorização

Uma regra associa um tipo (`income` ou `expense`) e uma descrição a uma categoria e, opcionalmente, a uma subcategoria da mesma carteira e natureza. A descrição é comparada de forma exata após normalização (NFKC, minúsculas e espaços colapsados), a mesma usada na detecção de duplicidades. Há no máximo uma regra por carteira, tipo e descrição normalizada; tentativas repetidas devolvem `409`. Transferências não recebem regras.

As regras nunca são aprendidas silenciosamente: só existem quando o usuário as cria pela gestão de regras ou confirma a criação a partir de um item salvo na prévia com categoria escolhida manualmente. Elas pertencem à carteira e são compartilhadas por todos os seus membros; regras de uma carteira não afetam outra.

Ao gerar uma nova prévia, regras ativas classificam somente itens sem categoria que não sejam inválidos nem duplicados. O item passa a `valid` com `categorizationSource: "rule"`, e o cliente informa que a categoria foi sugerida. Uma escolha do usuário prevalece: salvar o item com outra categoria, tipo ou descrição muda a origem para `manual`, e remover a categoria a limpa (`null`).

Categorias e subcategorias removidas não quebram as regras. A regra continua listada com `isStale: true` e nomes nulos, deixa de classificar movimentações e volta a funcionar quando o usuário a reclassifica. Regras desativadas (`isActive: false`) permanecem listadas, mas também não são aplicadas.

## Confirmação e desfazer

A confirmação importa somente itens válidos e ocorre em uma única transação PostgreSQL. A carteira é bloqueada durante a revalidação de duplicidades para impedir que confirmações concorrentes criem o mesmo lançamento; possíveis duplicidades encontradas no histórico ou entre itens editados da própria sessão devolvem a sessão à prévia e não importam nenhum item nessa tentativa. O consentimento para incluir uma coincidência é persistido com a impressão exata revisada, respeitado na confirmação e invalidado quando data, valor, tipo ou descrição mudam. Um FITID repetido na mesma conta continua bloqueado mesmo após consentimento da impressão. Qualquer outra falha reverte todos os lançamentos e mantém a sessão em `preview`, permitindo nova tentativa. Itens inválidos, duplicidades não aceitas ou sem categoria não geram lançamentos. O desfazer também é transacional e compara o `updated_at` de cada entrada ou saída com o valor capturado na confirmação. Se qualquer lançamento tiver sido alterado ou removido, a operação é recusada com `409`.

O descarte é permitido somente em `preview`, não cria movimentações e remove as referências a categoria e subcategoria dos itens para que cadastros não fiquem bloqueados por uma prévia abandonada. A sessão permanece no histórico como `failed`, com a mensagem explícita de que foi descartada pelo usuário.
