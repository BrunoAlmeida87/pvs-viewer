# Visualizador PVS (Creo View) — web

Abre modelos Creo View (`.pvs` + `.ol`) no navegador, sem o productview.exe.

**Online:** https://brunoalmeida87.github.io/pvs-viewer/

## Uso

### Primeira versão para celular (Android)

A branch `codex/android-viewer` adapta o visualizador web para telas de toque. Para testar a branch no
Galaxy S25, abra o visualizador servido a partir dela no Chrome e escolha uma **pasta convertida** por
`tools/build.py`, copiada inteira para o armazenamento do
celular (incluindo `chunks.json`, `tree.json`, `items.bin`, `parts.bin` e a subpasta `c/`). O navegador lê os
arquivos localmente. Se o seletor de pasta do navegador não funcionar, use outro navegador Chromium atualizado;
o acesso a pastas no Android ainda precisa ser validado no aparelho.

Na abertura, escolha uma ou mais seções para limitar a memória. O botão **Carregar** acrescenta seções depois.
Um dedo gira e toca para selecionar; dois dedos aproximam, afastam e deslocam. A barra inferior oferece
enquadramento, acesso à árvore e vistas isométrica, frontal, lateral e superior. Em **Vistas**, há projeção
ortográfica, vistas salvas, isolamento da seleção e modo de arestas. Esta versão usa qualidade rápida e menos carregamentos simultâneos por
padrão; o tamanho máximo viável do modelo depende de teste no aparelho. Ainda não há APK nem instalação offline.

Para conferir a interface localmente, execute `python viewer/serve.py --host 0.0.0.0 --no-browser` na pasta `source` e abra no celular o
endereço IP do computador com a porta `8080` (por exemplo, `http://192.168.1.10:8080/`). Para usar o seletor
de pasta avançado (`showDirectoryPicker`), sirva por HTTPS; no endereço HTTP da rede local o navegador pode
oferecer apenas o seletor alternativo de arquivos.

### Direto no navegador (sem instalar nada)

Abra o link acima, clique em **Abrir pasta do modelo…** e escolha a pasta que contém o `.pvs` e os `.ol`
(por exemplo `Maquete SBR`). O navegador lê e converte o modelo na hora, usando vários núcleos
(o SBR, com 58 mil peças, leva cerca de 1 a 2 minutos).

Os arquivos são lidos no seu computador e **não são enviados para nenhum servidor**. No Chrome e no Edge o
navegador só pede permissão para ver a pasta; em outros navegadores aparece um aviso de “upload”, mas os
arquivos também não saem do computador.

### Com conversão prévia (abre em segundos)

```
python tools/build.py "X:\Arquivos\03 - Trabalho SBR\Maquete SBR\SBR.pvs" viewer/data
python viewer/serve.py
```

`serve.py` abre http://localhost:8080 com o modelo de `viewer/data`. A pasta convertida também pode ser escolhida
em **Abrir pasta do modelo…**. Para servir uma pasta original:
`python viewer/serve.py --model "X:\...\Maquete SBR"` e abrir `http://localhost:8080/?pvs=model/SBR.pvs`.
`?abrir` força o seletor de pasta.

No aplicativo desktop, a tela **Abrir modelo** também oferece **Converter modelo para abertura rápida…**.
Escolha a pasta original (`.pvs` + `.ol`) e depois a pasta onde salvar. O aplicativo cria uma nova pasta
`NOME-convertido` no destino, sem alterar os arquivos originais. Abra essa pasta no aplicativo para usar o
modelo convertido. A conversão acelera a abertura, mas mantém os mesmos triângulos: em placas com pouca
memória de vídeo, escolha as seções antes de carregar para reduzir o uso de GPU.

A aba **Minha estrutura** permite criar grupos próprios, adicionar as peças selecionadas na árvore original,
mover grupos para dentro de outros grupos e salvar ou importar a organização em JSON. A organização também
fica guardada localmente para o mesmo modelo. Nessa aba, **Exportar seleção em OBJ** grava as malhas das peças
selecionadas em coordenadas do modelo (metros). O OBJ contém triângulos, sem superfícies CAD editáveis.

Os modelos (`viewer/data/`) não vão para o repositório (`.gitignore`). Three.js e fflate ficam em
`viewer/vendor/`, então o visualizador funciona sem internet depois de aberto.

Para modelos grandes, marque **Escolher as seções antes de carregar** no cartão de abertura (ou use `?regioes`
na URL): só as seções escolhidas são lidas, e o botão **Carregar…** traz o resto depois.

### Versão desktop (Windows, recomendada para modelos grandes)

`desktop/` empacota o mesmo visualizador com Electron num executável portátil (`VisualizadorPVS-1.0.0.exe`,
~70 MB, não precisa instalar). Vantagens sobre o navegador: usa a **placa de vídeo dedicada** (NVIDIA/AMD) mesmo em
notebooks com placa integrada, tem mais memória disponível, abre a pasta do modelo sem pedidos de permissão e
funciona offline. Arrastar a pasta do modelo sobre o `.exe` (ou passá-la na linha de comando) abre direto.

