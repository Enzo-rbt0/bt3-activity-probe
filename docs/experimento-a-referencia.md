# Experimento A — Activity de Diagnóstico: documento de referência para os agentes

Versão consolidada em 14/11/2026, depois de três rodadas de revisão (Claude e ChatGPT), com as emendas da seção 7 (preparação da F1). Substitui o relatório inicial de viabilidade onde houver conflito. Fase atual: **F1 autorizada pelo usuário; F2 em diante dependem de nova aprovação.**

## 1. Regras que nenhum agente pode quebrar

1. **Nada de Budokai Tenkaichi 3**: nenhum código, executável, dado, asset ou ISO do jogo. Nem para teste.
2. **Nada do bot da NBA**: não ler nem tocar no repositório, `.env`, `data/`, token ou processo do bot.
3. Os agentes só criam e alteram arquivos no **repositório novo da sonda**, em branches, por pull request.
4. Os agentes **não**: criam aplicações no Discord, criam recursos na Cloudflare, fazem deploy, fazem merge, mexem em configurações de produção, guardam segredos. Tudo isso é do usuário.
5. Testes pesados (memória, armazenamento, arquivo grande) só com consentimento na hora, um degrau por vez, com limpeza ao final.
6. Resultado fora do Discord, teste automatizado ou meta ainda não comprovada **não** é prova de compatibilidade.
7. Parâmetros da URL (os que o Discord põe no endereço) servem só para detectar o ambiente, **nunca** como prova de identidade ou autorização.
8. Cada fase termina com resultados para o usuário analisar. Não avançar sozinho para a fase seguinte.

## 2. O que já está confirmado no código do port web

Fork `stufno102/Tenkaichi3Decomp`, branch `web-port`, commit `81507cd` (12/10/2026), licença MIT. Apenas leitura; nada executado.

| # | Fato | Onde |
|---|---|---|
| C1 | Sem threads: dois builds, JSPI (Chrome/Edge) e Asyncify (Safari/iPhone) | `port/web/link.py` |
| C2 | WebGL 2 obrigatório | `port/web/link.py` |
| C3 | Memória: 640 MB iniciais, até 2048 MB; pilha 16 MB | `port/web/link.py` |
| C4 | Saves em IndexedDB (IDBFS) | `port/web/link.py`, `shell.html` |
| C5 | Online tenta WebRTC e só após 8 s cai para o relay por WebSocket | `port/web/net.js` linha 63 |
| C6 | Relay = Durable Object que repassa pacotes binários; identidade é um `cid` aleatório no navegador, sem autenticação; salas de 4 letras | `cloudflare/src/room.js`, `net.js` |
| C7 | Online do navegador é lockstep: rollback desligado fora de x86-64 | `port/src/gs/state.c` linhas 914–925; `net.c` linha 438 |
| C8 | Rollback nativo usa proteção de páginas (`mprotect`/`GetWriteWatch`) e salvamento de pilha (`getcontext`/`setjmp`), que não existem em WebAssembly | `state.c` |
| C9 | A ISO é lida em pedaços, direto do arquivo escolhido, sem cópia; ISO USA = 3.020.816.384 bytes (2,81 GiB) | `shell.html` linha 405 |
| C10 | Entrar/sair do online recarrega a página e perde o arquivo escolhido | `net.js` linhas 213 e 773 |
| C11 | `Web_FrameDone()` só pausa se passaram > 20 ms: não há ponto fixo por quadro | `port/web/target/yield_web.c` linhas 47–50 |
| C12 | O build contém código **e dados** do jogo e "must never be published" | `docs/web/README.md` |
| C13 | O port web não tem espectadores | leitura do fork |

## 3. Decisões (ADR)

