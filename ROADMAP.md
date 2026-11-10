# Roadmap

Funcionalidades planejadas. Esforço: **[F]** fácil (horas) · **[M]** médio (1–2 dias) · **[D]** difícil (vários dias / incerto).

Dados disponíveis no modelo: propriedades por peça no PVS (Material, Section, Thickness, Length,
Unit weight, Description, libelle, part_objectid), arestas e superfícies analíticas (planos, cilindros) nos `.ol`,
miniatura `.jpg` por peça, anotações do Creo (`ann*.ast`).

## Fase 1 — base do dia a dia ✅
- [x] Painel de propriedades da peça selecionada (+ miniatura `.jpg`, quando o modelo é aberto direto da pasta original)
- [x] Busca por texto, regex e palavra exata — no nome ou em qualquer propriedade
- [x] Busca por propriedade (`Material = S355*`, `Thickness > 10`, `Section contém TUBE`)
- [x] Filtros combinados E/OU
- [x] Ações sobre resultados (um ou todos): selecionar, isolar, ocultar, colorir, zoom, listar
- [x] Seleção múltipla (Ctrl+clique, Shift+arrastar), inverter, selecionar pai/filhos/irmãos
- [x] Selecionar tudo com a mesma cor / mesmo valor de propriedade
- [x] Conjuntos de seleção com nome
- [x] Mudar cor e transparência de peça, grupo, nó da árvore ou resultados de busca
- [x] Modo fantasma (o que não está selecionado fica transparente)
- [x] Colorir por regra com legenda (material, espessura, seção, subsistema, qualquer propriedade, cor por peça)
- [x] Restaurar cores originais; salvar esquemas de cores (cores, transparência, visibilidade, regra)
- [x] Lista de peças com filtro/ordenação e exportação CSV (abre no Excel)
- [x] Estatísticas (peças e soma de Unit weight por material/seção/subsistema/propriedade)

## Fase 2 — visualização e cortes ✅
- [x] Sombreado suave (normais do CAD nas faces curvas)
- [x] Arestas do CAD (seção 2 dos `.ol`), sombreado + arestas, só arestas (wireframe)
- [x] Linhas ocultas (hidden line), raio-X
- [x] Oclusão ambiente (SSAO), fundo e iluminação configuráveis
- [x] Centro de rotação no ponto clicado, cubo de vistas (faces, arestas e cantos)
- [x] Modo caminhada (primeira pessoa)
- [x] Vista explodida (por seção, subsistema, nível 3 ou peça; opcionalmente só a seleção)
- [x] Planos de corte X/Y/Z móveis
- [x] Caixa de corte (section box), inclusive em volta da seleção
- [x] Corte com tampa (capping) hachurada

## Fase 3 — medição, vistas e anotações ✅
- [x] Distância ponto a ponto (com ΔX/ΔY/ΔZ), coordenadas, ângulo; ajuste a vértices e arestas
- [x] Dimensões / caixa da seleção
- [x] Diâmetro e raio pelas arestas circulares do CAD (ajuste de círculo nos pontos da aresta)
- [x] Distância mínima / folga entre peças (ou entre 2 itens selecionados)
- [x] Peso da seleção: Unit weight (massa da peça em kg) + volume da malha × densidade para as peças sem ele
  (o modelo não tem a propriedade Length)
- [x] Vistas salvas (câmera, visibilidade, cores, estilo, cortes, explosão, seleção, notas, medições)
- [x] Compartilhar vista por link ou arquivo
- [x] Captura de tela PNG em alta resolução (com medições e notas)
- [x] Notas 3D presas a pontos do modelo
- [x] Figuras do Creo View (`ann*.ast`, formato “EMK V7.0”): visibilidade, cor e transparência por componente

## Fase 4 — plataforma e desempenho ✅
- [x] Abrir `.pvs` + `.ol` direto no navegador, sem conversão em Python
- [x] Carregamento por região (seções / subsistemas) e “Carregar…” para o resto
- [x] LOD: peças pequenas e médias em blocos próprios, que deixam de ser desenhados quando ficam pequenos na tela
- [x] Comparação entre duas versões do modelo (por part_objectid e caixa delimitadora)
- [x] Detecção de interferência e contato (seleção × visíveis ou dentro da seleção)
- [x] Painel de desempenho (placa de vídeo usada, quadros/s, triângulos, memória) e qualidade em movimento
- [x] Versão desktop (Electron) com placa de vídeo dedicada, sem CDN, executável portátil

## Depois da Fase 4 ✅
- [x] Vizinhança: só a seleção e o que está em volta, numa esfera ou cubo ajustável (peças inteiras ou recorte)
- [x] Camadas do Creo (lidas dos `.ol`), com a camada 99 (volumes de movimento) desligada por padrão
- [x] Novo layout: barra com ícones, tema claro/escuro, barra lateral recolhível, painéis arrastáveis
- [x] GitHub Actions gerando o executável (artefato a cada push, Release a cada tag `v*`), ícone do aplicativo
- [x] Bigramas (sistema do código `LPR-XX…`) como propriedade, painel de filtro e filtro na Busca
- [x] Animação de montagem: etapas que deslizam/surgem até o lugar, peças fixas, câmeras por etapa, geração de
  etapas seguindo o circuito, gravação em vídeo `.webm`
- [x] Estrutura reorganizada exportada em `.pvs` (validado no Creo View Express) e em pasta convertida
- [x] Abas de vista (cada uma com seus itens e câmera) e menu do botão direito na árvore, na Busca e no 3D

## Navegação, celular e desempenho ✅
- [x] Celular: modelo em tela cheia, barra de ícones, cartão da peça selecionada, ferramentas em folhas recolhíveis,
  todas as ferramentas do PC disponíveis; tablet com a interface do PC
- [x] Toque: dois toques enquadram, segurar abre o menu da peça, medição com mira e lupa
- [x] Caminhada: posicionar no modelo, altura fixa sobre o piso, colisão, controles de toque
- [x] Transições suaves, navegação pelo teclado, vista anterior / seguinte
- [x] Barra do PC sempre em uma linha (menu “Mais”), realce e nome da peça sob o cursor, desfazer / refazer
- [x] Desenho de frente para trás, clique que desenha só a região do cursor, qualidade automática adaptativa,
  resolução plena com a câmera parada no celular
- [x] Abrir o ZIP exportado sem extrair, modelos recentes, link direto para uma peça (`?peca=`)
- [x] Instalável e offline (service worker + manifest)

## A fazer
- [ ] Transformações de instância (posição + matriz 3×3 do PVS): o visualizador avisa quando o modelo as usa, mas
  não as aplica. Falta um modelo de exemplo para confirmar a convenção da matriz antes de implementar.

Limitações conhecidas: a colisão e o piso da caminhada são medidos no que está desenhado (peças ocultas ou cortadas
não contam; grades vazadas contam como piso só onde há malha); a interferência é calculada na malha facetada, então peças encostadas com o mesmo
diâmetro (tubo dentro de abraçadeira) podem aparecer como interferência; raio e folga na pasta convertida têm
precisão de ~0,05 mm (posições quantizadas), exatos ao abrir a pasta original; a câmera das figuras do Creo
ainda não é lida (a vista é enquadrada nos componentes visíveis).
