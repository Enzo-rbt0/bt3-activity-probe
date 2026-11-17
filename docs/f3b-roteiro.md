# F3b — Roteiro do eco contínuo (N-ECHO)

> **Pré-requisitos:**
> - o merge deste PR, com a página publicada na versão **0.5.0** (o rodapé da sonda mostra `v0.5.0`);
> - o servidor 0.2.0 na VM, com tetos de **60 admissões** e **300.000 mensagens** por dia (`sudo bt3probe-limites mostrar`).
>
> **Nada muda no servidor, no Caddy, no DNS ou no URL Mapping.** A janela de rede só abre pelo SSH, por você.

## 1. Antes de começar

- **Celular:** deixe o tempo de tela (Configurações → Tela → Tempo limite da tela) em **2 minutos ou mais**. A página tenta manter a tela acesa sozinha, mas dentro do Discord isso pode ser negado.
- Deixe o Discord com o **canal de voz** como nos testes anteriores, para comparar nas mesmas condições.
- Feche downloads e vídeos pesados durante as medições.

## 2. Abrir a janela de rede (SSH na VM)

```bash
sudo bt3probe-janela abrir 90
sleep 6
curl -s http://127.0.0.1:8787/net/health | head -c 60; echo   # deve mostrar "aberto":true
```

90 minutos dão folga para as 14 medições (cada uma leva cerca de 1 minuto).

## 3. Como fazer cada medição

1. Abra a sonda no ambiente da vez.
2. Espere o N-HTTP ficar **AP**.
3. No cartão **"Eco contínuo (N-ECHO · F3b)"**, escreva o **rótulo do par** (tabela abaixo).
4. Clique em **"Medir 60 s"** e depois em **"Confirmar: medir agora"**.
5. **Não mexa em nada durante os 62 s:** não troque de aba ou de app, não minimize, não apague a tela.
6. No fim, preencha **Aparelho** e **Rede** e clique em **"Copiar JSON"**. Cole o JSON aqui no chat.

## 4. Ordem das medições (alternadas)

Alterne **Discord (D)** e **fora do Discord (F)** no mesmo aparelho e na mesma rede. Os dois lados de cada comparação usam o **mesmo rótulo**.

| # | Aparelho | Ambiente | Rótulo |
|---|---|---|---|
| 1 | PC | Discord Desktop (D) | PC-1 |
| 2 | PC | Edge, fora do Discord (F) | PC-1 |
| 3 | PC | Discord Web no Edge (D) | PC-1 |
| 4 | PC | Discord Desktop (D) | PC-2 |
| 5 | PC | Edge, fora do Discord (F) | PC-2 |
| 6 | PC | Discord Web no Edge (D) | PC-2 |
| 7 | S26 | App do Discord (D) | S26-1 |
| 8 | S26 | Chrome, fora do Discord (F) | S26-1 |
| 9 | S26 | App do Discord (D) | S26-2 |
| 10 | S26 | Chrome, fora do Discord (F) | S26-2 |
| 11 | A16 | App do Discord (D) | A16-1 |
| 12 | A16 | Chrome, fora do Discord (F) | A16-1 |
| 13 | A16 | App do Discord (D) | A16-2 |
| 14 | A16 | Chrome, fora do Discord (F) | A16-2 |

Fora do Discord, o endereço é `https://enzo-rbt0.github.io/bt3-activity-probe/`.

**Orçamento:** cada medição gasta 1 admissão e reserva 4.290 mensagens; a sobra volta no fim. As 14 medições usam 14 das 60 admissões e cerca de 52.000 das 300.000 mensagens do dia. Dá para repetir o que precisar.

## 5. Como ler o resultado

| Status | Quando |
|---|---|
| **AP** | 60 s completos, sem queda, página sempre visível, eco de 99% ou mais |
| **INV** | Página escondida; janela fechada; limite do dia; eco entre 95% e 99%; houve reconexão; ou você clicou em "Parar" |
| **RP** | Não completou mesmo com 3 reconexões; eco abaixo de 95%; ou o servidor fechou por limite (4002) |

O que olhar no JSON (`tests["N-ECHO"]`):
- `rtt`: p50 (típico), p95 e p99 (piores momentos) e máximo, em ms;
- `variation`: quanto o RTT muda de uma mensagem para a seguinte;
- `cadence`: se a página conseguiu enviar a 60 por segundo (`rate_hz`), envios atrasados e pulados;
- `delays`: quantos ecos passaram de 50, 100, 250 ms e de 1 s, e pausas longas sem resposta;
- `worst`: as 20 piores, com o instante (em ms desde o início);
- `d_estimate_frames`: estimativa do atraso de entrada em quadros. **É só uma aproximação**, não uma aprovação.

## 6. Depois das medições

```bash
sudo bt3probe-janela fechar
sudo journalctl -u bt3probe --since "2 hours ago" --no-pager -o cat | sort | uniq -c
```

O esperado:
- uma linha `admissao` por medição (mais as reconexões, se houver);
- os encerramentos com código 1000;
- **nenhum** `admissao_recusada` nem `upgrade_recusado`.

Me mande os 14 JSONs e a saída do log.

## Regras que continuam valendo

- A janela só abre pelo SSH, por você, e fecha sozinha.
- O relatório guarda só resumos: nenhuma amostra individual, bilhete, ID de sessão, IP, cabeçalho ou URL.
- O servidor fica em **Phoenix (EUA)**: os números valem para essa rota e **não** representam jogadores no Brasil em geral.
- A CI nunca fala com a VM.
