# F3a — Roteiro dos testes de conectividade (Bloco 5)

> **Pré-requisitos:**
> - o merge deste PR, com a página publicada na versão **0.4.0** (o rodapé da sonda mostra `v0.4.0`);
> - o servidor da VM no ar, respondendo **fechado** em `https://sonda.kingszin.com.br/net/health`.
>
> Nada aqui altera o servidor. A janela de rede só abre pelo SSH, por você.

## 1. URL Mapping (Discord Developer Portal)

1. Abra **discord.com/developers/applications**, entre na aplicação da sonda (ID `1571332639812493522`) e vá em **Activities → URL Mappings**.
2. Acrescente um mapeamento **acima** do `/` que já existe:

   | PREFIX | TARGET |
   |---|---|
   | `/net` | `sonda.kingszin.com.br` |

   O TARGET vai sem `https://`.
3. Salve. **Não altere o mapeamento `/`.**

**Se o teste N-PATH der RP com 404**, o Discord está tirando o prefixo `/net` ao repassar. Nesse caso, troque o TARGET para `sonda.kingszin.com.br/net` e repita. O próprio relatório sugere isso no detalhe do N-PATH.

## 2. Abrir a janela de rede (SSH na VM)

```bash
sudo bt3probe-janela abrir 60          # 60 minutos; fecha sozinha depois
curl -s http://127.0.0.1:8787/net/health | head -c 60; echo   # deve mostrar "aberto":true
```

- Se o serviço reiniciar, a janela **fecha** e precisa ser aberta de novo. Isso é de propósito.
- Para fechar antes da hora: `sudo bt3probe-janela fechar`.

## 3. Testar em cada ambiente

Em **cada um** dos ambientes abaixo:
1. Abra a sonda.
2. Espere a verificação automática (N-HTTP e N-PATH).
3. No cartão **"Conexão com o servidor"**, aperte **"Testar 5 conexões"**.
4. Preencha "Aparelho" e "Rede" no formulário.
5. **Baixe ou copie o JSON.**

| # | Ambiente | Como abrir |
|---|---|---|
| 1 | Discord Desktop (PC) | Activity no app |
| 2 | Discord Web (Edge, no PC) | Activity no navegador |
| 3 | S26 Ultra (app do Discord) | Activity no celular |
| 4 | A16 (app do Discord) | Activity no celular |
| 5 | Fora do Discord (Edge, no PC) | `https://enzo-rbt0.github.io/bt3-activity-probe/` |

**Orçamento:** cada "Testar 5 conexões" gasta **5 das 30 admissões do dia**, então os 5 ambientes usam 25. Evite repetir à toa. Se aparecer **INV "limite do servidor (429)"**, o teto do dia acabou; continue no dia seguinte (o dia é em UTC: vira às 21h no horário de Brasília).

## 4. Como ler o resultado

| Teste | AP | INV | RP |
|---|---|---|---|
| **N-HTTP** | O servidor respondeu pelo caminho que a sonda usa | — | Sem resposta válida (DNS, TLS, mapeamento ou servidor fora do ar) |
| **N-PATH** (só dentro do Discord) | O mapeamento chega ao servidor (`/net` ou `/.proxy/net`) | — | Nenhum caminho chegou: veja a dica no detalhe |
| **N-WS-OPEN** | **5 de 5** WebSockets abertos em até 5 s | 1 a 4; ou janela fechada; ou limite do dia | **0** abertos |

Detalhes que ajudam no diagnóstico (todos no JSON):
- `failed_stage`: onde cada tentativa parou.
  - `admissao`: o servidor recusou a sessão. Um **403** quer dizer que o servidor não reconheceu a origem da página, o que pode acontecer se o proxy do Discord não repassar o cabeçalho `Origin`.
  - `upgrade`: o WebSocket foi recusado antes de abrir. O navegador não mostra o motivo; o log do servidor mostra.
  - `eco`: abriu, mas a mensagem não voltou.
- `open_ms` / `echo_ms`: tempos de abertura e de ida e volta.
- No N-PATH, o caminho **`absoluto`** deve **falhar** dentro do Discord, porque a CSP barra o endereço direto. É o controle do teste.

## 5. Depois dos testes

```bash
sudo bt3probe-janela fechar
sudo journalctl -u bt3probe --since "2 hours ago" --no-pager -o cat | tail -40
```

O log não tem IP, URL nem bilhete: só eventos e códigos.

Me mande:
- os **5 JSONs**;
- se algo falhar, o trecho do log (de `admissao_recusada`, `upgrade_recusado` e `sessao_encerrada`).

## Regras que continuam valendo

- A janela só abre pelo SSH, por você, e fecha sozinha.
- O relatório nunca guarda bilhete, ID de sessão, IP, cabeçalho ou URL completa.
- O teste de fumaça da CI usa um servidor **simulado**: a CI nunca fala com a VM.
