# Visualizador PVS (Creo View) — web

Abre modelos Creo View (`.pvs` + `.ol`) no navegador, sem o productview.exe.

## Uso

1. Converter o modelo (uma vez, ~2 min para o SBR):

   ```
   python tools/build.py "X:\Arquivos\03 - Trabalho SBR\Maquete SBR\SBR.pvs" viewer/data
   ```

2. Abrir o visualizador:

   ```
   python viewer/serve.py
   ```

   Abre http://localhost:8080 (precisa de internet para baixar o Three.js do CDN).

   Sem servidor: abra a versão publicada no GitHub Pages e clique em **Abrir pasta do modelo…**, escolhendo a
   pasta gerada no passo 1. Os arquivos são lidos no navegador e não são enviados para nenhum servidor.
   Para forçar esse modo no servidor local, use `http://localhost:8080/?abrir`.

Os modelos convertidos (`viewer/data/`) não vão para o repositório (`.gitignore`).

Mouse: esquerdo gira, direito/meio desloca, roda dá zoom no cursor. Clique seleciona, duplo clique enquadra a peça.
Teclas: F enquadrar · Z zoom na seleção · I isolar · H ocultar · A mostrar tudo · Esc limpar seleção.

## Como funciona

| Arquivo | Formato | Leitor |
|---|---|---|
| `.pvs` | `PV-PVS0301C` + membros gzip; tags de 16 bits (id 9 bits, tamanho, flags, filhos), varints LEB128, tabela de símbolos. Tag 0x20 componente, 0x21 instância (posição em double + matriz 3×3), 0x23 arquivo `.ol` + bbox | `tools/pvs.py` |
| `.ol` | `DIV-OL07BL`, índice de seções gzip; registros `u32 tag / i32 tamanho`. Seção 0 materiais, seção 1 malhas (face 0x0D → vértices 0x16 → malha 0x18 → strips 0x1A / triângulos 0x1B / fans 0x19), seção 2 arestas | `tools/ol.py` |

O formato foi obtido por engenharia reversa de `libpvsparser_vs16.dll` e `libolparser_vs16.dll` (Creo View Express).
No SBR todas as instâncias têm transformação identidade, ou seja, a geometria dos `.ol` já está em coordenadas globais.

`tools/build.py` junta a geometria em blocos de até 65.535 vértices (posições quantizadas em uint16, vértices
duplicados fundidos, índice da peça em cada vértice). O visualizador (`viewer/`, Three.js/WebGL2) calcula o
sombreamento na GPU, seleciona por *GPU picking* e controla visibilidade e seleção por peça numa textura.
