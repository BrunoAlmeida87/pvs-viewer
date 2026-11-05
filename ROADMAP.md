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

## Fase 3 — medição, vistas e anotações
- [ ] [M] Distância ponto a ponto, coordenadas, ângulo
- [ ] [F] Dimensões / caixa da seleção
- [ ] [D] Diâmetro e raio exatos (superfícies analíticas dos `.ol`)
- [ ] [M] Distância mínima / folga entre peças
- [ ] [M] Peso por seção/material (Unit weight × Length)
- [ ] [F] Vistas salvas (câmera, visibilidade, cores, cortes)
- [ ] [F] Compartilhar vista por link/arquivo
- [ ] [F] Captura de tela PNG em alta resolução
- [ ] [M] Anotações 3D (notas, setas)
- [ ] [D] Ler anotações do Creo (`ann*.ast`)

## Fase 4 — plataforma e desempenho
- [x] Abrir `.pvs` + `.ol` direto no navegador, sem conversão em Python
- [ ] [M] Carregamento por região e LOD
- [ ] [M] Comparação entre duas versões do modelo
- [ ] [D] Detecção de interferência / colisão
