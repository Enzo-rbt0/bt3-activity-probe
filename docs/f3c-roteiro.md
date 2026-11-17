# F3c — Roteiro do relay entre dois aparelhos (N-RELAY)

> **Pré-requisitos:**
> - o merge deste PR, com a página publicada na versão **0.6.0** (o rodapé da sonda mostra `v0.6.0`);
> - o servidor **0.4.0** na VM (já feito em 17/11/2026), com tetos de **60 admissões** e **300.000 mensagens** por dia (`sudo bt3probe-limites mostrar`).
>
> **Nada muda no servidor, no Caddy, no DNS ou no URL Mapping.** A janela de rede só abre pelo SSH, por você.

## 1. O que muda em relação à F3b

Na F3b, **um** aparelho conversava com o servidor. Agora são **dois aparelhos ao mesmo tempo**, numa "sala" do servidor:

1. Um aparelho aperta **"Criar sala"** e aparece um **código** grande (ex.: `K7Q-4MD`).
2. O outro aparelho digita esse código e aperta **"Entrar"**. Ele tem **1 min 30 s** para isso.
3. Com os dois dentro, a medição começa **sozinha nos dois**: cerca de 5 s de pings, **62 s** de quadros a 60 por segundo e mais cerca de 5 s de pings.
4. **Cada aparelho gera o próprio relatório.** São **dois JSONs por sala**.

O código só serve para juntar os dois aparelhos e vence em 2 minutos. Ele **não vai** para o relatório nem para o log.

## 2. Antes de começar

- **Celulares:** deixe o tempo de tela em **2 minutos ou mais**.
- **PC com duas janelas (pares 1 e 4):** deixe as duas janelas **lado a lado**, sem minimizar e sem uma cobrir a outra por inteiro. Se o Windows achar que a janela está escondida, o resultado vira INV.
- **Chamada de voz:** a mesma conta normalmente só fica na chamada em um aparelho. Deixe como der, mas **marque o campo "Chamada de voz" certo em cada aparelho**, porque isso vai para o relatório.
- Feche downloads e vídeos pesados.

## 3. Abrir a janela de rede (SSH na VM)

```bash
sudo bt3probe-janela abrir 90
sleep 6
curl -s http://127.0.0.1:8787/net/health | head -c 60; echo   # deve mostrar "aberto":true
```

90 minutos dão folga para as 9 salas (cada uma leva cerca de 2 minutos, contando o tempo de digitar o código).

## 4. Como fazer cada sala

O **PC Desktop (Discord)** cria a sala em todas. O outro aparelho entra.

1. Abra a sonda **nos dois** aparelhos e espere o N-HTTP ficar **AP** nos dois.
2. Nos **dois**, no cartão **"Relay entre dois aparelhos (N-RELAY · F3c)"**, escreva o **mesmo rótulo** (tabela abaixo).
3. No **PC Desktop**, clique em **"Criar sala"**. Aparece o código.
4. No **outro aparelho**, digite o código em "Ou entre na sala do outro aparelho" e clique em **"Entrar"**. Maiúscula, minúscula e hífen tanto faz.
5. **Não mexa em nada durante cerca de 75 s**, em **nenhum dos dois**: não troque de aba ou de app, não minimize, não apague a tela.
6. No fim, em **cada** aparelho, preencha **Aparelho**, **Rede** e **Chamada de voz** e clique em **"Copiar JSON"**. Cole os **dois** JSONs aqui no chat, dizendo de qual aparelho é cada um.

Se o outro aparelho não entrar a tempo, a sala vence e o resultado fica **INV**. Basta criar outra sala.

## 5. Ordem das salas

