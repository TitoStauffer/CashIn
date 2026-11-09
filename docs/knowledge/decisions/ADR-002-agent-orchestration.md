# ADR-002 — Orquestração hospedada, sequencial e fail-closed

**Status:** aceito
**Data registrada:** 25/10/2026

## Contexto

O processo exige Code Review e consolidação de qualidade vinculados ao SHA correto, mais QA quando o trilho de revisão for completo (DEV-116), usando o Codex autenticado pelo plano existente e a identidade do GitHub App para publicar evidências.

## Decisão

Executar os Agents em runner Windows self-hosted após o CI, na ordem Code Review → QA → Quality Gate Coordinator; desde a DEV-116, o QA é pulado no trilho leve e o Coordinator vem direto depois do Code Review. Publicar evidências duráveis pelo GitHub App e avaliar a prontidão em um gate determinístico separado. Qualquer ausência, divergência de SHA ou falha de API resulta em bloqueio ou inconclusão.

## Consequências

- A máquina do runner precisa estar disponível e protegida.
- Conteúdo do PR é tratado como entrada não confiável.
- Os workflows privilegiados executam apenas código confiável de `master`.
- A orquestração e o gate não fazem merge.
- Mudanças nos contratos dos relatórios exigem atualização coordenada dos produtores e consumidores.

## Fontes

- [`docs/hosted-agent-orchestration.md`](../../hosted-agent-orchestration.md)
- [`automation/delivery-flow.md`](../automation/delivery-flow.md)
- [`.github/workflows/agent-orchestration.yml`](../../../.github/workflows/agent-orchestration.yml)
