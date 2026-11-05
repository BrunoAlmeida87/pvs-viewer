# Roadmap

Funcionalidades planejadas. Esforço: **[F]** fácil (horas) · **[M]** médio (1–2 dias) · **[D]** difícil (vários dias / incerto).

Dados disponíveis no modelo: propriedades por peça no PVS (Material, Section, Thickness, Length,
Unit weight, Description, libelle, part_objectid), arestas e superfícies analíticas (planos, cilindros) nos `.ol`,
miniatura `.jpg` por peça, anotações do Creo (`ann*.ast`).

## Fase 1 — base do dia a dia
- [ ] [F] Painel de propriedades da peça selecionada (+ miniatura `.jpg`)
- [ ] [F] Busca por texto, regex e palavra exata — no nome ou em qualquer propriedade
- [ ] [F] Busca por propriedade (`Material = S355*`, `Thickness > 10`, `Section contém TUBE`)
- [ ] [M] Filtros combinados E/OU
- [ ] [F] Ações sobre resultados (um ou todos): selecionar, isolar, ocultar, colorir, zoom
- [ ] [F] Seleção múltipla (Ctrl+clique, retângulo), inverter, selecionar pai/filhos/irmãos
- [ ] [F] Selecionar tudo com a mesma cor / material / valor de propriedade
- [ ] [F] Conjuntos de seleção com nome
- [ ] [F] Mudar cor e transparência de peça, grupo, nó da árvore ou resultados de busca
- [ ] [F] Modo fantasma (o que não está selecionado fica transparente)
- [ ] [M] Colorir por regra com legenda (material, espessura, seção, nível da árvore, qualquer propriedade)
- [ ] [F] Restaurar cores originais; salvar esquemas de cores
- [ ] [M] Lista de peças (BOM) com filtros/ordenação e exportação CSV/Excel
- [ ] [F] Estatísticas (peças por material/seção)

## Fase 2 — visualização e cortes
- [ ] [F] Sombreado suave (normais)
- [ ] [M] Arestas pretas, sombreado + arestas, wireframe
- [ ] [M] Linhas ocultas (hidden line), raio-X
- [ ] [M] Oclusão ambiente (SSAO), fundo e iluminação configuráveis
- [ ] [F] Centro de rotação no ponto clicado, ViewCube
- [ ] [M] Modo caminhada (primeira pessoa)
- [ ] [M] Vista explodida
- [ ] [F] Planos de corte X/Y/Z móveis
- [ ] [M] Caixa de corte (section box)
- [ ] [D] Corte com tampa (capping)

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
