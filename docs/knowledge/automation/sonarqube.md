# SonarQube Cloud

**Status:** ativo no CI
**Última revisão:** 25/10/2026

## Escopo analisado

O scanner analisa código de produção em `apps/api/src` e `apps/web/src`. Testes são identificados separadamente e os relatórios LCOV das duas aplicações alimentam a cobertura.

## Quality Gate atual

O projeto usa o gate padrão `Sonar way`:

- confiabilidade A no código novo;
- segurança A no código novo;
- manutenibilidade A no código novo;
- 100% dos novos security hotspots revisados;
- cobertura no código novo maior ou igual a 80%;
- duplicação no código novo menor ou igual a 3%.

A opção do projeto ignora cobertura e duplicação até existirem ao menos 20 linhas novas. Essa configuração remota foi confirmada visualmente em 25/10/2026 e não é versionada no repositório.

## Efeito na automação

O job usa `sonar.qualitygate.wait=true`; um gate reprovado falha o job e impede o início normal da orquestração. O Merge Readiness também exige a evidência correta do Sonar no HEAD atual.

## Fontes verificáveis

- [`sonar-project.properties`](../../../sonar-project.properties)
- [`docs/ci.md`](../../ci.md)
- [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
- Configuração remota do projeto no SonarQube Cloud — verificar novamente quando houver dúvida.
