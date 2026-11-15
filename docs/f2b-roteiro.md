# Roteiro de teste da F2b (interação)

Objetivo: ver se teclado, controle, toque, tela cheia, áudio e arquivos funcionam **dentro do Discord**. Os testes ficam na seção "Testes interativos" da sonda. Cada um pode ser pulado: pular vira SKIP, e não reprova nada.

Plano: [`f2b-plano.md`](f2b-plano.md) (versão 2, aprovada).

## 0. Antes

1. O PR da F2b foi aprovado e o merge feito. O merge publica a nova versão.
2. No topo da sonda deve aparecer **"fase F2b · v0.3.0"**. Se aparecer outra coisa, feche e abra a Activity de novo; se não mudar, reinicie o Discord.
3. **Só no PC: crie o arquivo de teste de 3 GiB.**
   1. Baixe o script [`criar-arquivo-teste.ps1`](../scripts/criar-arquivo-teste.ps1): no GitHub, abra o arquivo e use o botão "Download raw file". Ele vai para a pasta Downloads.
   2. Abra o **PowerShell** (menu Iniciar → digite "PowerShell"). **Não precisa de administrador.**
   3. Rode:
      ```
      powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\criar-arquivo-teste.ps1"
      ```
      O `-ExecutionPolicy Bypass` vale só para esta execução e não muda nada no Windows.
   4. O script mostra o **espaço realmente ocupado**, que deve ser de poucos KiB. Se ele parar com erro, nada é criado e nenhum espaço fica ocupado. Me mande a mensagem de erro.
   5. O script é testado automaticamente num Windows da CI (PowerShell 5.1, o mesmo do seu PC): criação, tamanho, marcadores, espaço físico, recusa de sobrescrever e apagar. Mesmo assim, se aparecer qualquer erro, pare e me mande a mensagem. Se ele disser que **não conseguiu apagar** o arquivo incompleto, siga a instrução de limpeza manual que ele mostra.

## 1. Em cada ambiente (PC – Discord Desktop, Android – app Discord, Discord Web)

| Cartão | O que fazer |
|---|---|
| **Teclado** | "Começar" → aperte W, A, S, D, as 4 setas, Espaço e Enter → segure **W+D+Espaço** juntas → segure **W+Shift+Espaço** juntas → "Concluir teclas". **Baixe ou copie o JSON agora**, porque a Esc pode fechar a Activity. Depois: "Testar Esc (5 s)" → aperte Esc |
| **Controle** | Ligue o controle antes → "Começar" → aperte um botão para ele aparecer → aperte botões, **os dois gatilhos (LT/RT ou L2/R2)** e mexa os **dois** analógicos → **troque de janela ou app, volte e aperte um botão** → "Concluir". Sem os gatilhos e sem a volta do foco, o resultado é INV, não AP |
| **Toque** (celular) | Toque com 1, 2 e 3 dedos na área cinza → arraste um dedo de um lado ao outro → "Concluir" |
| **Tela cheia** | "Tela cheia": se abrir, ela sai sozinha em 2 s |
| **Áudio** | "Tocar som" → responda "Ouvi" ou "Não ouvi". **Opcional no Android:** numa chamada de voz, "Tocar durante a chamada" e responda as duas perguntas |
| **Arquivo comum** | Escolha qualquer foto ou vídeo. **Nunca um arquivo do BT3** |
| **Arquivo > 2 GiB** | **PC:** escolha `teste.bt3probe-large.bin` na pasta Downloads. **Android e Web:** pode pular; o teste fica pendente |

Depois, baixe ou copie o JSON. Se a Esc tiver fechado a Activity, mande o JSON salvo antes dela.

## 2. Base de comparação

Faça o **teclado** e o **toque** também no navegador comum fora do Discord: https://enzo-rbt0.github.io/bt3-activity-probe/. Isso separa limitação do teclado ou do aparelho de interferência do Discord.

## 3. Depois

1. Apague o arquivo de teste:
   ```
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\criar-arquivo-teste.ps1" -Apagar
   ```
   O `-Apagar` só apaga o arquivo com o nome e o marcador certos.
2. Mande os JSONs (1 por ambiente, mais o da comparação) e um print de cada.
3. A F2 termina com o relatório consolidado F2a + F2b. **A F3 só começa com nova aprovação.**

## 4. Como ler

| Teste | AP | INV | RP | SKIP |
|---|---|---|---|---|
| A-KEY | Todas as teclas, as 2 combinações e Esc chegaram | Alguma tecla ou combinação não chegou (compare fora do Discord) | Nenhuma tecla chegou | Pulado ou não feito |
| A-PAD | Validação completa: botão, os dois analógicos, os dois gatilhos e comando depois de recuperar o foco | Funciona em parte; ou controle com mapeamento não padrão (gatilhos não verificáveis); ou a API existe, mas o controle não apareceu | API bloqueada pelo iframe ou inexistente | Pulado |
| A-TOUCH | 2 ou mais dedos e arrasto, sem cancelamentos | Só 1 dedo, ou houve cancelamento (causa não identificada) | — | Sem tela de toque ou pulado |
| A-FS | Tela cheia abriu | — | Não permitida: **limitação documentada, não bloqueio** | Pulado |
| A-AUDIO | Tocou depois do clique e você ouviu. Áudio suspenso antes do clique é normal | — | Não tocou ou você não ouviu | Pulado |
| A-FILE-BASIC | Seletor abriu e as 3 leituras vieram certas | — | Leitura falhou | Cancelado ou pulado |
| A-FILE-LARGE | Arquivo maior que 2 GiB com os 3 marcadores na posição certa | Arquivo sem marcadores ou com 2 GiB ou menos | É o arquivo de teste, mas a leitura veio errada | Pulado: fica pendente, nunca AP |
