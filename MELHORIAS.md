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

### Lote 2 — Parsers `.ol`/`.pvs` que não travam (CONF-01, CONF-02)
- **Mudou:**
  - `viewer/lib/ol.js` e `tools/ol.py`: um registro com tamanho negativo é “arquivo .ol corrompido” (antes:
    laço infinito). Arestas danificadas deixam a peça sem arestas, com as faces; sem faces, o arquivo
    continua ilegível.
  - `viewer/lib/pvs.js` (`buildTree`), `viewer/lib/pvswrite.js` (`nodeComponents`) e `tools/build.py`
    (`flatten_tree`, extraído de `main` para poder ser testado): componente que contém a si mesmo ou
    referência a componente inexistente dão erro com mensagem (antes: árvore crescendo até estourar a
    memória). A mesma peça usada em vários lugares continua aparecendo em cada um.
  - Testes novos: `desktop/test/ol.test.js`, `desktop/test/pvs.test.js`, `tools/test_parsers.py`; o
    workflow **Testes** ganhou o job `python`.
- **Benefício:** um arquivo danificado (cópia interrompida, disco ruim) passa a ser contado como “ausente ou
  ilegível”, sem travar ou derrubar a aba, o worker de leitura, a ferramenta Medir ou o `build.py`.
- **Compatibilidade:** nenhum formato de arquivo mudou; para arquivos válidos a saída é idêntica (medido
  abaixo).

## Em andamento

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
- Workflow **Testes** executado no GitHub após o push do lote: sucesso (execução nº 1).
- **Pendente:** o passo **Testes** do `desktop.yml` só roda no Windows quando houver push no `main` (ou
  “Run workflow”); a forma usada (`node --test "test/*.test.js"`, padrão expandido pelo próprio Node) não
  depende do shell.

### Lote 2
- `npm test`: 31 testes, 31 passam (23 anteriores + 8 novos). `tools/test_parsers.py`: 5 passam.
- Os testes novos falham no código anterior: `.ol` com tamanho negativo não termina em 5 s (JS e Python);
  `.pvs` cíclico estoura a memória do worker de teste.
- Comparação código anterior × novo (cópias fora do repositório):
  - `loadOL` em 3.001 arquivos (o válido + 3.000 danificados ao acaso): 2.678 idênticos; 201 erro → erro
    (só a mensagem); 84 antes erro → agora faces sem as arestas danificadas; 27 antes “vazio” silencioso →
    agora “corrompido”; 3 antes laço infinito → agora “corrompido”; 8 antes geometria → agora “corrompido”
    (nos 8, a geometria antiga era diferente da do arquivo válido: dados lidos fora do lugar).
  - `buildTree` e `nodeComponents` em 500 árvores válidas aleatórias (com peças repetidas): 500 idênticas.
  - `tools/build.py` num modelo original de teste (`.pvs` + 3 `.ol`) e no mesmo modelo sem um `.ol`: os 7
    arquivos de saída idênticos byte a byte. Com um `.ol` corrompido: o anterior trava; o novo termina com
    `WARN p3.ol: arquivo .ol corrompido…`.
- No navegador (Chromium, modelo original de teste aberto por `?pvs=`): com o `.ol` corrompido, a versão
  anterior derruba a aba; a nova abre as 3 peças, mostra “1 arquivo(s) .ol ausente(s) ou ilegível(is)”, e
  Medir nessa peça responde em ~13 ms. Tempo de Medir numa peça válida: 10–26 ms nas duas versões (5 + 5
  medições, duas vezes).
- ESLint (regras recomendadas) sem avisos nos arquivos alterados.
- **Pendente:** confirmar com um modelo real (SBR) que abre e converte como antes.
