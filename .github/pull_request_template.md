# Pull Request

> Título do PR: `[DEV-XXX] - título objetivo do ticket`

## 1. Ticket relacionado

- **Jira:** [DEV-XXX](https://titostauffer.atlassian.net/browse/DEV-XXX)
- **Tipo de entrega:** Feature / Bugfix / Refactoring / Chore / Documentation
- **Épico relacionado:** [DEV-XXX](https://titostauffer.atlassian.net/browse/DEV-XXX), quando aplicável

## 2. Objetivo

Descreva brevemente o problema que esta alteração resolve ou o resultado que pretende alcançar.

## 3. Alterações realizadas

Liste as principais mudanças implementadas.

-
-
-

## 4. Escopo da implementação

### Incluído

-

### Fora do escopo

-

## 5. Decisões técnicas

Descreva as decisões relevantes de implementação e suas justificativas. Remova os itens que não se aplicarem.

- **Arquitetura e design:**
- **Backend / API:**
- **Frontend:**
- **Banco de dados / migrations:**
- **Integrações externas:**
- **Segurança:**

## 6. Banco de dados e migrations

Marque o que se aplica e descreva impactos relevantes.

- [ ] Não houve alteração no banco de dados.
- [ ] As migrations necessárias foram criadas e revisadas.
- [ ] A compatibilidade e a estratégia de rollback foram avaliadas, quando aplicável.
- [ ] Os impactos sobre dados existentes foram avaliados.

## 7. Estratégia de testes

### Testes executados

Marque somente verificações realmente executadas.

O Agent técnico principal informa os comandos e resultados. O Agent de Product Manager mantém os checkboxes factuais atualizados com base nessas evidências; as aprovações de Code Review e QA são marcadas por seus respectivos agentes na seção 13.

- [ ] Testes unitários.
- [ ] Testes de integração.
- [ ] Testes de contrato/API, quando aplicável.
- [ ] Testes de frontend, quando aplicável.
- [ ] Testes de regressão.
- [ ] Build e verificações estáticas.

**Comandos executados:**

```text
# Liste os comandos realmente executados
```

**Resultado:**

Descreva os resultados observados. Não marque verificações que não foram executadas.

**Verificação por mutação (evidência de desenvolvimento):**

Liste cada mutante aplicado, o teste que o derrubou e a confirmação de que o arquivo voltou ao original. A mutação não é critério de aceitação e não entra na seção 8; quando a verificação puder rodar no CI, aponte o teste ou o passo correspondente.

## 8. Critérios de aceitação

Descreva somente comportamento verificável pelo diff e pelas execuções de CI deste SHA. Verificação por mutação local fica na seção 7.

- [ ] Critério 1:
- [ ] Critério 2:
- [ ] Critério 3:

## 9. Segurança e qualidade

Marque os itens avaliados e aplicáveis; explique qualquer exceção.

- [ ] O tratamento de erros foi revisado.
- [ ] As entradas e os dados sensíveis foram tratados adequadamente.
- [ ] Não foram introduzidos segredos ou credenciais no código.
- [ ] Os impactos sobre autorização e autenticação foram avaliados.
- [ ] A implementação segue os padrões de código e arquitetura do projeto.
- [ ] Os impactos sobre logs, métricas e observabilidade foram avaliados.

## 10. Evidências

Adicione evidências relevantes para a revisão.

- **Screenshots / vídeos:** quando aplicável.
- **Logs ou resultados de testes:** quando relevantes.
- **Documentação ou contratos atualizados:** quando aplicável.

## 11. Riscos e limitações

- **Riscos conhecidos:**
- **Limitações:**
- **Dependências ou pendências:**

Se não houver riscos ou limitações conhecidos, declare isso explicitamente.

## 12. Checklist de conclusão

O Agent de Product Manager é responsável por conferir e atualizar este checklist com base nas evidências fornecidas pelo Agent técnico principal. Faça a conferência final após Code Review, QA quando o trilho de revisão for completo, e checks configurados, antes do merge.

- [ ] O PR está vinculado ao ticket correto do Jira.
- [ ] O escopo implementado corresponde ao ticket.
- [ ] Não foram incluídas alterações não relacionadas.
- [ ] Os testes relevantes foram executados e os resultados registrados.
- [ ] A documentação foi atualizada quando necessário.
- [ ] Não existem conflitos de merge conhecidos.
- [ ] O PR está pronto para revisão.

## 13. Revisão e aprovação

- [ ] **Code Review aprovado** — marcado pelo Agent de Code Review somente após a aprovação.
- [ ] **QA aprovado** — marcado pelo Agent de QA somente após a aprovação.
- **Observações finais:**

> O merge só deve ocorrer após a aprovação obrigatória do Code Review, do QA quando o trilho de revisão for completo, e de todas as verificações configuradas, conforme o workflow do projeto. No trilho leve o QA não roda e o seu checkbox permanece desmarcado por construção.
