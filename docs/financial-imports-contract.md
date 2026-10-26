# Contrato de importação financeira

A API mantém sessões de importação por carteira para que o cliente possa enviar um arquivo, revisar a prévia e confirmar os lançamentos em uma única transação. Extratos bancários OFX 1.x e 2.x são interpretados diretamente; CSV e faturas de cartão permanecem entregas separadas.

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
- `FITID` é preservado em `external_id`; uma identidade normalizada também é armazenada em `record_hash` para a futura detecção de duplicidades.
- O identificador bruto da conta não é exposto nem persistido como metadado. A sessão armazena somente sua impressão SHA-256, banco, tipo de conta e moeda.
- Registros malformados permanecem na prévia com motivo explícito quando isso é seguro. Data inválida pode ser corrigida; valor ou `FITID` inválido bloqueiam a linha.
- Descrições em `NAME` e `MEMO` preservam o conteúdo multilinha e normalizam sequências de espaço somente na descrição exibida.
- Faturas de cartão em OFX não fazem parte deste fluxo e são recusadas com mensagem específica.

## Endpoints

| Método | Caminho | Resultado |
|---|---|---|
| `POST` | `/financial-imports` | Cria a sessão, processa o arquivo em memória e devolve a prévia. |
| `GET` | `/financial-imports` | Lista o histórico da carteira no envelope `{ "items": [...] }`. |
| `GET` | `/financial-imports/:importId` | Devolve a sessão e seus itens. |
| `PATCH` | `/financial-imports/:importId/items/:itemId` | Atualiza data, descrição, tipo, categoria e subcategoria durante a prévia. |
| `POST` | `/financial-imports/:importId/confirm` | Cria todas as movimentações válidas atomicamente. |
| `POST` | `/financial-imports/:importId/undo` | Remove os lançamentos gerados se nenhum deles tiver sido alterado. |
| `DELETE` | `/financial-imports/:importId` | Descarta uma prévia ainda não confirmada e libera suas referências de classificação. |

As sessões usam os estados `processing`, `preview`, `confirming`, `completed`, `failed` e `undone`. O resumo separa itens `valid`, `duplicate`, `invalid`, `uncategorized` e `imported`. `canUndo` e `undoBlockedReason` permitem que o cliente apresente a elegibilidade do desfazer sem presumir o estado. Falhas persistidas expõem somente uma mensagem segura em `failureMessage`.

Linhas inválidas permanecem na prévia com motivo explícito. `canEdit` identifica as linhas que podem ser corrigidas pelo usuário; valor inválido, sequência de origem inválida, duplicidade ou sequência repetida não podem ser reparados manualmente. A posição persistida é sempre única e os campos inválidos são armazenados de forma nula internamente, evitando que uma linha defeituosa descarte as demais.

## Confirmação e desfazer

A confirmação importa somente itens válidos e ocorre em uma única transação PostgreSQL. Qualquer falha reverte todos os lançamentos e mantém a sessão em `preview`, permitindo nova tentativa. Itens inválidos, duplicados ou sem categoria permanecem no histórico e não geram lançamentos. O desfazer também é transacional e compara o `updated_at` de cada entrada ou saída com o valor capturado na confirmação. Se qualquer lançamento tiver sido alterado ou removido, a operação é recusada com `409`.

O descarte é permitido somente em `preview`, não cria movimentações e remove as referências a categoria e subcategoria dos itens para que cadastros não fiquem bloqueados por uma prévia abandonada. A sessão permanece no histórico como `failed`, com a mensagem explícita de que foi descartada pelo usuário.
