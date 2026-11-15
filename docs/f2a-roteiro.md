# Roteiro de teste da F2a

Objetivo: descobrir se **WebAssembly, JSPI/Asyncify (navegador e Emscripten), CSP, IndexedDB e o save entre sessões** funcionam dentro do Discord. Nada pesado: são módulos de teste de poucas linhas, 1 KB gravado e apagado e um marcador de ~100 bytes.

Plano completo: [`f2-plano.md`](f2-plano.md) (versão 2, aprovada).

## 0. Antes

1. O PR da F2a foi aprovado e o merge feito. **O merge publica** no GitHub Pages.
2. Em **GitHub → Actions**, o workflow "Publicar no GitHub Pages" terminou verde.
3. **Discord Web** (novo nesta fase): no Developer Portal, em **Activities → Settings**, confira se a plataforma **Web** está marcada além de Desktop e Android. Os nomes das telas podem variar um pouco.

## 1. Em cada ambiente (PC – Discord Desktop, Android – app Discord, Discord Web no navegador)

1. Abra a Activity pelo ícone de **Activities** (foguete) no canal de voz.
2. Espere todos os testes aparecerem na tabela (menos de 5 s).
3. Preencha Aparelho, Sistema, Rede e "Em chamada de voz?".
4. **Save entre sessões:**
   1. aperte **Gravar marcador**;
   2. **Baixe ou copie o JSON** (relatório 1);
   3. feche a Activity e abra de novo **no mesmo ambiente**;
   4. veja o resultado em "Save entre sessões" e **baixe ou copie o JSON de novo** (relatório 2).
5. Se o marcador **não** aparecer na reabertura, aperte **"Gravei antes e ele sumiu"** antes de baixar o relatório 2.

Cada ambiente gera 2 relatórios. **Não** é falha se o marcador gravado no Discord não aparecer quando você abre a página fora do Discord: cada ambiente guarda seus dados separado.

## 2. Base de comparação (opcional)

Abra https://enzo-rbt0.github.io/bt3-activity-probe/ no Chrome do PC e do celular e baixe um JSON de cada. Isso não prova nada sobre o Discord; serve para comparar.

## 3. Como ler

| Teste | AP | INV | RP |
|---|---|---|---|
| A-WASM-EMBED | A CSP deixa compilar WebAssembly | — | Bloqueado: **o achado mais importante possível** |
| A-WASM-URL | `.wasm` baixado pelo proxy e compilado em streaming | Só sem streaming (tipo do arquivo ou proxy) | Não carrega |
| A-CSP | Nenhum bloqueio | Houve bloqueios (ver lista; sem URLs) | — |
| A-JSPI-CORE / A-ASYNCIFY-CORE | O navegador pausa e retoma | (JSPI) API existe, mas falhou | Não funciona / API ausente |
| A-JSPI-EMCC / A-ASYNCIFY-EMCC | O runtime do **Emscripten** pausa e retoma | (JSPI) falhou ao carregar | Não funciona |
| A-IDB | Grava, lê e apaga (READ_WRITE_OK) | — | Bloqueado |
| A-IDB-PERSIST | Marcador sobreviveu a fechar e reabrir (PERSISTENCE_OK) | — | Sumiu |

**O que um AP aqui NÃO prova:** que o BT3 roda. Prova só que aquele mecanismo, com um programa minúsculo, funciona naquele ambiente.

## 4. O que mandar de volta

Os JSONs (2 por ambiente) e um print da tabela de cada ambiente.

## 5. Depois

A F2a termina com a análise desses relatórios. **A F2b (teclado, controle, toque, áudio, tela cheia, arquivos) só começa com nova aprovação.**
