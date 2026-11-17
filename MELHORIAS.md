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

### Lote 3 — Verificações que mostram o que não verificaram (ENG-01, ENG-04, ENG-02 a/c/d)
- **Mudou:**
  - `viewer/ui/analysis.js` (interferência): pares sem geometria legível ou com erro no cálculo são
    contados e mostrados (“28 de 29 pares verificados … · 1 par(es) NÃO verificado(s)”), com uma linha
    que seleciona as peças desses pares; interrompida, conta só os pares de fato verificados.
  - `viewer/ui/mannequin.js`: as peças em volta são ordenadas pela distância ao corpo antes de pegar as
    400 (antes: as 400 primeiras pela numeração, embora a mensagem dissesse “mais próximas”); peças não
    verificadas são avisadas.
  - `viewer/ui/route.js` (rota de retirada): equipamento com mais de 300 peças é avisado; peça sem
    geometria ou erro no cálculo é “não verificada” (antes: contava como “não bate”); “Passa sem bater”
    só quando tudo foi verificado.
- **Benefício:** um resultado “sem interferência / sem contato / passa” passa a significar “verificado e
  livre”, e não “não deu para verificar”.
- **Mudança funcional (aprovada):** só as mensagens; quando tudo é verificado, os textos são os mesmos de
  antes (medido abaixo).

### Lote 4 — Carga e conversão sem falhas silenciosas (DAD-02, CONF-03, CONF-05)
- **Mudou (`viewer/viewer.js`, `viewer/lib/convert.js`, `viewer/lib/olworker.js`):**
  - `app.emit`: o erro de um ouvinte vai para o console e não impede os outros nem quem emitiu o evento.
  - `loadParts`: uma carga pedida durante outra espera e carrega o que ainda faltar (antes: voltava na hora
    sem carregar nada — uma tag NFC lida durante a abertura, por exemplo, não achava a peça carregada).
  - Leitura do modelo original: peças de uma tarefa que falhou ficam “não carregadas” (contadas no status;
    **Carregar…** tenta de novo); as que já receberam geometria antes da falha ficam carregadas, com o
    aviso “podem estar incompletas”, e nada é desenhado duas vezes. Se um worker cai, só a tarefa dele
    conta como falha e os outros continuam (antes: “Erro: …” e o botão Carregar sumia).
  - Conversão no desktop: os `.ol` ausentes ou ilegíveis são informados ao terminar (com os nomes) e
    gravados em `chunks.json` como `missing: {count, names}`; ao abrir essa pasta, o visualizador avisa.
    O worker passou a enviar `missingNames` na mensagem `done` (campo novo; quem não o usa o ignora).
- **Benefício:** nenhuma peça fica “carregada” sem geometria em silêncio; falhas podem ser refeitas; uma
  conversão incompleta não passa por completa.
- **Compatibilidade:** `missing` é um campo novo e opcional: versões anteriores abrem a pasta normalmente
  (medido). Exportações feitas a partir dessa pasta (celular, ZIP, estrutura reorganizada) copiam o campo e
  mostram o mesmo aviso “(na conversão)”.

### Lote 5 — Endurecimento do aplicativo desktop (SEG-04, SEG-02 a–c)
- **Mudou:** `desktop/security.js` (novo, testável sem Electron) e `desktop/main.js`:
  - arquivos de `app://` e `model://` só de dentro da pasta (antes: uma pasta irmã com o mesmo começo de
    nome, como `SBR-convertido`, era legível); endereço malformado responde 400 (antes: falha da requisição);
  - links abertos fora do aplicativo: só `https:` (antes: qualquer endereço, inclusive outros programas,
    como `ms-settings:`);
  - a janela não navega para fora do visualizador (`will-navigate`, `will-redirect`);
  - as 14 mensagens da ponte (IPC) só são atendidas se vierem de `app://viewer/`.
  - `security.js` entrou na lista de arquivos empacotados (`desktop/package.json`).
- **Benefício:** a ponte com acesso a arquivos e diálogos fica restrita às páginas do próprio visualizador.

## Em andamento

- Nenhuma.

## Pendentes (aprovação não solicitada ainda)

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
- Workflow **Testes** no GitHub após o push: jobs `node` e `python` com sucesso (execução nº 2).

### Lote 3
Chromium, modelo de exemplo do `tools/navsample.py` (21 peças) e uma variação com 502 peças (500 cubos em
volta de um ponto e, por último na numeração, uma barra atravessando o peito do manequim). Falhas
simuladas trocando `app.partGeometry` (peça sem geometria) ou o cálculo do worker (erro), em tempo de
execução, nas duas versões.

