# Registro de melhorias

Acompanha a implementação das melhorias da auditoria técnica de 17/11/2026 (revisão `aabb22a`, v1.6.1).
Os IDs (QA-01, CONF-01…) são os do relatório da auditoria. Cada item diz o que mudou, o benefício esperado,
como foi verificado e o que ainda depende de validação fora deste ambiente (Windows, celular, modelo real).
A **revisão geral de 23/11/2026** (v1.7.0, lotes 8 a 16) segue o mesmo formato.

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

### Lote 6 — Soltar arquivo não sai da página (CONF-04, parte)
- **Mudou (`viewer/viewer.js`):** um arquivo ou pasta solto fora da zona do cartão de abertura (sobre o
  modelo, num painel) é cancelado com a dica “use Abrir”; antes, o navegador o abria no lugar do
  visualizador e o que estava na tela se perdia. Só arrastos de arquivos são afetados; a zona do cartão
  continua abrindo ZIP e pastas. (No aplicativo desktop, o lote 5 já impede a janela de navegar.)
- **Benefício:** um arraste acidental não descarta seleção, cortes, medições e marcações.
- **Não incluído:** aviso ao fechar a página com trabalho não salvo (`beforeunload`).

### DAD-01 — Vista ou conjunto de outra versão do modelo (opção “avisar”)
- **Mudou:** `viewer/viewer.js` calcula `app.modelSignature` (nome, nº de peças e os nomes dos arquivos
  das peças — a mesma regra de `ui/structure.js` e `ui/anim.js`); `viewer/ui/views.js` e
  `viewer/ui/sets.js` gravam essa assinatura (`sig`) em vistas, links, arquivos de vista, conjuntos e
  esquemas. Ao aplicar por ação do usuário (“Aplicar”, “Selecionar”, “+”, “Isolar”, arquivo, link) algo
  de outra versão, o visualizador pergunta antes; na lista, esses itens aparecem com ⚠. Itens salvos
  antes (sem `sig`) funcionam como antes, com uma nota.
- **Benefício:** depois de uma revisão do modelo, uma vista ou um conjunto não muda cores, visibilidade e
  seleção de outras peças sem aviso.
- **Compatibilidade:** só um campo novo (`sig`); nada foi apagado nem migrado. As chaves de armazenamento
  não mudaram. **Não incluído:** remapear as peças por código/nome (opção b) e as abas de vista (já
  separadas por nome + nº de peças).

### ENG-02 b/e e ENG-03 — Rota de retirada e peça contida em outra
- **Mudou:**
  - `viewer/lib/geom.js`: `isClosed` (malha fechada: cada aresta em exatamente dois triângulos),
    `pointInside` (três raios votam; numa peça oca, a cavidade conta como fora) e `contained` (uma malha
    inteira dentro de outra, **só se a de fora for fechada** — malha aberta nunca gera alarme).
  - `viewer/lib/geomworker.js`: quando as superfícies não se cruzam nem se tocam, testa a contenção
    (`contained: true, d: 0`). Interferência mostra “Interferência (uma dentro da outra)”; Medir mostra
    “uma peça está dentro da outra”; manequim e rota já tratam distância 0 como contato.
  - `viewer/ui/route.js`: candidatos de cada passo ordenados pela folga entre as caixas (quem encosta
    primeiro) e só depois pelo centro; o “apoio” (o que encosta onde ele está) volta a ser verificado
    quando o equipamento desce abaixo da posição inicial.
  - **Defeito encontrado nos testes e corrigido:** o worker de cálculo guarda até 600 malhas e
    descartava pela ordem de chegada; numa rota com muitas peças, a malha do **próprio equipamento** era
    descartada no meio da verificação e o worker respondia “sem colisão” para uma malha que não tinha.
    Agora descarta a menos usada (LRU, com a página espelhando a mesma ordem) e uma malha ausente é erro
    (“não verificado”), nunca “sem colisão”. Interferência, Medir e rota reconfirmam as malhas antes de
    comparar.
