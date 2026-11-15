# Experimento A — Plano da F2, versão 2 (com os ajustes da revisão do ChatGPT)

Versão 2, de 15/11/2026. **É só uma proposta: nenhum código da F2 foi escrito.** A implementação da F2a começa quando o usuário der "pode". A versão 1 foi revisada pelo ChatGPT com o parecer "Aprovado com ajustes" (4 ajustes obrigatórios), e todos os 4 foram incorporados aqui.

Base: a F1 está concluída (ver `f1-resultados.md`). O WebGL 2 e a conexão com o Discord foram aprovados no PC e no Android.

**Regra que guia toda a F2:** nenhum teste aprova uma capacidade maior do que a que ele realmente verificou. Por exemplo:
- WebAssembly mínimo funcionando não significa "BT3 compatível";
- IndexedDB funcionando não significa "save persistente";
- áudio liberado não significa "áudio audível";
- arquivo pequeno lido não significa "ISO de 2,81 GiB lida".

## 1. Objetivo

Descobrir se os recursos **essenciais** de um port web de jogo funcionam **dentro do Discord** nestes ambientes:
- **PC** (Discord Desktop);
- **Android** (app Discord);
- **Discord Web** (o Discord aberto no navegador), novo nesta versão.

Ficam **fora** da F2:
- rede, desempenho e execução prolongada (F3);
- testes pesados (F4);
- qualquer coisa do BT3.

## 2. F2a — testes automáticos e armazenamento (primeira PR)

| ID | O que mede | AP / INV / RP |
|---|---|---|
| **A-WASM-EMBED** | Compila e roda um módulo WebAssembly embutido na página. Mostra se a política de segurança (CSP) permite compilar WebAssembly | AP: compila e calcula certo · RP: bloqueado |
| **A-WASM-URL** | Baixa um `.wasm` separado pela URL da Activity (passando pelo proxy do Discord) com `instantiateStreaming()`. Registra o tipo do arquivo recebido (`application/wasm`) e se foi preciso usar o caminho alternativo, sem streaming | AP: streaming funciona · INV: só funciona sem streaming · RP: não carrega |
| **A-CSP** | Registra todo bloqueio de CSP que acontecer durante a sonda (evento `securitypolicyviolation`): a diretiva, se o bloqueio foi aplicado ou só relatado, e a categoria do recurso. **Sem guardar URLs** | Só registra (lista) |
| **A-WASM-FEAT** | Recursos extras do WebAssembly, cada um testado com um módulo minúsculo próprio passado em `WebAssembly.validate()`: SIMD, bulk memory, exceções, multi-value e tail call. Também registra se `SharedArrayBuffer` e `crossOriginIsolated` existem | Só registra (lista) |
| **A-JSPI-CORE** | Um módulo escrito à mão pausa esperando uma Promise do JavaScript e retoma com o valor certo | AP: pausa e retoma certo · RP: a API não existe · INV: existe, mas falhou |
| **A-ASYNCIFY-CORE** | O mesmo teste, com um módulo transformado por Asyncify (`binaryen`) | AP / RP |
| **A-JSPI-EMCC** *(novo)* | Um programa C de poucas linhas, compilado com **Emscripten `-sJSPI`**, chama JavaScript assíncrono via `EM_ASYNC_JS`. O teste roda o runtime gerado pelo Emscripten de ponta a ponta | AP / INV / RP |
| **A-ASYNCIFY-EMCC** *(novo)* | O mesmo programa C, compilado com **`-sASYNCIFY`** | AP / RP |
| **A-IDB** | Grava 1 KB, lê, confere e apaga. Registra `storage.estimate()` e `storage.persisted()` | `READ_WRITE_OK` (AP) / RP |
| **A-IDB-PERSIST** *(novo)* | O usuário aperta "Gravar marcador", fecha e reabre a Activity. Na abertura seguinte, a sonda encontra o marcador, mostra há quanto tempo foi gravado e o **apaga**. Há também um botão "Apagar marcador", caso o usuário não volte | `PERSISTENCE_OK` (AP): marcador encontrado · RP: sumiu · SKIP: o usuário não reabriu |
| **A-LAYOUT** | Orientação, área visível, áreas seguras (notch) e mudanças ao girar | Só registra os valores |
| **A-VIS** *(novo, leve)* | Conta os eventos de visibilidade (`visibilitychange`, `pagehide`) durante a sessão. Só instrumenta; o impacto disso fica para a F3 | Só registra |
| **Benchmark WASM × JS** | Conta de ~50 ms nos dois | **Só informativo, nunca critério** |
| **Dica no A-GL2** | Quando o WebGL 2 rodar sem placa de vídeo: "No Discord: Configurações → Avançado → Aceleração de hardware" | — |

## 3. F2b — testes interativos (segunda PR, só depois dos resultados da F2a)

