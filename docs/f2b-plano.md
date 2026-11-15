# Experimento A — Plano da F2b (proposta para revisão)

Versão 2, de 15/11/2026, com os ajustes da revisão do ChatGPT ("Aprovado com ajustes pontuais"). **A F2b-0 já está implementada (PR #3). Nenhum código da F2b foi escrito.** A F2b começa quando o usuário der "pode", depois do merge da F2b-0.

Base: a F2a está concluída (ver `f2a-resultados.md`). WebAssembly, CSP, JSPI e Asyncify (navegador e Emscripten), IndexedDB e o save depois de fechar e reabrir deram AP no Discord Desktop, no Discord Web e no Android.

**A regra continua:** nenhum teste aprova uma capacidade maior do que a que verificou. Exemplos:
- uma tecla recebida não prova que o jogo é controlável;
- áudio liberado não prova que dá para ouvir;
- um arquivo pequeno lido não prova que a ISO de 2,81 GiB será lida.

## 1. Objetivo

Descobrir se a **interação** que um jogo exige funciona dentro do Discord, no PC (Desktop), no Discord Web e no Android:
- teclado, controle e toque;
- tela cheia;
- áudio;
- seletor de arquivo, inclusive arquivo **maior que 2 GiB**.

**Fora da F2b:**
- desempenho, rede, segundo plano e a janela minimizada de 174×174 vista no Android (F3);
- memória e leitura do arquivo inteiro (F4);
- qualquer coisa do BT3.

## 2. Parte 0: duas correções vindas da F2a

| # | De | Para | Por quê |
|---|---|---|---|
| C1 | A-GL2 dá **AP** quando o renderizador é só "Brave" (o navegador esconde o nome da placa) | Nomes genéricos ou mascarados ("Brave", "WebKit WebGL", "Mozilla" etc.) contam como **nome escondido → INV** | Não aprovar mais do que verificou |
| C2 | Depois que o marcador é confirmado e apagado, uma nova abertura aceita "Gravei antes e ele sumiu" e marca RP | Guarda um **recibo** da última confirmação (só a data e a hora). Se houver recibo mais novo que o último marcador, avisa: "o marcador já foi confirmado há X; grave um novo antes de testar de novo". Novo campo `last_confirmed_age_s` | Evita o falso RP do relatório 6 da F2a |

**Proposta:** C1 e C2 num **PR pequeno e separado** (F2b-0), antes da F2b. É rápido de revisar e não mistura correção com recurso novo.

## 3. Testes interativos

Cada teste é um cartão, um por vez, com o botão **Pular** (vira SKIP com o motivo "pulado pelo usuário"). Os testes automáticos da F2a continuam rodando no topo.

| ID | O que o usuário faz | O que a sonda registra | AP / INV / RP |
|---|---|---|---|
| **A-KEY** | Toca em "Começar" (para dar foco) e aperta W, A, S, D, setas, Espaço, Enter e Esc, uma de cada vez. Depois segura **W + D + Espaço juntas** | Quais teclas chegaram (pelo `code` físico); o máximo de teclas seguradas ao mesmo tempo; se o foco saiu durante o teste | **AP:** todas chegaram e 3 teclas juntas funcionaram · **INV:** alguma não chegou (lista quais; o Discord pode capturar a Esc) · **RP:** nenhuma chegou |
| **A-PAD** | Liga o controle **antes** de abrir a Activity, aperta alguns botões e mexe os dois analógicos | Se a API de Gamepad existe ou está **bloqueada pela política do iframe**; quantos botões e eixos; mapeamento (`standard` ou não); botões e eixos que mudaram. **O nome do controle não é guardado**, só o tipo genérico (Xbox / PlayStation / outro) | **AP:** botão e analógico lidos · **INV:** a API existe, mas nenhum controle apareceu · **RP:** a API está bloqueada ou não existe |
| **A-TOUCH** | Só em tela de toque: toca com 1, 2 e 3 dedos numa área de teste e arrasta | Máximo de toques simultâneos; se houve `pointercancel` (o Discord "roubou" o gesto); se o arrasto chegou inteiro | **AP:** 2 ou mais toques e arrasto sem cancelamento · **INV:** só 1 toque, ou cancelamento · **SKIP:** sem tela de toque |
| **A-FS** | Aperta "Tela cheia" e depois "Sair" | `fullscreenEnabled`; se `requestFullscreen()` funcionou ou o erro; tamanho em tela cheia | **AP / RP.** Um RP é **limitação documentada, não bloqueio** (o Discord tem modos de exibição próprios) |
| **A-AUDIO** | Aperta "Tocar som", ouve um bipe curto em volume baixo e responde **Ouvi** ou **Não ouvi** | Estado do áudio antes de qualquer toque (autoplay); estado depois do clique; taxa de amostragem; latências informadas; se havia chamada de voz | **AP:** tocou depois do clique e o usuário ouviu. **Áudio suspenso antes do clique é o esperado, não reprovação** · **RP:** não tocou, ou não ouviu |
| **A-FILE-BASIC** | Escolhe **qualquer arquivo comum** (foto ou vídeo) | Se o seletor abriu; tamanho; tipo genérico (imagem / vídeo / áudio / outro); 3 leituras de 2 KiB (início, meio e fim) com o tempo de cada | **AP:** abriu e as 3 leituras vieram com o tamanho certo · **RP:** o seletor não abre ou a leitura falha |
| **A-FILE-LARGE** | Escolhe o **arquivo de teste com marcadores** (seção 4) | Tamanho; leitura nos marcadores do início, **depois de 2³¹ bytes** e do fim; se cada marcador corresponde à posição pedida; tempos | **AP** só se o tamanho passa de 2 GiB **e** os 3 marcadores conferem · **INV:** arquivo grande sem marcadores · **SKIP:** não testado (pendente), **nunca AP só porque o BASIC passou** |

**Privacidade de todos os testes:** nada de nome de arquivo, conteúdo, hash, nome do controle ou texto digitado. Ficam registrados só `code` de tecla, contagens, tamanhos, tempos e tipos genéricos.

## 4. Arquivo de teste para o A-FILE-LARGE

**Formato:** 3 GiB (3.221.225.472 bytes), com 3 marcadores de 64 bytes nestas posições:

| Posição | Por quê |
|---|---|
| 0 | Início |
| **2.148.532.224** (2 GiB + 1 MiB) | **Depois de 2³¹**, que é o limite que importa para a ISO |
| tamanho − 4.096 | Fim |

Cada marcador é o texto `BT3PROBE-MARK:<posição>;`. A sonda lê 2 KiB em cada posição e só aprova se encontrar o texto **com a mesma posição** que pediu. Um arquivo só de zeros não serviria: zero lido em qualquer lugar dá o mesmo resultado.

**Script para Windows** (`scripts/criar-arquivo-teste.ps1`), com os cuidados pedidos na revisão:
1. **Não exige administrador.**
2. Cria o arquivo **fora do repositório**: por padrão em Downloads, com o nome `teste.bt3probe-large.bin`. Arquivos `*.bt3probe-large.bin` estão no `.gitignore`, então **nunca vão para o GitHub**.
3. Marca o arquivo como **esparso** antes de definir o tamanho. Num disco NTFS, um arquivo esparso de 3 GiB ocupa só alguns KB de espaço real.
4. **Se o arquivo esparso não funcionar** (outro sistema de arquivos, por exemplo), o script **para e pergunta** antes de seguir. Sem o modo esparso, gravar o marcador do fim obriga o Windows a preencher os 3 GiB inteiros: isso é lento e ocupa 3 GiB de verdade.
5. **Confere o espaço livre** antes e mostra o tamanho lógico (3 GiB) e o **espaço físico realmente ocupado** depois.
6. Tem a opção `-Apagar`, que só apaga um arquivo com o nome certo **e** com o marcador certo no início, para nunca apagar outra coisa por engano.

**Script equivalente em Node** (`scripts/criar-arquivo-teste.mjs`): para Linux/macOS e para a CI. No Linux o arquivo esparso é nativo.

**No Android:** copiar o arquivo do PC por cabo é opcional. Se ficar trabalhoso, o A-FILE-LARGE fica **pendente no Android** e é registrado assim. Atenção: copiar para o celular **ocupa 3 GiB de verdade**, porque o modo esparso não sobrevive à cópia. Apague depois.

## 5. Mudanças técnicas

| Decisão | Por quê |
|---|---|
| Schema `bt3probe.report/3` com os testes novos; os formatos 1 e 2 continuam válidos | Os relatórios antigos continuam verificáveis |
| Testes automáticos no Playwright para teclado, toque com vários dedos, tela cheia, áudio (sem som), BASIC e LARGE (com o arquivo esparso de 3 GiB criado na CI) | Prova que o código funciona. **Fora do Discord, não prova nada sobre o Discord** |
| O controle **não** é simulado: na CI dá SKIP ou INV | O Playwright não simula gamepad |
| Cartões em sequência com "Pular", botões grandes e área de toque com `touch-action: none` | Uso no celular |

## 6. O que o usuário vai testar

| Ambiente | Interativos | Arquivo grande |
|---|---|---|
| PC — Discord Desktop | Todos, com o controle | Sim (script PowerShell) |
| Android — app Discord | Todos, com o controle por Bluetooth e toque | Opcional (cópia por cabo; senão, pendente) |
| Discord Web | Todos, menos o toque | Opcional |
| Navegador fora do Discord | Base de comparação | Opcional |
| iOS | Pendente | Pendente |

## 7. Critério de conclusão

A F2b termina com relatórios válidos do PC, do Android e do Discord Web, com cada teste em AP, RP, INV ou SKIP justificado. **Um RP é resultado, não falha.** Pela revisão anterior, tela cheia em RP é limitação documentada. O fim da F2b fecha a F2, com uma tabela consolidada.

## 8. Perguntas para a revisão

1. **C1 e C2:** fazer num PR separado (F2b-0) antes da F2b, ou junto?
2. **A-KEY:** testar 3 teclas juntas basta, ou devemos medir até quantas (o limite de teclas do teclado físico interfere)?
3. **A-PAD:** guardar só o tipo genérico do controle é suficiente? Ou o código de fabricante e produto, que não identifica a pessoa, ajuda a comparar resultados?
4. **A-AUDIO:** acrescentar um segundo bipe **durante uma chamada de voz** no Android, para ver se o Discord abaixa ou corta o som do jogo?
5. **Arquivo grande no Android:** vale pedir a cópia de 3 GiB, ou deixar pendente até a F4?
6. **Riscos ou casos** que não estou vendo.

## 9. Ajustes da revisão incorporados

**Obrigatórios (já feitos na F2b-0, PR #3):**
1. **A-GL2:** o WebGL 2 funcionar continua dando AP. A aceleração fica num campo separado, `gpu_acceleration_status` (`confirmed` / `software` / `unknown`).
2. **A-IDB-PERSIST:** máquina de estados explícita (`none` → `pending` → `confirmed` / `cancelled`). Um recibo antigo não aprova uma tentativa nova nem vira RP.

**Para a F2b:**

3. **Script do arquivo de teste:**
   - **não usa `fsutil`**, que pode exigir administrador;
   - marca o arquivo como esparso pela API do Windows (`DeviceIoControl` com `FSCTL_SET_SPARSE`), chamada direto do PowerShell;
   - antes de definir o tamanho, faz uma prova pequena: cria o arquivo, marca como esparso, define 3 GiB e mede o espaço físico ocupado;
   - **se o espaço físico passar de 64 MiB ou o modo esparso falhar, apaga a prova e cancela, explicando o motivo** (nunca aloca 3 GiB automaticamente);
   - nunca sobrescreve um arquivo existente;
   - **o usuário roda e confere no PC dele:** sem Windows aqui, o agente não consegue testar o script, e isso fica dito no PR.
4. **A-KEY:** duas combinações, **W + D + Espaço** e **W + Shift + Espaço**, comparadas com o navegador fora do Discord. **A Esc fica por último.**
5. **A-PAD:**
   - testa botões digitais, os dois analógicos e os gatilhos;
   - repete o teste depois de perder e recuperar o foco;
   - registra quais controles foram efetivamente testados;
   - `SecurityError` (bloqueio pela política do iframe) = **RP**; controle não detectado = **INV** (ele só aparece depois de um botão apertado com a página em foco);
   - não guarda o nome do controle nem os códigos de fabricante e produto.
6. **A-TOUCH:** registra os cancelamentos **sem afirmar que foram causados pelo Discord**; compara com o navegador fora do Discord.
7. **A-AUDIO:** teste **opcional durante chamada de voz** no Android. Compara se o som do jogo e a voz da chamada continuam audíveis.
8. **A-FILE-BASIC:** cancelar o seletor = **SKIP**. Num arquivo pequeno, as posições de leitura se ajustam ao tamanho, ou o teste pede outro arquivo, sem reprovar.
9. **A-FILE-LARGE:**
   - obrigatório no PC, se for possível criar o arquivo com segurança;
   - **no Android, opcional e pendente até a F4**;
   - na CI, o arquivo de 3 GiB é criado e apagado **só no ambiente temporário** e **nunca vira artefato**.
10. **No fim da F2b:** relatório consolidado F2a + F2b comparando Discord Desktop, Discord Web, Android e navegador fora do Discord, com limitações e pendências.

## 10. Regras que continuam valendo

- Nada do BT3, nem como arquivo de teste.
- Nada do bot da NBA.
- Nada de segredos.
- Os parâmetros da URL nunca contam como identidade.
- Nada pesado sem consentimento: o arquivo de 3 GiB é **esparso no PC** e só é lido em 3 pedaços de 2 KiB.
- Merge = publicação, só com o "pode" do usuário.
- **F3 só com nova aprovação.**