- **Benefício:** peça embutida, manequim dentro de um sólido e equipamento descendo pelo piso deixam de
  passar como livres; peças grandes que encostam no caminho deixam de ficar fora da amostra.
- **Limites conhecidos:** a contenção só vale para malhas fechadas — peças com várias cores ou divididas
  entre blocos da pasta convertida (posições quantizadas por bloco) podem não fechar e então não são
  testadas; quanto isso ocorre num modelo real ainda não foi medido. Um apoio lateral (parede encostada)
  continua ignorado em movimento horizontal.

### SEG-01 — Electron 33 → 44 (versão com suporte)
- **Mudou:** `desktop/package.json` e `desktop/package-lock.json`: Electron **33.2.1 → 44.11.3**
  (Chromium 130 → 152; a linha 44 é estável desde agosto/2026 e tem suporte), electron-builder
  **25.1.8 → 26.18.1**. Nenhuma linha de código precisou mudar.
- **Benefício:** `npm audit` deixa de apontar avisos do Electron (eram ~45, 7+ altos); no total, de 18
  avisos (1 crítico, 13 altos) para 11 (0 críticos, 6 altos).
- **Risco residual:** os 11 restantes são de ferramentas de build (`picomatch`, `minimatch`, `node-gyp`
  dentro do electron-builder 26), sem versão corrigida compatível (`npm audit fix` não muda nada; a
  “correção” sugerida é voltar ao electron-builder 24). Só rodam ao gerar o `.exe`.

### CSP no aplicativo desktop (SEG-02 d, parte)
- **Mudou:** `desktop/security.js` (`viewerCSP`) e `desktop/main.js`: as páginas do visualizador saem com o
  cabeçalho `Content-Security-Policy` — scripts só do próprio aplicativo; os scripts embutidos do
  `index.html` liberados pelo **hash, calculado do próprio arquivo ao servi-lo** (editar o `index.html`
  não quebra a política); sem `unsafe-inline`/`unsafe-eval` para scripts, sem plugins (`object-src
  'none'`), `base-uri 'none'`, `form-action 'none'`; modelos por `model:`, imagens/downloads por `blob:`/`data:`.
- **Benefício:** um script injetado na página (um defeito futuro, um dado malicioso) não roda, e com ele
  não chega à ponte do aplicativo.
- **Não incluído:** CSP no site (GitHub Pages). Lá ela iria numa `<meta>` com hashes **fixos**; uma
  edição dos scripts embutidos sem atualizar o hash deixaria o site em branco. Alternativas: (a) mover os
  dois scripts embutidos para arquivos e manter só o hash do `importmap`, conferido por um teste no CI;
  (b) não aplicar no site (risco atual baixo: a auditoria não achou ponto de XSS).

### Lote 7 — Permissões do CI (SEG-03, parte)
- **Mudou (`.github/workflows/desktop.yml`):** permissão `contents: read` por padrão; a criação do Release
  foi para um job próprio (`release`), o único com `contents: write`, que roda só em tags `v*`, depois do
  build, com o `.exe` baixado do artefato.
- **Benefício:** o build — que instala e roda pacotes de terceiros (`npm ci`, electron-builder) — não tem
  mais permissão de escrita no repositório.
- **Não incluído:** fixar as actions por SHA e Dependabot (parte restante de SEG-03).

### Revisão geral de 23/11/2026 (v1.7.0)
Revisão de todo o `viewer.js`, dos módulos de busca, árvore, desfazer, armazenamento no aparelho, service worker
e do aplicativo desktop, procurando defeitos, otimizações e funcionalidades que faltavam. Cinco grupos de
mudanças, cada um verificado contra a versão anterior (ver “Resultados medidos › Revisão geral”).

