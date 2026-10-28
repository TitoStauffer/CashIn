# Aprendizados

**Status:** ativo
**Última revisão:** 28/10/2026

Este domínio transforma problemas comprovados em regras reutilizáveis. Ele não substitui tickets, comentários de PR ou ADRs: consolida padrões que ajudam Agents e pessoas a evitar reincidência.

## Notas

- [`code-review-findings.md`](code-review-findings.md): padrões preventivos consolidados dos apontamentos históricos.
- [`code-review-audit.md`](code-review-audit.md): inventário rastreável das revisões e problemas que originaram os aprendizados.
- [`automation-incidents.md`](automation-incidents.md): aprendizados já observados na construção da automação.
- [`agent-process.md`](agent-process.md): regras preventivas para rodadas completas e recuperação sem nova análise.

## Critério para registrar

Registre somente um achado confirmado por PR, código ou incidente. Cada aprendizado deve conter evidência, causa, regra preventiva e forma de detecção. Agrupe ocorrências equivalentes para não transformar o catálogo numa lista duplicada de comentários.

Novos aprendizados estruturados usam um identificador estável em `**Padrão:**`. Antes de criar uma entrada, procure esse identificador e a mesma causa nos arquivos existentes. Uma nova ocorrência amplia a evidência da regra existente; não cria uma regra duplicada.