| # | Cria a sala (A) | Entra (B) | Rede do B | Rótulo |
|---|---|---|---|---|
| 1 | PC Desktop | PC Edge (fora do Discord) | cabo | PC-EDGE-1 |
| 2 | PC Desktop | PC Edge (fora do Discord) | cabo | PC-EDGE-2 |
| 3 | PC Desktop | S26 · app do Discord | **5G** | PC-S26-5G-1 |
| 4 | PC Desktop | S26 · app do Discord | **5G** | PC-S26-5G-2 |
| 5 | PC Desktop | S26 · app do Discord | **Wi-Fi** | PC-S26-WIFI-1 |
| 6 | PC Desktop | A16 · app do Discord (casa do amigo) | Wi-Fi de lá | PC-A16-1 |
| 7 | PC Desktop | A16 · app do Discord (casa do amigo) | Wi-Fi de lá | PC-A16-2 |
| 8 | PC Desktop | PC · Discord Web no Edge | cabo | PC-WEB-1 |
| 9 | PC Desktop | PC · Discord Web no Edge | cabo | PC-WEB-2 |

- Fora do Discord, o endereço é `https://enzo-rbt0.github.io/bt3-activity-probe/`.
- **Salas 6 e 7:** mande o código para o seu amigo pelo chat ou pela chamada logo que ele aparecer.
- **Salas 8 e 9:** se o Discord não deixar abrir a Activity no Desktop e no Web **ao mesmo tempo** com a mesma conta, pare e me avise. A gente troca esse par.

**Orçamento:** cada aparelho gasta 1 admissão e reserva 11.880 mensagens. A sobra volta no fim (cada um usa cerca de 3.800). As 9 salas usam 18 das 60 admissões do dia. Dá para repetir o que precisar.

## 6. Como ler o resultado

| Status | Quando |
|---|---|
| **AP** | Medição completa, nenhum dos dois saiu, página sempre visível, 99% ou mais dos quadros do outro chegaram |
| **INV** | Página escondida; janela fechada; código errado ou sala vencida; o outro aparelho saiu no meio; chegaram entre 95% e 99%; ou você clicou em "Parar" |
| **RP** | A conexão caiu; o servidor fechou por limite (4002); ou chegaram menos de 95% dos quadros do outro |

O detalhe traz o número mais importante da F3c: **o menor atraso de entrada D** (em quadros e em ms) com o qual o jogo **quase não travaria**:
- **D com ≤ 1% de travadas:** o jogo pararia em no máximo 1 de cada 100 quadros;
- **D com ≤ 0,1%:** no máximo 1 de cada 1.000. É a proposta de **"Jogável"**, a revisar na F3f.

O que olhar no JSON (`tests["N-RELAY"]`):
- `rtt_before` / `rtt_after`: RTT deste aparelho até o servidor, antes e depois;
- `rtt_self_ms` / `rtt_peer_ms`: o RTT deste aparelho e o que o outro informou;
- `lateness_raw`: o atraso de chegada dos quadros do outro, **como medido** (≈ RTT do outro);
- `lateness`: o mesmo, **corrigido** para os dois começarem juntos, com incerteza de ± `uncertainty_ms`;
- `d_curve`: a % de travadas para D = 1, 2, …, 30 quadros;
- `d_min_1pct` / `d_min_01pct`: o menor D com até 1% e até 0,1% de travadas;
- `received` / `missing`: quadros do outro que chegaram e que não chegaram (os que não chegaram contam como travadas);
- `cadence` e `skipped`: se a página conseguiu enviar a 60 por segundo;
- `gaps`: pausas longas sem quadros do outro.

## 7. Depois das salas

```bash
sudo bt3probe-janela fechar
sudo journalctl -u bt3probe --since "2 hours ago" --no-pager -o cat | sort | uniq -c
```

O esperado:
- **18** linhas `admissao` (2 por sala);
- 9 de cada: `sala_criada`, `sala_completa`, `sala_largada` e `sala_encerrada` "depois da largada";
- os encerramentos com código 1000;
- **nenhum** `admissao_recusada` nem `upgrade_recusado`.

Me mande os 18 JSONs e a saída do log.

## Regras que continuam valendo

- A janela só abre pelo SSH, por você, e fecha sozinha.
- O relatório guarda só resumos: nenhuma amostra individual, **código de sala**, bilhete, ID de sessão, IP, cabeçalho ou URL.
- O servidor fica em **Phoenix (EUA)**: os números valem para essa rota e **não** representam jogadores no Brasil em geral.
- A CI nunca fala com a VM.