#### Lote 8 — Bloco ilegível da pasta convertida ou do ZIP não trava a abertura
- **Mudou (`viewer/viewer.js`, `loadConvertedParts` / `loadPartsNow`):** cada arquivo de bloco (`c/NNNNN.bin`) é
  lido e conferido (tamanho mínimo pelo `chunks.json`) antes de ir para a placa de vídeo. Um bloco que não pode ser
  lido (ausente, cortado ao meio, danificado dentro do ZIP) é contado, fica “não carregado” e os outros continuam;
  ao terminar aparece “20 de 21 peças carregadas · 1 bloco(s) do modelo não lido(s) por erro · use Carregar… para o
  resto”, e **Carregar…** tenta de novo. É o que o lote 4 já fazia para o modelo original (`.pvs` + `.ol`).
- **Antes:** a abertura parava para sempre em “Carregando geometria 20/21”, nenhuma peça contava como carregada, o
  evento “modelo aberto” não acontecia (sem Exportar, sem Carregar…, sem link de peça/tag NFC, sem guardar o ZIP no
  aparelho).
- **Compatibilidade:** modelos íntegros carregam exatamente como antes (mesma ordem, mesmos blocos).

#### Lote 9 — Geometria das peças para Medir, Interferência, Manequim e Rota ~100× mais rápida
- **Mudou (`viewer/viewer.js`, `geomFromChunks`):** a geometria de uma peça da pasta convertida era montada
  percorrendo **todos os itens do modelo** e, para cada item da peça, **todos os vértices e triângulos do bloco**
  (até 65 mil vértices). Agora usa o índice de itens por peça (já existente, `itemsIndex`) e, para cada arquivo de
  bloco lido, um índice de vértices, triângulos e arestas por item, montado uma vez e guardado com o arquivo
  (cache de 6 blocos, agora descartando o menos usado).
- **Benefício:** cada peça custa o próprio tamanho. Interferência, folga, manequim e rota de retirada pedem
  centenas de peças seguidas.
- **Compatibilidade:** a saída é a mesma, na mesma ordem (conferido byte a byte, ver resultados).

#### Lote 10 — Pequenas correções
- **Atalhos de teclado antes de abrir um modelo** (`viewer.js`): `A`, `Esc`, `I`, `H`, `G`, `F`, setas etc.
  davam erros no console atrás do cartão de abertura (“Cannot read properties of undefined (reading 'fill')”,
  “modelMin is not iterable”); agora não fazem nada até haver um modelo.
- **Cópias de ZIP pela metade no aparelho** (`lib/recent.js`, `trimKept`): uma cópia interrompida (página fechada
  no meio) deixava o arquivo `.parcial` para sempre no armazenamento do site. Agora é apagado depois de 6 horas (o
  prazo protege uma cópia em andamento em outra aba).
- **Painel Desempenho** (`viewer.js`): monta as linhas com texto, não HTML (o nome da placa de vídeo vem do driver).
- **Ajuda de atalhos** (`index.html`): faltavam `B` (bigramas), `V` (animação) e as teclas da caminhada.
- **Avisos antigos do ESLint** zerados: import sem uso (`goto.js`), constante sem uso (`viewer.js`), barras
  escapadas sem necessidade em duas expressões regulares (mesmo significado).

#### Lote 11 — ARQ-02: uma só assinatura do modelo
- **Mudou:** `ui/structure.js` (Minha estrutura) e `ui/anim.js` (animações) usam `app.modelSignature`, calculada
  uma vez em `setModel`, em vez de repetir o mesmo cálculo.
- **Compatibilidade:** a mesma regra, o mesmo texto: as chaves de armazenamento não mudam (estruturas e animações
  salvas continuam abrindo). Conferido no navegador: assinatura nova = cálculo antigo.

#### Lote 12 — Nova funcionalidade: condições de propriedade na Busca
- **Mudou:** `viewer/lib/query.js` (novo, sem dependências, testado em `desktop/test/query.test.js`) e
  `viewer/ui/search.js`. Na caixa de busca, além das palavras: `Material=S355*` (curingas `*` e `?`),
  `Thickness>10` (`>` `<` `>=` `<=`; vírgula ou ponto; “12 mm” vale 12), `Thickness=8|10|12` (alternativas),
  `Description~TUBE` (contém), `Material!=S355` (tem a propriedade, com outro valor), `"Unit weight">50` (aspas
  para espaços). A linha de resultados mostra as condições entendidas. Comparação com valor que não é número
  (“Thickness>grosso”) mostra o erro em vez de resultados.