| Cenário | Antes | Depois |
|---|---|---|
| Interferência, sem falha | 29 pares · 11 interferências · 16 contatos | idêntico |
| Interferência, uma peça sem geometria | “29 pares verificados” · **10** interferências | “28 de 29 pares verificados” · 10 · “1 par NÃO verificado” + linha de aviso |
| Interferência, erro no cálculo | “29 pares verificados” · 10 | igual à linha acima |
| Interferência interrompida (5.000 pares) | “Interrompido. **5.000** pares verificados” | “Interrompido. **2.761 de 5.000** pares verificados” |
| Rota, sem falha | “Passa sem bater.” + apoio | idêntico |
| Rota, piso sem geometria / erro | “Passa sem bater.” (apoio some) | “verificação ficou incompleta” + nome da peça |
| Rota, equipamento de 500 peças | só os trechos | + “só as 300 primeiras foram verificadas” |
| Manequim, modelo de 21 peças | “Sem contato: nada a menos de 300 mm.” | idêntico |
| Manequim, 500 peças + barra no peito | “**Sem contato.** Folga mínima 205 mm” (falso) | “**Encosta em 1 peça: BARRA NO PEITO**” |

- `npm test`: 31 passam. ESLint sem avisos nos 3 arquivos.
- **Não testado:** a interface no celular (os textos novos ficam no mesmo lugar dos antigos).
- Workflow **Testes** no GitHub após o push: ver o registro do lote 4.

### Lote 4
Chromium; modelo de exemplo (convertido) e modelo original de teste (`.pvs` + 3 `.ol`). Falhas do worker
injetadas no `olworker.js` pela interceptação de rede do navegador; conversão do desktop com um
`window.desktop` simulado que guarda em memória os arquivos que seriam gravados.

| Cenário | Antes | Depois |
|---|---|---|
| Ouvinte de evento com erro durante uma seleção | a exceção chega a quem selecionou; o ouvinte seguinte **não roda** | isolada; o seguinte roda |
| Duas cargas pedidas ao mesmo tempo | **1 de 2** peças carregadas | 2 de 2 |
| Modelo original, sem falha | 3 peças, 2 malhas | idêntico |
| Worker falha antes de enviar geometria | “3 arquivo(s) .ol ausente(s)” (falso), peças “carregadas” sem geometria, sem como tentar de novo | “0 de 3 peças carregadas · 3 não lida(s) por erro”, **Carregar** visível; tentando de novo: 3 peças, 2 malhas |
| Worker falha depois de enviar geometria | “3 arquivo(s) .ol ausente(s)” (falso) | “3 peças carregadas · 3 peça(s) com erro na leitura podem estar incompletas”; tentar de novo não duplica (2 malhas) |
| Worker cai | “Erro: …”, botão **Carregar** escondido | igual à falha antes da geometria (recuperável) |
| Conversão sem falta | 7 arquivos | **idênticos byte a byte** |
| Conversão sem `p2.ol` | “Modelo convertido…”, sem aviso | aviso com o nome; `missing: {count: 1, names: ["p2.ol"]}` |
| Abrir a pasta convertida sem `p2.ol` | o visualizador anterior abre normalmente | abre e avisa “(na conversão)” |

- Modelo original com `.ol` ausente ou corrompido: mesmo comportamento de antes (“1 arquivo(s) .ol
  ausente(s) ou ilegível(is)”). Abertura geral no desktop e no celular (emulado): ~0,8–0,9 s, sem erros
  no console.
- `npm test`: 31 passam; `tools/test_parsers.py`: 5 passam. ESLint: nenhum aviso novo (os 2 de
  `viewer.js` já existiam: `mobile` sem uso, escape desnecessário).
- **Pendente:** conversão real no aplicativo desktop (Windows) com um modelo real.

### Lote 5
Aplicativo desktop real (Electron 33.2.1, Linux com tela virtual, Playwright), versão anterior × nova,
com a pasta `SBR` (modelo de exemplo) e, ao lado, `SBR-segredo/segredo.txt`. `shell.openExternal` foi
trocado por um registrador durante o teste (nada foi aberto de fato).

| Cenário | Antes | Depois |
|---|---|---|
| `model://local/..%2FSBR-segredo%2Fsegredo.txt` | **200** com o conteúdo | 403 |
| `model://local/%E0%A4%A` (malformado) | falha da requisição | 400 |
| Arquivo do modelo (`chunks.json`) | 200 | 200 |
| `window.open` de `file:`, `https:`, `ms-settings:` | abriu `https:` **e `ms-settings:`** | abre só `https:` |
| Navegar para `https://example.com/` | a janela **saiu do aplicativo**, com a ponte disponível | permanece em `app://viewer/` |
| Navegar para `file:///…` | bloqueado pelo Chromium | permanece em `app://viewer/` |
| Modelo original pela linha de comando; `openFolder`; `conversionWrite` sem conversão; “Abrir outro modelo” | funciona | idêntico |

- Pacote gerado com `electron-builder --linux dir` (cópia fora do repositório): `security.js` está no
  `app.asar` e o executável empacotado abre o modelo.
- `npm test`: 35 passam (4 novos em `desktop/test/security.test.js`, inclusive caminhos do Windows).
  ESLint sem avisos nos arquivos alterados.
- **Pendente:** o `.exe` no Windows (gerado pelo CI) — o mesmo código, outro sistema.