| ID | Decisão | Status |
|---|---|---|
| ADR-01 | Projeto totalmente separado do bot da NBA (aplicação Discord, repositório, credenciais, conta Cloudflare). Isso separa a operação, mas **não** protege juridicamente a conta de desenvolvedor | Aceita |
| ADR-02 | Experimento A sem nada do BT3 | Aceita |
| ADR-03 | Sem `authorize`/`authenticate`, sem client secret, sem banco de dados. `ready()` não exige escopos | Aceita |
| ADR-04 | Backend = 1 Worker da Cloudflare (página + WebSocket) com 1 Durable Object (SQLite, exigido no plano gratuito); 1 URL Mapping `/` | Aceita **a partir da F3** (ver ADR-12) |
| ADR-05 | Ranking, matchmaking, torneios e espectadores adiados | Aceita |
| ADR-06 | Ordem: Experimento A (compatibilidade) → Experimento B (lockstep com jogo próprio) → rollback próprio como pesquisa → BT3 só com autorização jurídica | Aceita |
| ADR-07 | Testes nos aparelhos são manuais (usuário). A CI só compila, roda testes unitários e um teste fora do Discord | Aceita |
| ADR-08 | Testes pesados com consentimento por degrau e limpeza | Aceita |
| ADR-09 | Modo fora do Discord: a sonda roda os mesmos testes no navegador comum, sem o SDK, como base de comparação | Aceita |
| ADR-10 | Canais de rede com limites e **interruptor no servidor, desligado por padrão**, ligado só por ação administrativa do usuário (não por botão na Activity) | Aceita |
| ADR-11 | Relatórios ficam no aparelho por padrão; envio ao servidor só com autorização na hora, sem identificadores permanentes | Aceita |
| ADR-13 | F2 testa JSPI/Asyncify em dois níveis: CORE (WAT + binaryen, mecanismo do navegador) e EMCC (C mínimo + Emscripten 6.0.13, runtime real). O Emscripten só compila no GitHub Actions | Aceita (usuário e revisão, 15/11) |
| ADR-12 | F1 e F2 hospedadas no **GitHub Pages** (repositório público, sem custo). Publicação automática a **cada merge na `main`**: aprovar o merge = aprovar a publicação | Aceita (usuário, 14/11) |

## 4. Hipóteses ainda não validadas (não tratar como fato)

- A Activity abre e roda WebGL 2 nos apps de Android e iOS do Discord.
- O iframe do Discord libera controle (gamepad), tela cheia e áudio automático.
- O seletor de arquivo funciona no iframe e aceita arquivos > 2 GiB.
- O WebSocket pelo proxy aguenta 60 mensagens/s com latência estável.
- O WebSocket continua entregando com a Activity minimizada ou em janela pequena.
- JSPI existe no app do Discord no iPhone.
- iPhone: o relato do WebKit de ~300 MB para WebAssembly é de 2024 (iOS 17). **Não** é limite comprovado nos iPhones atuais: iOS = desconhecido.
- SharedArrayBuffer: a issue #194 (2024) disse que não é possível em Activities; tratar como indisponível até medir.
- Rollback via Asyncify: exigiria ponto de salvamento explícito depois da lógica de cada quadro e restaurar também o estado fora da memória (JavaScript, WebGL, áudio). Pesquisa, fora do Experimento A.

## 5. Plano do Experimento A (resumo)

**Arquitetura na F1–F2** (ADR-12)

```
Cliente Discord (iframe https://1571332639812493522.discordsays.com)
     │ URL Mapping  /  →  enzo-rbt0.github.io/bt3-activity-probe
     ▼
GitHub Pages (arquivos estáticos da build Vite, publicados pelo workflow pages.yml a cada merge na main)
```

**Arquitetura a partir da F3** (ADR-04, rede)

```
Cliente Discord (iframe https://<APP_ID>.discordsays.com)
     │ URL Mapping  /  →  <nome-do-worker>.<subdominio>.workers.dev
     ▼
Cloudflare Worker (um deploy)
  ├── página da sonda (Vite + TypeScript + @discord/embedded-app-sdk)
  ├── /ws/echo-edge   eco sem Durable Object (custo do proxy)
  ├── /ws/echo-do     eco via Durable Object
  └── /ws/relay       repassa entre 2 aparelhos da mesma instância
```

**Fases** (cada uma termina com relatórios para aprovação):

| Fase | Conteúdo |
|---|---|
| F0 | Usuário cria aplicação no Discord e repositório (Cloudflare só na F3) |
| F1 | Activity mínima: conexão com o Discord (`ready()`), contexto do ambiente, **WebGL 2**, modo fora do Discord, relatório JSON validado por schema, testes automáticos. Termina com a Activity funcionando no Discord Desktop e o 1º JSON válido |
| F2 | Essenciais: WebAssembly, JSPI vs Asyncify, controles, teclado, toque, áudio, seletor de arquivo (abrir e ler tamanho), layout/orientação |
| F3 | Rede (eco, relay, reconexão, segundo plano), desempenho gráfico, visibilidade |
| F4 | Pesados e opcionais: memória, armazenamento, arquivo grande |
| F5 | Consolidação e decisão sobre o Experimento B |