- **Por quê:** o ROADMAP marcava “Busca por propriedade (`Material = S355*`, `Thickness > 10`…)” como feita, mas
  ela tinha sido retirada na simplificação da busca (commit `5d9036d`); só restava buscar texto nos valores.
- **Compatibilidade:** uma palavra só vira condição quando o que está antes do operador é o nome de uma
  propriedade **do modelo aberto**; sem nenhuma condição, a busca usa exatamente o código anterior (as mesmas
  palavras, o mesmo resultado). Funciona também na busca rápida do celular.
- **Versão:** `VERSION` 1.6.1 → **1.7.0** (`viewer/ui/util.js`).

#### Lote 13 — Buscas salvas
- **Mudou (`viewer/ui/search.js`, `index.html`):** na aba Busca, “Salvar busca” guarda texto, bigrama, tipo de
  item e a opção das propriedades com um nome (lista única, até 50, em `pvs-viewer:searches`); escolher na lista
  preenche os campos e busca; ✕ exclui (com confirmação). Busca vazia não é salva (aviso na linha de resultados).
- **Por quê:** guarda a pergunta, não as peças: funciona em qualquer modelo e numa nova versão do mesmo modelo —
  a parte de DAD-01 opção b que dá para resolver sem remapear números de peça.
- **Compatibilidade:** só uma chave nova no armazenamento; nada existente muda.

#### Lote 14 — Aviso ao sair com trabalho só na tela
- **Mudou:** `viewer/ui/unsaved.js` (novo), `ui/views.js` (pontos de salvamento) e `ui/markup.js`
  (`app.markupItems`). Medições, marcações à mão e manequins só ficam guardados numa vista; se algum mudou desde a
  última vez em que foi salvo (salvar ou atualizar uma vista, copiar o link, exportar o arquivo, aplicar uma vista),
  fechar a aba, recarregar ou “Abrir outro modelo” faz o navegador perguntar antes de sair.
- **Não incluído no aplicativo desktop:** no Electron, uma página que pede para ficar impede a janela de fechar sem
  mostrar pergunta nenhuma; lá o comportamento continua o de antes.
- **Compatibilidade:** sem medições, marcações ou manequins (ou com eles salvos), nada muda ao sair.

#### Lote 15 — SEG-03: Dependabot
- **Mudou:** `.github/dependabot.yml` (novo): uma vez por mês, um pull request agrupado para o npm do aplicativo
  desktop (Electron, electron-builder) e outro para as GitHub Actions dos workflows; cada um passa pelo workflow
  **Testes**; nada é aceito sozinho.
- **Não incluído:** fixar as actions por SHA (o Dependabot atualiza as versões; fixar por SHA pede consultar os
  repositórios das actions, fora do acesso desta sessão). Atualizações de segurança imediatas dependem de ligar
  “Dependabot security updates” nas configurações do repositório.

#### Lote 16 — `viewer.js` menor (refatoração sem mudança de comportamento)
- **Mudou:** os shaders (GLSL, ~170 linhas) foram para `viewer/lib/shaders.js` e a leitura de fontes do modelo
  (servidor, pasta do navegador, lista de arquivos, pasta do aplicativo desktop) para `viewer/lib/sources.js`, este
  com testes novos (`desktop/test/sources.test.js`). `viewer.js`: ~3.390 → ~3.190 linhas.
- **Verificado:** os 7 textos de shader comparados com os do arquivo anterior: idênticos (a comparação pegou e
  corrigiu um `export` posto por engano dentro do GLSL pelo script de mudança); imagens renderizadas, seleção por
  clique e mapa de caminhada idênticos byte a byte (ver resultados).
