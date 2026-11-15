# bt3-activity-probe

Activity de diagnóstico do Discord (Experimento A): mede, dentro de uma Discord Activity, os recursos que um port web de jogo exigiria (WebGL 2, WebAssembly, controles, áudio, rede, memória, armazenamento).

Projeto independente. Não contém nem usa nenhum código, executável, dado ou recurso de Dragon Ball Z: Budokai Tenkaichi 3, e não tem relação com o bot da NBA do mesmo autor.

## Estado

F1 e F2a concluídas (conexão com o Discord, WebGL 2, WebAssembly, JSPI/Asyncify, IndexedDB). Fase atual **F2b**: teclado, controle, toque, tela cheia, áudio e arquivos (inclusive maior que 2 GiB). Planos: [`docs/f2-plano.md`](docs/f2-plano.md), [`docs/f2b-plano.md`](docs/f2b-plano.md). Roteiros: [`docs/f1-roteiro.md`](docs/f1-roteiro.md), [`docs/f2a-roteiro.md`](docs/f2a-roteiro.md), [`docs/f2b-roteiro.md`](docs/f2b-roteiro.md).

Publicação: GitHub Pages, automática a cada merge na `main` → https://enzo-rbt0.github.io/bt3-activity-probe/

## Rodar localmente (Node 22)

```bash
npm ci
npm test          # testes unitários (gera o validador do schema antes)
npm run build     # build em apps/probe/dist
npm run smoke     # abre a build num Chromium sem tela e confere o relatório
npm run dev       # servidor de desenvolvimento
```

`npm run smoke` precisa do Chromium do Playwright (`npx playwright install chromium`). Os módulos do Emscripten (`wasm/emcc`) só são compilados se `emcc` estiver instalado; sem ele, os testes EMCC aparecem como SKIP. A CI usa Emscripten 6.0.13 e exige esses testes (`REQUIRE_EMCC=1`).