**Pelo GitHub (automático):** o workflow [`desktop.yml`](.github/workflows/desktop.yml) gera o executável no
GitHub Actions a cada push no `main` que muda o visualizador, e quando você clica em **Run workflow** na aba
Actions. O `.exe` fica anexado à execução como artefato “VisualizadorPVS-windows”. Ao criar uma tag `v*`
(por exemplo `git tag v1.2.0 && git push origin v1.2.0`), ele também cria um **Release** com o `.exe`, na versão
da tag.

**Na sua máquina:**

```
cd desktop
npm install
npm run dist
```

O executável sai em `desktop/dist/`. `npm start` roda sem empacotar. Se o npm bloquear o script de instalação do
Electron, rode `npm install-scripts approve electron` e depois `node node_modules/electron/install.js`. O ícone
(`desktop/build/`) é gerado por `python desktop/scripts/make-icon.py`; o build local não grava o ícone no `.exe`
(isso exige o modo de desenvolvedor do Windows), o do GitHub grava.

## Desempenho

O que mais pesa é a placa de vídeo: o SBR tem 55,6 milhões de triângulos. Em notebooks com duas placas, o Windows
costuma pôr o navegador na integrada (Intel). No SBR, girando o modelo inteiro: **Intel UHD ≈ 4 quadros/s**,
**NVIDIA RTX 2060 ≈ 22 quadros/s** (35 na qualidade “rápida”). O painel **Exibição › Mostrar desempenho** (tecla P)
mostra qual placa está em uso e avisa quando é a integrada. Para o navegador usar a dedicada: Configurações do
Windows › Sistema › Tela › Elementos gráficos › escolher o Chrome/Edge › **Alto desempenho**, e reabrir o navegador.
A versão desktop já pede a dedicada sozinha.

Também ajudam: **Qualidade** (Exibição) automática ou rápida, que deixa de desenhar peças pequenas enquanto a câmera
se move; carregar só as seções necessárias; deixar SSAO e arestas desligados em máquinas fracas; e usar a pasta
convertida pelo `build.py`, que abre em segundos.

## Recursos

- **Árvore** da montagem com visibilidade por nó; **propriedades** e miniatura da peça selecionada.
- **Busca** por nome ou propriedade: contém, igual (com `*`), começa com, regex (`/.../`), números (`>`, `<`, `≥`, `≤`),
  várias condições com E/OU; ações em todos os resultados (selecionar, isolar, ocultar, colorir, zoom, listar).
- **Seleção**: clique, Ctrl+clique (soma/remove), Shift+arrastar (área), Alt+clique (sobe um nível); inverter,
  pai/filhos/irmãos, mesma cor, mesmo valor de uma propriedade.
- **Cores**: colorir e mudar a opacidade da seleção, modo fantasma, colorir por regra (material, espessura, seção,
  subsistema…) com legenda clicável, restaurar cores.
- **Conjuntos** de seleção e **esquemas de cores** com nome, salvos no navegador.
- **Lista de peças** com filtro, ordenação e exportação CSV; **estatísticas** por grupo (contagem e soma de Unit weight).
- **Exibição**: sombreado (suave ou plano), sombreado + arestas do CAD, linhas ocultas, só arestas, raio-X;
  oclusão ambiente (SSAO); fundo e iluminação configuráveis (ficam salvos no navegador).
- **Corte**: planos X/Y/Z com dois limites cada, caixa de corte (inclusive em volta da seleção), inverter,
  tampa hachurada nas peças cortadas.
- **Camadas** (tecla K): as camadas do Creo, lidas dos `.ol`, com quantas peças cada uma tem; ligar/desligar,
  selecionar as peças de uma camada. A **camada 99** (espaço que um equipamento pode ocupar, como o giro de uma
  porta) começa desligada; a escolha fica salva por modelo e entra nas vistas salvas. Medição, folga e
  interferência ignoram as camadas desligadas.
- **Vizinhança** (tecla N): mostra só as peças selecionadas e o que está em volta, numa esfera ou num cubo
  (medidas iguais ou por eixo) de tamanho ajustável, com centro na seleção ou num ponto clicado; peças inteiras
  (conferidas pela geometria real) ou recortadas exatamente na forma; vizinhas semitransparentes; “Sair” volta à
  visibilidade de antes.
- **Vista explodida** por seção, subsistema, nível 3 ou peça.
- **Navegação**: gira em torno do ponto clicado, cubo de vistas, modo caminhada (primeira pessoa).
- **Medir**: distância (com ΔX/ΔY/ΔZ), ângulo, coordenadas de um ponto, raio e diâmetro de arestas circulares,
  folga entre duas peças, dimensões e peso da seleção (Unit weight, que é a massa da peça em kg, mais volume ×
  densidade para as peças sem ele). Os pontos se ajustam a vértices e arestas.