- **Ainda em `viewer.js`:** câmera/navegação e caminhada, que dividem muito estado com o laço de desenho; separar
  pede mais cuidado e fica para uma próxima etapa.

## Em andamento

- Nenhuma.

## Validação pendente (fora deste ambiente)

- `.exe` com Electron 44 no Windows (artefato **VisualizadorPVS-windows** da execução nº 32 do workflow do
  executável), em placa dedicada e integrada, com um modelo real: abrir, converter,
  exportar (SEG-01, lotes 4 e 5, CSP).
- Job `release` (lote 7): só roda numa tag `v*`; validar na próxima versão publicada.
- Modelo real (SBR): abertura, conversão e verificações com peças fechadas (lotes 2 a 4, ENG-03).
- Celular: textos novos das verificações e soltar arquivo (lotes 3 e 6).
- Revisão geral (v1.7.0): busca por condição num modelo real (nomes de propriedades do SBR) e no celular
  real; tempo de Interferência/Rota no SBR com o lote 9.

## Pendentes (aprovação não solicitada ainda)

- SEG-03 restante: fixar actions por SHA (o Dependabot foi configurado no lote 15).
- Etapas 2 a 4 do relatório (desempenho, refatoração, modernização). ARQ-02 foi feito na revisão geral.
- `viewer.js`: separar câmera/navegação e caminhada em módulos (shaders e fontes do modelo já saíram, lote 16).
- Aviso de trabalho não salvo no aplicativo desktop: tratar `will-prevent-unload` no `main.js` com um diálogo
  próprio (Sair / Ficar) e então ligar o lote 14 lá também.

## Bloqueadas (aguardam decisão)

- CSP no site (GitHub Pages): escolher entre mover os scripts embutidos para arquivos (com o hash do
  `importmap` conferido no CI) ou não aplicar no site (ver “CSP no aplicativo desktop”).
- DAD-01 opção b (remapear vistas/conjuntos de outra versão por código/nome) e as abas de vista. As buscas salvas
  (lote 13) já servem de “conjunto” que vale em qualquer versão.
- ENG-02: apoio lateral (parede encostada) em movimento horizontal continua ignorado; mudar exige outra
  regra (por exemplo, detectar só penetração além da inicial).

## Resultados medidos

### Lote 1
- `npm test` (em `desktop/`): 23 testes, 23 passam.
- Portão conferido: com um teste falhando de propósito (numa cópia, fora do repositório), `npm test` sai com
  código 1; sem ele, código 0.
- YAML dos dois workflows lido sem erro; o passo **Testes** fica entre “Instalar dependências” e “Gerar o
  executável”.
- Workflow **Testes** executado no GitHub após o push do lote: sucesso (execução nº 1).
- O passo **Testes** do `desktop.yml` foi validado no Windows na execução manual nº 32 (ver “Lote 7”):
  `node --test "test/*.test.js"` (padrão expandido pelo próprio Node) aprovado no runner Windows.

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
- **Correção deste registro (feita na etapa ENG-02):** nas linhas “Rota” acima, o roteiro de teste
  escrevia um passo inexistente na lista “Subir/Descer” (0,25 / 0,5 / 1 m), e a subida ficou com 0 m: os
  avisos de “não verificado” vieram da verificação do apoio, na posição inicial. Repetido depois com uma
  subida real de 2 m: mesmos resultados (ver ENG-02).
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

### Lote 6
- Arraste real de arquivo (pelo protocolo de depuração do Chromium, `Input.dispatchDragEvent`) sobre o
  modelo aberto, versão nova: o evento chega à página (confiável), é cancelado, aparece a dica e a seleção
  continua. Com `modelo.json`, `modelo.zip` e uma pasta.
- **Limite do teste:** a ação padrão do navegador (abrir o arquivo solto no lugar da página) acontece fora
  da página e não é reproduzida por automação, então o “antes” não pôde ser filmado: a correção foi
  verificada pelo cancelamento do evento, que é o que impede essa ação.