Aparelho que o usuário não tiver fica **pendente**, sem resultado inventado.

**Correções incorporadas**

- **Mensagens Cloudflare:** eco de 1 aparelho por 5 min a 60 msg/s = 18.000 mensagens; dois jogadores = 36.000. A regra "20 mensagens = 1 requisição" está documentada só para cobrança; não se sabe se vale para o limite diário gratuito (100.000/dia). Primeira sessão de rede com 2 min e conferência no painel; plano pago (US$ 5/mês) se a contagem for uma a uma.
- **Atraso de input:** `D = ⌈OWD_p99 / T_f⌉ + 1` é só estimativa. No relay, largada simultânea dada pelo servidor; cada aparelho registra, por quadro, a folga com que a jogada do outro chegou (relógio local). A taxa real de travamento só sai no Experimento B.
- **Memória:** página de WebAssembly (64 KiB) ≠ página do sistema operacional (geralmente 4–16 KiB). Escrever 1 byte a cada 64 KiB **não** garante uso físico de toda a área. Medir com escrita e leitura verificada de toda a região, em degraus graduais, separando "reservado" de "efetivamente usado". Teste combinado: 640 MB em uso com carga WebGL 2 por 60 s.
- **Segurança dos canais de rede:** eco 1 conexão por sala, relay 2; até 120 mensagens/s; até 64 bytes por mensagem; duração máx. 10 min; fecha após 60 s parado; **interruptor no servidor, desligado por padrão**.
- **Metas propostas (hipóteses, não limites):** D* ≤ 4 quadros de 16,7 ms; frame p95 ≤ 16,7 ms; leitura de 2 KiB p95 ≤ 16,7 ms.

**Relatório JSON** (um por execução, schema versionado `bt3probe.report/1`, em `packages/report-schema/schema/report.v1.json`): versão e hash da sonda, versão do SDK, plataforma, versão do app no mobile, user agent, aparelho e sistema (texto do usuário), rede, layout, resultado por teste (AP / RP / INV / SKIP / ERRO), consentimentos, limpeza, observações. Sem ID ou nome de usuário; servidor e canal só como sim/não; instância só como hash SHA-256 truncado em 12 caracteres.

**Repositório** `Enzo-rbt0/bt3-activity-probe`:

```
apps/probe/             página da sonda (Vite + TS)
wasm/                   módulos C próprios (JSPI, memória) — a partir da F2
workers/probe/          Worker + Durable Object — a partir da F3
packages/report-schema/ schema JSON + validador pré-compilado
scripts/                teste de fumaça (Chromium sem tela, fora do Discord)
docs/                   este documento e roteiros de teste
results/                relatórios aprovados (commit do usuário)
.github/workflows/      ci.yml (tipos, testes, build, fumaça) e pages.yml (publicação)
```

## 6. Responsabilidades

| Atividade | Agentes | Usuário |
|---|---|---|
| Código, testes, schema, documentação, CI | ✅ por PR | revisa e aprova |
| Aplicação Discord, URL Mapping, plataformas, servidor de teste | ❌ | ✅ |
| Conta Cloudflare (F3), deploy, interruptor dos canais de rede, painel de consumo | ❌ | ✅ |
| Testes nos aparelhos, consentimentos, guardar relatórios | ❌ | ✅ |
| Merge (= publicação no GitHub Pages) | ❌ | ✅ |
| Interpretar resultados | rascunho | decide |

## 7. Emendas da preparação da F1 (14/11/2026)

> F1 concluída em 15/11/2026 (PC, notebook e Android aprovados). F2 planejada em `f2-plano.md` (v2, aprovada); F2a em andamento.


- **Hospedagem:** GitHub Pages na F1–F2 (ADR-12). Cloudflare só entra na F3, para a rede (é grátis; talvez US$ 5/mês nos testes de rede).
- **URL Mapping configurado pelo usuário:** prefixo `/` → `enzo-rbt0.github.io/bt3-activity-probe`.
- **Aplicação Discord:** ID `1571332639812493522` (público; não é segredo). Nenhum segredo é usado na F1.
- **Proteção da `main`:** ruleset `proteger-main` ativo (bloqueia apagar a branch e force push; exige pull request).
- **Aparelhos disponíveis:** PC (Discord Desktop) e Android. **iOS: pendente** (sem aparelho).
- **CSP do Discord:** o validador do relatório é gerado como código comum (Ajv standalone), sem `eval`/`new Function`; o teste de fumaça falha se a build contiver isso.
