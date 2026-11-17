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
   | `/net` | `sonda.kingszin.com.br/net` |

   O TARGET vai sem `https://` e **com `/net` no fim**.
3. Salve. **Não altere o mapeamento `/`.**

**Por que `/net` no TARGET:** o proxy do Discord **remove o prefixo** ao repassar. Uma chamada a `/net/health` chega ao TARGET como `/health`. Com o TARGET só `sonda.kingszin.com.br`, o servidor recebe `/health`, que não existe, e o N-PATH dá RP com 404. Isso foi confirmado em 17/11/2026.

## 2. Abrir a janela de rede (SSH na VM)

```bash
sudo bt3probe-janela abrir 60          # 60 minutos; fecha sozinha depois
sleep 6                                # o servidor relê o arquivo da janela a cada 5 s
curl -s http://127.0.0.1:8787/net/health | head -c 60; echo   # deve mostrar "aberto":true
```

- Sem o `sleep`, o `curl` pode rodar antes da releitura e ainda mostrar `"aberto":false`. Nesse intervalo o servidor fica fechado, que é o lado seguro.

- Se o serviço reiniciar, a janela **fecha** e precisa ser aberta de novo. Isso é de propósito.
- Para fechar antes da hora: `sudo bt3probe-janela fechar`.

## 3. Testar em cada ambiente

Em **cada um** dos ambientes abaixo:
1. Abra a sonda.
2. Espere a verificação automática (N-HTTP e N-PATH).
3. No cartão **"Conexão com o servidor"**, aperte **"Testar 5 conexões"**.
4. Preencha "Aparelho" e "Rede" no formulário.
5. **Copie o JSON** ("Copiar JSON"). **Dentro do Discord, "Baixar JSON" não funciona**, nem no app nem no navegador: o download é bloqueado.

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
  - `admissao`: o servidor recusou a sessão. Um **403** quer dizer que o servidor não reconheceu a origem da página. Em 17/11/2026 o proxy do Discord **repassou** o `Origin` da Activity, e as admissões deram 201; um 403 agora indicaria mudança no Discord ou na lista de origens.
  - `upgrade`: o WebSocket foi recusado antes de abrir. O navegador não mostra o motivo; o log do servidor mostra.
  - `eco`: abriu, mas a mensagem não voltou.
- `open_ms` / `echo_ms`: tempos de abertura e de ida e volta.
- No N-PATH, o caminho **`absoluto`** deve **falhar** dentro do Discord, porque a CSP barra o endereço direto. É o controle do teste.

## 5. Depois dos testes

```bash
sudo bt3probe-janela fechar
sudo journalctl -u bt3probe --since "2 hours ago" --no-pager -o cat | sort | uniq -c
```

O segundo comando conta cada tipo de evento. Nos 5 ambientes, o esperado é:
- **25** `admissao`;
- **25** `sessao_encerrada` com código 1000;
- **nenhum** `admissao_recusada` ou `upgrade_recusado`.

O log não tem IP, URL nem bilhete: só eventos e códigos.

Me mande:
- os **5 JSONs**;
- se algo falhar, o trecho do log (de `admissao_recusada`, `upgrade_recusado` e `sessao_encerrada`).

## Regras que continuam valendo

- A janela só abre pelo SSH, por você, e fecha sozinha.
- O relatório nunca guarda bilhete, ID de sessão, IP, cabeçalho ou URL completa.
- O teste de fumaça da CI usa um servidor **simulado**: a CI nunca fala com a VM.
