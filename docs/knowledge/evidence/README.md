# Evidências do vault

**Status:** ativo
**Última revisão:** 25/10/2026

Este diretório preserva evidências suficientes para auditar as afirmações do vault sem transformar snapshots em uma nova fonte de verdade. Código, migrations, workflows, configurações remotas e registros originais continuam prevalecendo.

## Conteúdo

- [`code-review-index.md`](code-review-index.md): índice imutável da coleta histórica de revisões formais, com links para o GitHub.
- [`source-manifest.md`](source-manifest.md): objetos Git das fontes locais consultadas na criação do vault.
- [`validation-report.md`](validation-report.md): escopo, comandos e resultados da validação desta entrega.

## Reprodução

Execute o validador local a partir da raiz do repositório:

```powershell
pwsh -File tools/knowledge/validate-vault.ps1
```

Dados remotos que não estão versionados devem ser consultados novamente no sistema de origem. A ausência de acesso remoto deve ser registrada como limitação, sem converter observação manual em garantia permanente.
