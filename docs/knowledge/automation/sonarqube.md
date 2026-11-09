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

## Quality Gate da branch `master`

O gate reprovava na `master` enquanto passava em todo Pull Request, e a causa não era a diferença entre condições de código novo e total: **as seis condições do gate são `new_*`**. A diferença é de **janela**. Num PR, "código novo" é o diff daquele PR; na `master`, é tudo desde o início do período (`previous_version`), que inclui arquivos que nenhum PR recente tocou.

Em 08/11/2026 a única condição reprovada era `new_security_rating` = B contra o limite A, por duas vulnerabilidades `MINOR` da regra `tssecurity:S8476` (*Client-Side Request Forgery*) em `creditCardsApi.ts` e `goalsApi.ts`. Eram falsos positivos — todos os chamadores sanitizavam —, e a correção da [DEV-105](https://titostauffer.atlassian.net/browse/DEV-105) foi dar à ferramenta a prova que faltava, com `assertSafeApiPath` nos nove clientes HTTP, em vez de afrouxar o gate.

Para diagnosticar de novo, a API pública responde sem token:

```bash
curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=TitoStauffer_CashIn&branch=master"
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=TitoStauffer_CashIn&branch=master&types=VULNERABILITY&resolved=false&ps=20"
```

`resolved=false` não é opcional: sem ele a busca devolve também as ocorrências já fechadas, com `total` contando as duas. Ao confirmar o critério 3 da DEV-105 essa consulta sem o filtro devolveu as duas `S8476` com status `CLOSED`, e lida de passagem parecia dizer que o gate ainda tinha vulnerabilidades abertas. Confira o campo `status` de cada item, não só o `total`.

O filtro `inNewCodePeriod=true` devolve lista vazia nesta instância; não o use.

Depois do merge da DEV-105 em `1106dc6`, o gate da `master` voltou a **OK** nas seis condições, e as duas ocorrências ficaram `CLOSED` na análise de branch daquele commit; a contagem de vulnerabilidades abertas é zero.

## Fontes verificáveis

- [`sonar-project.properties`](../../../sonar-project.properties)
- [`docs/ci.md`](../../ci.md)
- [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
- Configuração remota do projeto no SonarQube Cloud — verificar novamente quando houver dúvida.
