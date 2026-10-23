# Contrato de importação financeira

A API mantém sessões de importação por carteira para que o cliente possa enviar um arquivo, revisar a prévia e confirmar os lançamentos em uma única transação. A fundação não interpreta OFX ou CSV diretamente; os parsers desses formatos são entregas separadas.

## Limites e segurança

- O upload usa `application/octet-stream` e não persiste o arquivo bruto.
- O arquivo pode ter até 10 MB e a prévia pode conter até 10.000 movimentações.
- `x-file-name` contém o nome codificado com `encodeURIComponent` e `x-file-format` aceita `ofx` ou `csv`.
- Todas as operações exigem sessão autenticada e respeitam a carteira selecionada por `x-wallet-id`.
- Valores monetários permanecem como strings decimais com duas casas no contrato e como `numeric(14,2)` no PostgreSQL.

## Endpoints

| Método | Caminho | Resultado |
|---|---|---|
| `POST` | `/financial-imports` | Cria a sessão, processa o arquivo em memória e devolve a prévia. |
| `GET` | `/financial-imports` | Lista o histórico da carteira no envelope `{ "items": [...] }`. |
| `GET` | `/financial-imports/:importId` | Devolve a sessão e seus itens. |
| `PATCH` | `/financial-imports/:importId/items/:itemId` | Atualiza data, descrição, tipo, categoria e subcategoria durante a prévia. |
| `POST` | `/financial-imports/:importId/confirm` | Cria todas as movimentações válidas atomicamente. |
| `POST` | `/financial-imports/:importId/undo` | Remove os lançamentos gerados se nenhum deles tiver sido alterado. |

As sessões usam os estados `processing`, `preview`, `completed`, `failed` e `undone`. O resumo separa itens `valid`, `duplicate`, `invalid`, `uncategorized` e `imported`. `canUndo` e `undoBlockedReason` permitem que o cliente apresente a elegibilidade do desfazer sem presumir o estado.

## Confirmação e desfazer

A confirmação importa somente itens válidos e ocorre em transação PostgreSQL. Itens inválidos, duplicados ou sem categoria permanecem no histórico e não geram lançamentos. O desfazer também é transacional e compara o `updated_at` de cada entrada ou saída com o valor capturado na confirmação. Se qualquer lançamento tiver sido alterado ou removido, a operação é recusada com `409`.
