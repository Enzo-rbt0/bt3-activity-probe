# bt3-activity-probe

Activity de diagnóstico do Discord (Experimento A): mede, dentro de uma Discord Activity, os recursos que um port web de jogo exigiria (WebGL 2, WebAssembly, controles, áudio, rede, memória, armazenamento).

Projeto independente. Não contém nem usa nenhum código, executável, dado ou recurso de Dragon Ball Z: Budokai Tenkaichi 3, e não tem relação com o bot da NBA do mesmo autor.

## Estado

Fase **F1**: Activity mínima com conexão ao Discord (`ready()`, sem login), coleta do ambiente, teste de WebGL 2, modo fora do Discord e relatório JSON validado por schema. Roteiro de teste: [`docs/f1-roteiro.md`](docs/f1-roteiro.md). Regras e decisões: [`docs/experimento-a-referencia.md`](docs/experimento-a-referencia.md).

Publicação: GitHub Pages, automática a cada merge na `main` → https://enzo-rbt0.github.io/bt3-activity-probe/

## Rodar localmente (Node 22)

```bash
npm ci
npm test          # testes unitários (gera o validador do schema antes)
npm run build     # build em apps/probe/dist
npm run smoke     # abre a build num Chromium sem tela e confere o relatório
npm run dev       # servidor de desenvolvimento
```

`npm run smoke` precisa do Chromium do Playwright (`npx playwright install chromium`).
