# Registro de melhorias

Acompanha a implementação das melhorias da auditoria técnica de 17/11/2026 (revisão `aabb22a`, v1.6.1).
Os IDs (QA-01, CONF-01…) são os do relatório da auditoria. Cada item diz o que mudou, o benefício esperado,
como foi verificado e o que ainda depende de validação fora deste ambiente (Windows, celular, modelo real).

## Concluídas

### Lote 1 — Testes rodando sempre (QA-01)
- **Mudou:** script `npm test` em `desktop/package.json`; workflow `.github/workflows/tests.yml` (todo push e
  pull request, permissão só de leitura); passo **Testes** no `desktop.yml` antes de gerar o `.exe`.
- **Benefício:** uma mudança que quebra um teste aparece antes de chegar ao `main` e não gera executável.
- **Verificado:** ver a seção do lote em “Resultados medidos”.

## Em andamento

- Lote 2 — Parsers `.ol`/`.pvs` que não travam (CONF-01, CONF-02).
- Lote 3 — Verificações que mostram o que não verificaram (ENG-01, ENG-04, ENG-02 a/c/d).
- Lote 4 — Carga e conversão sem falhas silenciosas (DAD-02, CONF-03, CONF-05).

## Pendentes (aprovação não solicitada ainda)

- Lote 5 — Endurecimento do Electron sem trocar a versão (SEG-04, SEG-02 a–c).
- Lote 6 — Arrastar arquivo não sai da página (CONF-04, parte).
- Lote 7 — Permissões do CI (SEG-03, parte).
- Etapas 2 a 4 do relatório (desempenho, refatoração, modernização).

## Bloqueadas (aguardam decisão)

- SEG-01 — Atualizar o Electron 33 → 45.x: precisa de teste do `.exe` no Windows (GPU dedicada e integrada).
- DAD-01 — Identidade do modelo em vistas/conjuntos/links: escolher “só avisar” ou “avisar e remapear”.
- ENG-02 b/e e ENG-03 — Mudam o resultado das verificações (ordem dos candidatos da rota, alcance do
  “apoio”, peça contida em outra).
- CSP no site e no aplicativo: exige hash dos scripts embutidos; risco de quebrar o carregamento.

## Resultados medidos

### Lote 1
- `npm test` (em `desktop/`): 23 testes, 23 passam.
- Portão conferido: com um teste falhando de propósito (numa cópia, fora do repositório), `npm test` sai com
  código 1; sem ele, código 0.
- YAML dos dois workflows lido sem erro; o passo **Testes** fica entre “Instalar dependências” e “Gerar o
  executável”.
- **Pendente:** o passo **Testes** do `desktop.yml` só roda no Windows quando houver push no `main` (ou
  “Run workflow”); a forma usada (`node --test "test/*.test.js"`, padrão expandido pelo próprio Node) não
  depende do shell.