- Zona do cartão de abertura, ZIP solto: antes e depois abrem o modelo e guardam a cópia no aparelho
  (“Modelo guardado neste aparelho…”).
- Abertura geral no desktop e no celular (emulado): sem erros no console. `npm test`: 35 passam. ESLint:
  nenhum aviso novo.

### DAD-01
Modelo de exemplo (versão A, 21 peças) e versão B com o **mesmo nome de arquivo** e uma placa nova no
começo (toda a numeração desloca). Na versão A: bomba isolada e selecionada, vista “V1” e conjunto “S1”
salvos, link `#vista=` gerado; depois o mesmo armazenamento na versão B.

| Cenário | Antes | Depois |
|---|---|---|
| A: aplicar V1 | só a BOMBA DE AGUA visível e selecionada | idêntico, sem pergunta |
| B: aplicar V1 | visíveis **ESCADA E-02 e TUBO 8 POL**, selecionado **EQUIPAMENTOS** (peças erradas, sem aviso) | pergunta; “Cancelar”: nada muda (22 peças visíveis); “OK”: aplica |
| B: conjunto S1 › Selecionar | seleciona **EQUIPAMENTOS** | pergunta; “Cancelar”: nada selecionado |
| B: abrir o link `#vista=` | “Vista do link aplicada.” (peças erradas) | pergunta; “Cancelar”: “Vista do link não aplicada: é de outra versão do modelo.” |
| A: V1 salva sem assinatura (como as atuais) | — | aplica normalmente, com a nota “salva antes da identificação da versão…” |

- `npm test`: 35 passam. ESLint: nenhum aviso novo. Abertura geral sem erros no console.

### ENG-02 b/e e ENG-03
Testes unitários (`desktop/test/geom.test.js`, 5 novos, incluindo o worker de cálculo rodando em Node):
malha fechada × aberta × oca; ponto dentro/fora/na cavidade; contenção nos dois sentidos; malha ausente
é erro; a malha em uso não é descartada. Precisão de `pointInside` contra a resposta exata: 20.000 pontos
aleatórios em cada um de cubo, peça oca e esfera facetada (48 × 48): **0 erros**.

No navegador, com dois modelos de teste: C (caixa fechada com uma peça dentro; tanque oco com uma peça na
cavidade; bloco maciço) e D (equipamento cercado por 1.000 cubinhos a 2 cm, uma viga longa de centro a
~20 m atravessando a subida, e o piso).

| Cenário | Antes | Depois |
|---|---|---|
| Interferência: caixa × peça dentro dela | 0 interferências | “Interferência (uma dentro da outra)” |
| Interferência: tanque oco × peça na cavidade | 0 | 0 (sem falso alarme) |
| Medir: caixa × peça dentro dela | “Folga 500,0 mm” | “Interferência: uma peça está dentro da outra” |
| Manequim dentro do bloco maciço | “Sem contato. Folga mínima 10 mm…” | “Encosta em 1 peça: BLOCO MACICO” |
| Rota: subir 3 m sob a viga, com ~375 peças por passo | “**Passa sem bater.** Folga mínima 20 mm” | “Bate … de 1,00 m a 2,00 m: VIGA LONGA” |
| Rota: descer 0,5 m através do piso (sem o aperto) | “Passa sem bater.” (piso = apoio ignorado) | “Bate … PISO” |
| Mesma subida, antes da correção do cache (LRU) | — | viga só a 1,00 m e “24 peças não verificadas”: a malha do equipamento era descartada no meio |

- Regressão: os cenários do lote 3 no modelo de exemplo (com e sem falhas simuladas; agora com subida
  real de 2 m) dão os mesmos resultados; muda só o texto do apoio (“ignorados enquanto ele não desce…”).
- `npm test`: 40 passam. ESLint sem avisos nos arquivos alterados.
- **Pendente:** medir num modelo real quantas peças são malhas fechadas (cobertura da contenção) e o
  tempo das verificações com o cache novo.