- **Vistas**: vistas salvas (câmera, visibilidade, cores, estilo, corte, explosão, seleção, notas e medições),
  link e arquivo para compartilhar, PNG em alta resolução, notas 3D e as **figuras do Creo View** (`ann*.ast`) da
  pasta do modelo.
- **Análise**: comparação com outra versão do `.pvs` (alteradas, removidas, novas) e verificação de interferências e
  contatos entre a seleção e as peças visíveis.

Interface: barra única com ícones (rótulos somem em telas estreitas), tema claro/escuro (botão da lua), barra
lateral recolhível, painéis flutuantes arrastáveis (um por vez; duplo clique no título volta à posição inicial),
placa de vídeo em uso na barra de status e lista de atalhos no botão do teclado.

Mouse: esquerdo gira em torno do ponto sob o cursor, direito/meio desloca, roda dá zoom no cursor. Clique seleciona,
duplo clique enquadra a peça. Cubo de vistas: clique numa face, aresta ou canto.
Teclas: F enquadrar · Z zoom na seleção · I isolar · H ocultar · A mostrar tudo · G fantasma · L lista ·
E arestas · X raio-X · C corte · N vizinhança · K camadas · M medir · P desempenho · Esc limpar seleção.
Caminhada (botão **Caminhar**): W/S frente e trás, A/D lados, Q/E desce e sobe, arraste para olhar, Shift corre,
roda muda a velocidade, Esc sai.

Uma pasta convertida por uma versão anterior do `build.py` ainda abre, mas sem o que veio depois (arestas,
sombreado suave, LOD, camadas); rode o `build.py` de novo para ter tudo.

Funcionalidades planejadas: [ROADMAP.md](ROADMAP.md).

## Como funciona

| Arquivo | Formato | Leitores |
|---|---|---|
| `.pvs` | `PV-PVS0301C` + membros gzip; tags de 16 bits (id 9 bits, tamanho, flags, filhos), varints LEB128, tabela de símbolos. Tag 0x20 componente, 0x21 instância (posição em double + matriz 3×3), 0x23 arquivo `.ol` + bbox, 0x26 miniatura; tag 3 propriedades (0x2a por componente, 0x2b nome + valor) | `tools/pvs.py`, `viewer/lib/pvs.js` |
| `.ol` | `DIV-OL07BL`, índice de seções gzip; registros `u32 tag / i32 tamanho`. Seção 0 materiais, seção 1 malhas (face 0x0D → vértices 0x16 com normais → malha 0x18 → strips 0x1A / triângulos 0x1B / fans 0x19), seção 2 arestas (aresta 0x12 → pontos 0x16 → polilinha 0x1C / pares 0x1D). Camadas: na seção 0, tag 0x03 = {texto “Layer”, u32 n, n nomes}; cada face tem um filho 0x0A {0, u32 n, índices nesses nomes}. As arestas não têm camada: recebem a da face cujo vértice coincide com o seu primeiro ponto | `tools/ol.py`, `viewer/lib/ol.js` |
| `ann*.ast` | `!/EMK V7.0  !/`, nome da figura, lista de caminhos `/@@PV-AUTO-ID@@NNN/...` (NNN = número do filho na montagem), depois um membro gzip com a câmera e um registro por componente: `0x96` caminho, marcadores até `0xCA` (`0x9A` visível, `0x97` cor 3×f32, `0xAF` opacidade). Componentes fora da lista ficam ocultos | `viewer/lib/ast.js` |

O formato foi obtido por engenharia reversa de `libpvsparser_vs16.dll` e `libolparser_vs16.dll` (Creo View Express).
No SBR todas as instâncias têm transformação identidade, ou seja, a geometria dos `.ol` já está em coordenadas
globais; transformações não identidade ainda não são aplicadas.

A geometria é agrupada em blocos de até 65.535 vértices (posições quantizadas em uint16, vértices duplicados
fundidos, índice da peça em cada vértice) — em Python (`tools/build.py`) ou em Web Workers no navegador
(`viewer/lib/olworker.js`). Só as faces curvas guardam normal (int8); as faces planas usam o sombreado plano,
que é exato, e se fundem com os vizinhos, o que deixa a malha só ~6% maior. As arestas do CAD são pares de índices
nos mesmos vértices e só vão para a GPU quando um estilo com arestas é usado. O visualizador (Three.js/WebGL2)
calcula o sombreamento na GPU, seleciona por *GPU picking*, controla visibilidade, seleção e deslocamento
(vista explodida) por peça em texturas e corta no fragment shader; a tampa do corte é a face interna das peças
fechadas (os triângulos seguem as normais do CAD).

As peças são separadas em três classes de tamanho (pequenas, médias e grandes, em relação ao modelo), cada uma
nos seus próprios blocos; o tamanho da maior peça de cada bloco permite deixar de desenhar os blocos cujas peças
ficariam com poucos pixels na tela (LOD). Medição, folga e interferência leem de novo a geometria de cada peça
(dos `.ol` ou dos blocos convertidos) e calculam numa árvore de caixas (BVH) num Web Worker (`viewer/lib/geom.js`).