| ID | O que o usuário faz | Critério |
|---|---|---|
| **A-KEY** | Aperta W, A, S, D, Espaço, Enter e Esc, sozinhas e várias juntas | AP: todas chegam · INV: algumas são engolidas pelo Discord (com a lista) |
| **A-PAD** | Usa o controle (o usuário tem um), no PC e no Android | AP: botões e eixos lidos · RP: API bloqueada |
| **A-TOUCH** | Toca com 1, 2 e 3 dedos e arrasta | AP: 2 ou mais toques sem o Discord roubar o gesto |
| **A-FS** | Pede tela cheia e sai | AP / RP. **Um RP aqui é limitação documentada, não bloqueio do projeto**, porque o Discord tem modos de exibição próprios |
| **A-AUDIO** | Toca um bipe e confirma se ouviu | Áudio suspenso antes do clique é o comportamento esperado (autoplay), não reprovação. AP: retomou após o clique **e** o usuário ouviu. O relatório marca se havia chamada de voz ativa |
| **A-FILE-BASIC** | Escolhe um arquivo comum | AP: o seletor abre e lê 3 pedaços de 2 KiB com o tamanho certo |
| **A-FILE-LARGE** | Escolhe o **arquivo sintético de teste** (seção 4) | AP **só se**: o tamanho passa de 2 GiB **e** os marcadores no início, **depois de 2³¹ bytes** e no fim forem lidos com o conteúdo esperado. Arquivo grande comum, sem marcadores = INV. Não testado = SKIP (pendente), **nunca AP por causa do teste básico** |

## 4. Arquivo sintético para o A-FILE-LARGE

Um arquivo só de zeros não serve: ler zeros em qualquer lugar não prova que a leitura caiu na posição certa. Por isso o arquivo terá **marcadores** de texto em posições conhecidas, por exemplo `BT3PROBE-MARK:2148532224`, no início, logo depois de 2 GiB e no fim. A sonda confere se cada marcador lido corresponde à posição pedida.

- O repositório terá um script **PowerShell, que não exige administrador**, para criar o arquivo de ~3 GiB. O arquivo é criado instantaneamente, quase sem escrita no disco, e é apagado depois do teste.
- **No Android**, o mesmo arquivo pode ser copiado do PC por cabo. Se for trabalhoso, o A-FILE-LARGE fica **pendente no Android**, registrado assim.
- A sonda lê só 3 pedaços de 2 KiB. A leitura do arquivo inteiro fica para a F4.
- O relatório guarda só o tamanho, os tempos e se os marcadores conferem. **Nunca guarda o nome do arquivo.**

## 5. Decisões técnicas

| Decisão | Por quê |
|---|---|
| Dois níveis de teste: **CORE** (WAT + binaryen) e **EMCC** (C mínimo + Emscripten) | O CORE isola o mecanismo do navegador. O EMCC testa o runtime gerado pelo Emscripten, que é o que o port usa |
| **O Emscripten só compila no GitHub Actions**, numa versão fixa | Não dá para instalar o Emscripten no ambiente do Claude: o download do toolchain é bloqueado. A CI compila, testa e publica. Consequência: os ajustes nos testes EMCC são verificados pela CI, e cada rodada leva alguns minutos |
| `.wasm` embutido **e** por URL | Separa "a CSP permite WebAssembly" de "o proxy e o tipo do arquivo permitem carregar WebAssembly", que é o caminho real do jogo |
| A CSP restrita é simulada no teste de fumaça, mas a CSP real é medida dentro do Discord (A-CSP) | A simulação só prova que a sonda não trava. A verdade é a CSP do Discord |
| Schema `bt3probe.report/2`, mantendo o formato 1 válido | Os relatórios da F1 continuam verificáveis |

## 6. O que o usuário vai testar

| Ambiente | F2a | F2b |
|---|---|---|
| PC — Discord Desktop | Todos os testes, incluindo fechar e reabrir para o A-IDB-PERSIST | Todos, com o controle e o arquivo sintético |
| Android — app Discord | Todos | Todos, com o controle por Bluetooth. O arquivo sintético é opcional (se ficar de fora, fica pendente) |
| Discord Web (navegador) | Testes básicos. Pode ser preciso habilitar a plataforma Web no Developer Portal | Básicos |
| Navegador comum, fora do Discord | Base de comparação | Base de comparação |
| iOS | Pendente | Pendente |

## 7. Critério de conclusão

- **F2a concluída** quando houver relatórios válidos do PC, do Android e do Discord Web, com cada teste em AP, RP, INV ou SKIP justificado. Um RP é resultado, não falha.
- **A F2b só começa depois** que os resultados da F2a forem registrados e analisados.

## 8. Recomendações da revisão que ficam fora da F2

- **Wake Lock** (tela apagando no celular): F3, junto com execução prolongada.
- **Pointer Lock:** baixa prioridade, porque o jogo é de controle, não de mouse.
- **Vibração:** opcional, não é requisito de viabilidade.

## 9. Regras que continuam valendo

- Nada do BT3, nem como arquivo de teste.
- Nada do bot da NBA.
- Nada de segredos.
- Os parâmetros da URL nunca contam como identidade.
- Nada pesado sem consentimento por degrau.
- Merge = publicação, só com o "pode" do usuário.
- **A F3 não começa sem nova aprovação.**