### SEG-01
Aplicativo desktop real no Linux (tela virtual, Playwright), Electron 33.2.1 × 44.11.3, mesmo código:
- Segurança (cenários do lote 5) e fluxos legítimos (modelo original pela linha de comando, `openFolder`,
  `conversionWrite` sem conversão, “Abrir outro modelo”): **resultados idênticos**.
- **Converter modelo** (diálogos respondidos automaticamente) e, com a pasta convertida aberta,
  **Exportar modelo** para o celular: os 14 arquivos gerados são **idênticos byte a byte** nas duas versões.
- Empacotado com o electron-builder 26: pacote Linux (`app.asar` com `main.js`, `preload.js`,
  `mobile-export.js`, `security.js`) abre o modelo; **`.exe` portátil do Windows gerado** aqui
  (`VisualizadorPVS-1.1.0.exe`, 110 MB) — não executado (sem Windows).
- `npm test`: 40 passam.
- **Pendente (você):** abrir o `.exe` gerado pelo CI no Windows, numa máquina com placa dedicada e numa
  com integrada (placa usada no painel Desempenho), abrir e converter um modelo real.

### CSP no aplicativo desktop
Electron 44, o mesmo roteiro com a política desligada (código anterior) e ligada:

| Verificação | Sem CSP | Com CSP |
|---|---|---|
| Script injetado na página | **rodou** | bloqueado (a única violação registrada) |
| Abrir modelo convertido e original (workers) | ok | ok |
| Medir folga entre as duas bombas | 1.200,0 mm | idêntico |
| Interferência (29 pares) | 11 interferências, 16 contatos | idêntico |
| Arestas + SSAO, rótulos (6), caminhada | ok | ok |
| Captura PNG | 536.875 bytes | idêntico |
| Vista 2D (SVG) | 7 caminhos | idêntico |
| Exportar glTF (diálogo respondido automaticamente) | 1.776 bytes | **idêntico byte a byte** |

- `eval` não pôde ser testado pela automação (o código injetado pelo protocolo de depuração não passa
  pela política); a ausência de `unsafe-eval` é conferida no teste unitário.
- `npm test`: 41 passam. ESLint sem avisos.

### Lote 7
- YAML lido sem erro: permissão global `contents: read`; job `build` (Windows) sem permissões próprias;
  job `release` com `contents: write`, `needs: build`, só em tags `v*`. (O verificador `actionlint` não
  pôde ser baixado neste ambiente.)
- Execução manual do workflow no branch de trabalho (nº 32, Electron 44, build só com leitura):
  dependências instaladas, **passo Testes aprovado no Windows** (pendência do lote 1 resolvida), `.exe`
  gerado com ícone e versão gravados (`signAndEditExecutable`, electron-builder 26) em 2 min 39 s e anexado
  como artefato **VisualizadorPVS-windows** (110 MB, válido até 15/02/2027); job `release` **pulado**,
  como esperado fora de uma tag.
- Varredura final de ESLint em todos os 80 arquivos JavaScript do projeto: só os 4 avisos que já existiam
  na auditoria (`goto.js`, `picker.js`, `viewer.js` ×2).
- **Pendente:** o job `release` só roda numa tag `v*`.

### Revisão geral (v1.7.0)
Chromium (Playwright, WebGL por software), versão anterior (`4c07595`) × nova, lado a lado. Modelos: o de
exemplo (`tools/navsample.py`, 21 peças), uma cópia dele com o bloco `00005.bin` cortado ao meio e um modelo
sintético de **40.000 peças** (45.715 itens, 23 blocos; uma em cada 7 peças com dois itens; propriedades Material,
Thickness, Unit weight e Description).

