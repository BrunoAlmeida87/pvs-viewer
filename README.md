# Visualizador PVS (Creo View) — web

Abre modelos Creo View (`.pvs` + `.ol`) no navegador, sem o productview.exe.

**Online:** https://brunoalmeida87.github.io/pvs-viewer/

## Uso

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

Os modelos (`viewer/data/`) não vão para o repositório (`.gitignore`). O visualizador precisa de internet para
baixar Three.js e fflate de um CDN.

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
- **Vista explodida** por seção, subsistema, nível 3 ou peça.
- **Navegação**: gira em torno do ponto clicado, cubo de vistas, modo caminhada (primeira pessoa).

Mouse: esquerdo gira em torno do ponto sob o cursor, direito/meio desloca, roda dá zoom no cursor. Clique seleciona,
duplo clique enquadra a peça. Cubo de vistas: clique numa face, aresta ou canto.
Teclas: F enquadrar · Z zoom na seleção · I isolar · H ocultar · A mostrar tudo · G fantasma · L lista ·
E arestas · X raio-X · C corte · Esc limpar seleção.
Caminhada (botão **Caminhar**): W/S frente e trás, A/D lados, Q/E desce e sobe, arraste para olhar, Shift corre,
roda muda a velocidade, Esc sai.

Uma pasta convertida por uma versão anterior do `build.py` ainda abre, mas sem arestas e sem sombreado suave;
rode o `build.py` de novo para ter os dois.

Funcionalidades planejadas: [ROADMAP.md](ROADMAP.md).

## Como funciona

| Arquivo | Formato | Leitores |
|---|---|---|
| `.pvs` | `PV-PVS0301C` + membros gzip; tags de 16 bits (id 9 bits, tamanho, flags, filhos), varints LEB128, tabela de símbolos. Tag 0x20 componente, 0x21 instância (posição em double + matriz 3×3), 0x23 arquivo `.ol` + bbox, 0x26 miniatura; tag 3 propriedades (0x2a por componente, 0x2b nome + valor) | `tools/pvs.py`, `viewer/lib/pvs.js` |
| `.ol` | `DIV-OL07BL`, índice de seções gzip; registros `u32 tag / i32 tamanho`. Seção 0 materiais, seção 1 malhas (face 0x0D → vértices 0x16 com normais → malha 0x18 → strips 0x1A / triângulos 0x1B / fans 0x19), seção 2 arestas (aresta 0x12 → pontos 0x16 → polilinha 0x1C / pares 0x1D) | `tools/ol.py`, `viewer/lib/olworker.js` |

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
