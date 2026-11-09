# Empacotador experimental de geometria em Rust

Este utilitário implementa **uma etapa** de `tools/build.py`: quantizar as posições e gravar
um bloco `c/NNNNN.bin` no formato que o visualizador já lê. Ele recebe a geometria já extraída;
não lê `.pvs` ou `.ol` e ainda não é chamado pelo aplicativo. Serve como base isolada para medir
o custo desta etapa antes de substituir a implementação Python ou migrar outros estágios.

Instale Rust pelo [rustup](https://rustup.rs/). Nesta pasta, execute `cargo test` e
`cargo build --release`. Depois:

```text
target/release/pvs-geometry-packer entrada.pvp1 saida.bin
```

No Windows, o executável termina em `.exe`. A saída padrão contém um JSON com `min`, `max` e
`bytes`. O arquivo de saída contém, nessa ordem, `nv` vértices `u16 x,y,z,item`, `nv` normais
`i8 x,y,z,w`, `ni` índices `u16` de triângulos e `ne` índices `u16` de arestas.

Protocolo de entrada `PVP1`, todos os números little-endian:

| Campo | Tamanho |
|---|---:|
| assinatura ASCII `PVP1` | 4 bytes |
| `nv`, `ni`, `ne` | 3 × `u32` |
| posições XYZ | `nv` × 3 × `f32` |
| normais XYZW | `nv` × 4 × `i8` |
| item local de cada vértice | `nv` × `u16` |
| índices de triângulos | `ni` × `u16` |
| índices de arestas | `ne` × `u16` |

`nv` deve estar entre 1 e 65.535, `ni` deve ser múltiplo de 3 e `ne` de 2. Os índices
referenciam vértices do próprio bloco. Para integrar, o `ChunkWriter.flush()` de `tools/build.py`
pode gerar este protocolo e usar o binário resultante no lugar da quantização atual. Compare os
arquivos de saída e os tempos com um modelo representativo antes de ativar a troca: uma chamada
ao processo por bloco também tem custo, e Rust só será vantajoso se o ganho superar esse custo.