| Cenário | Antes | Depois |
|---|---|---|
| Geometria de todas as 21 peças do exemplo (hash de posições, triângulos e arestas) | 2060408813 | **idêntico** |
| Geometria de 300 peças espalhadas pelo modelo de 40 mil (lê os 23 blocos) | ~1.100 ms | ~830–950 ms, hash idêntico |
| Geometria de 1.500 peças vizinhas (mesmos blocos, como na interferência), 3 repetições | 947–1.271 ms | **6–14 ms**, hash idêntico |
| Bloco `00005.bin` cortado ao meio | para em “Carregando geometria 20/21”; 0 peças carregadas; sem Carregar/Exportar | “20 de 21 peças carregadas · 1 bloco(s) do modelo não lido(s) por erro…”; Carregar e Exportar visíveis |
| O mesmo, depois de consertar o arquivo e usar Carregar › Tudo | — | “Modelo carregado”, 21 de 21 |
| 24 atalhos de teclado no cartão de abertura (sem modelo) | 5 erros na página | nenhum |
| Assinatura do modelo (Minha estrutura, animações) | `instalacao_teste.pvs:21:53d1993a` | idêntica |
| Busca de texto: `bomba`, `lpr dt`, `/^LPR/` | 2 · 2 · 8 resultados | idênticos |
| Busca de texto `peca 12` / `lpr dt0001` no modelo de 40 mil (mediana de 7) | 7,2–7,5 ms / 2,0 ms | 7,9–9,9 ms / 2,0–2,4 ms (desenho da lista; mesma ordem de grandeza) |
| `Bigrama=DT` · `Description=*BOMBA*` (exemplo) | 0 · 0 (texto literal) | 2 · 2 (condição) |
| `Material=S355*\|S2* Thickness>=20` (40 mil) | 0 | **10.664** resultados em ~25 ms |
| Celular emulado (Pixel 7, `?mobile`): busca rápida `Bigrama=DT` | — | 2 resultados, sem erros |

- `npm test`: **47** passam (41 + 6 novos em `desktop/test/query.test.js`, inclusive 60 mil nós com
  condições em menos de 0,5 s). `tools/test_parsers.py`: 5 passam.
- ESLint (regras recomendadas, com `NDEFReader` como global do navegador) em todo o projeto: **nenhum aviso**.
- Abertura do exemplo e do modelo de 40 mil, desktop e celular emulado: sem erros no console.
- **Não testado aqui:** aplicativo desktop (Electron) — a mudança é só no visualizador, copiado sem alteração para
  o `.exe`; o `index.html` mudou fora dos scripts embutidos, então o hash da CSP não muda.

### Revisão geral, segunda parte (lotes 13 a 16)
Chromium (Playwright), versão da primeira parte (`e433f1b`) × nova, modelo de exemplo.

| Cenário | Antes | Depois |
|---|---|---|
| 9 imagens (`app.screenshot`): sombreado, arestas, linhas ocultas, só arestas, raio-X, sombreado plano + luz do céu, caixa de corte, vista explodida, fantasma | — | **idênticas byte a byte** |
| Clique no centro da tela (peça e ponto) | nó 2, (5,8218; 7,3663; 0,0198) | idêntico |
| Mapa de caminhada (`navSlices`, 16 fatias, hash) | 4031522605 | idêntico |
| Salvar busca `Bigrama=DT` (só peças) como “Sistema DT”, limpar, escolher na lista | — | campos refeitos, 2 resultados |
| Salvar com a busca vazia · excluir | — | aviso, nada salvo · lista vazia |
| Sair sem nada / com medição salva numa vista / link / arquivo / medições apagadas / vista aplicada | sai | sai |
| Sair com medição nova, marcação, manequim, ou medição feita depois de salvar a vista | sai (perdia o trabalho) | **o navegador pergunta** |

- O aviso foi conferido com navegação real (`location.href`); o fechamento pela automação (`page.close`) não mostra
  a pergunta do navegador, por isso não foi usado.
- `npm test`: **51** passam (47 + 4 em `desktop/test/sources.test.js`). `tools/test_parsers.py`: 5. ESLint: nenhum
  aviso. Celular emulado e modelo de 40 mil peças: sem erros; geometria de 1.500 peças em 9–16 ms.
