# Operação da sonda F3 (guia para quando a F3a for autorizada)

> **Estado:** só código e testes locais (F3-0). Nada aqui foi executado. Conta, VM, domínio, DNS,
> firewall e deploy dependem de uma autorização separada (F3a). O primeiro deploy é **manual**, feito
> por quem opera, sem nenhuma credencial entregue a agentes.

## 1. Conta Oracle: usar a que já existe

- **Não criar conta nova.** A Oracle permite uma conta Free Tier por pessoa e já existe uma
  tenancy com **região de origem Phoenix (us-phoenix-1)**.
- Recursos Always Free só existem na região de origem. Se a sonda rodar em Phoenix:
  - registrar `região: us-phoenix-1` no relatório de cada medição;
  - **não generalizar a latência para o Brasil**: os números valem para Discord → Phoenix.
- **Não excluir nem modificar recursos antigos** da tenancy.
- Antes de criar qualquer coisa, conferir na console (Governance → Limits, Quotas and Usage):
  - quanto do limite A1 (equivalente a 2 OCPU / 12 GB) já está em uso;
  - **armazenamento em bloco**: o Boot Volume antigo de ~199 GB pode já consumir quase todos os
    200 GB gratuitos. Se consumir, uma VM nova com boot volume padrão (≥ 47 GB) passa do gratuito.
    Decidir com o dono da conta (reaproveitar a VM existente, ou outra solução) **antes** de criar.

## 2. Instalação na VM (manual)

```sh
# Usuário de serviço, sem shell e sem home
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bt3probe
sudo install -d -o root -g root -m 0755 /opt/bt3probe /etc/bt3probe
# Copiar dist/, package.json e package-lock.json para /opt/bt3probe e instalar só dependências de produção
cd /opt/bt3probe && sudo npm ci --omit=dev
sudo install -m 0644 bt3probe.service /etc/systemd/system/
sudo install -m 0755 bt3probe-janela /usr/local/sbin/
sudo install -m 0755 bt3probe-limites /usr/local/sbin/
sudo systemctl daemon-reload && sudo systemctl enable --now bt3probe
```

- O serviço escuta só em `127.0.0.1:8787`. Para escutar em outro endereço é preciso
  `BT3PROBE_ALLOW_PUBLIC_BIND=sim`, de propósito.
- A unidade systemd **não tem `CPUQuota`**. O resto da sandbox continua: `MemoryMax=256M`,
  `ProtectSystem=strict`, sem capabilities e só tráfego local.
- Caddy (TLS + proxy reverso): ver `Caddyfile.example`, que não grava log de acesso.
- Firewall: abrir só 80/443 na Security List/NSG **e** no `iptables` da imagem Ubuntu da Oracle
  (que bloqueia por padrão). A porta 8787 nunca fica exposta.

## 3. Interruptor (desligado por padrão)

```sh
sudo bt3probe-janela abrir 120   # abre por 120 min (máx. 720)
sudo bt3probe-janela fechar      # fecha na hora
sudo bt3probe-janela status
```

- O servidor relê o arquivo a cada 5 s. Sem arquivo, arquivo inválido ou prazo vencido = **fechado**.
- **Reinício deixa o serviço fechado.** Se o processo reiniciar (deploy, queda, `systemctl restart`,
  reboot), a janela aberta antes dele é ignorada, **mesmo que ainda tenha tempo restante**.
  - A rede só volta com um novo `bt3probe-janela abrir` (nova autorização operacional).
  - Regra no código: `opened_at` anterior ao início do processo = fechado (`src/config.ts`; testes
    T9 em `test/window.test.ts` e `test/restart-failure.test.ts`).
- Sessões abertas antes de um reinício contam como totalmente gastas no orçamento do dia, e nenhum
  bilhete emitido antes do reinício vale depois.

## 4. Respostas e códigos

| Momento | Situação | Resposta |
|---|---|---|
| `POST /net/session` | Origin fora da lista | HTTP 403 |
| | corpo > 256 B | HTTP 413 |
| | JSON, tipo ou duração inválidos | HTTP 400 |
| | rede fechada ou servidor encerrando | HTTP 503 |
| | limite de sessões, de admissões ou de orçamento do dia | HTTP 429 |
| | erro do banco | HTTP 503 (fail-closed) |
| Upgrade `/net/ws/echo` ou `/net/ws/relay` (antes do WebSocket existir) | Origin fora da lista; bilhete inválido, vencido, já usado ou de outro tipo (bilhete `echo` na rota de relay, ou o contrário; **não** é gasto) | HTTP 403 |
| | outra rota | HTTP 404 |
| | rede fechada, servidor encerrando ou erro do banco | HTTP 503 |
| Conexão já estabelecida | prazo da sessão, fim da janela, 60 s de inatividade | close **4001** |
| | mensagem > 64 B, rajada > 360 ou taxa média > 120/s, cota da sessão esgotada | close **4002** |
| | mensagem > 1024 B (trava do `ws`) | close 1009 |
| | SIGTERM (`systemctl stop`/deploy) | close 1001 |

Os códigos 4001 e 4002 só existem depois do upgrade. Antes dele, a recusa é sempre HTTP.

### Salas de relay (F3c, servidor 0.4.0)

- Cada aparelho pede o **próprio** bilhete (`POST /net/session` com `"kind":"relay"`) e conecta em `/net/ws/relay`. Os limites (64 B, taxa, rajada, cota, prazo, janela) valem **por aparelho**.
- O código da sala só junta duas sessões já admitidas. **Não é identidade nem credencial**: 6 símbolos, vale 2 min se ninguém entrar, no máximo 2 aparelhos, e **nunca** vai para o log, o health ou o relatório.
- As salas ficam só na memória do processo (um reinício desfaz todas). Nenhum SQLite por mensagem.

| Mensagem (texto JSON) | Resposta |
|---|---|
| `{"t":"criar"}` | `{"t":"sala","codigo":"K7Q4MD"}` |
| `{"t":"entrar","codigo":"K7Q-4MD"}` (aceita minúsculas, hífen e espaço) | `{"t":"par"}` para os dois |
| `{"t":"ping","n":3}` | `{"t":"pong","n":3}` (RTT até o servidor; também mantém a conexão viva) |
| `{"t":"pronto","rtt":185}` | quando os dois estão prontos: `{"t":"comecar","rtt_outro":190}` para cada um |
| — | `{"t":"saiu"}` quando o outro sai (a sala acaba) |
| inválida | `{"t":"erro","motivo":"..."}`; a conexão continua |

- Erros possíveis: `código inválido ou vencido`, `sala cheia`, `já está numa sala`, `sala sem par`, `sala venceu sem o segundo aparelho`, `ping inválido`, `mensagem inválida`.
- **Mais de 5 tentativas de código** na mesma conexão → close **4002** `tentativas demais`.
- Quadros **binários** só passam depois do `comecar`, e só para o **outro** aparelho, sem mudança. Antes disso são descartados (mas contam nos limites).
- Log: `sala_criada`, `sala_completa`, `sala_largada`, `sala_encerrada` (antes/depois da largada) e `sala_expirada`, todos **sem o código**.

### Origin não é autenticação

A conferência de `Origin` é **só uma defesa complementar**: ela impede que uma página de outro site use a sonda pelo navegador de alguém. Qualquer cliente fora do navegador (curl, script) escolhe o cabeçalho que quiser.

O que limita abuso:
- a **janela fechada** fora dos testes;
- os **tetos** de vagas, admissões e mensagens por dia;
- o bilhete de uso único.

Alguém que conheça o domínio pode gastar a cota do dia **enquanto a janela estiver aberta**. Antes de um deploy público duradouro, avaliar uma proteção a mais (por exemplo, exigir uma prova ligada à sessão do Discord). Isso fica para a F3a ou depois, com aprovação.

## Encerramento

`systemctl stop` envia SIGTERM:
- as sessões fecham com 1001;
- o processo sai com 0 se tudo terminar bem;
- se o encerramento falhar ou passar de 8 s, o log registra `encerramento_falhou` e o processo sai com **1** (o systemd mostra a unidade como `failed`).

## 5. Tetos

### Padrão do código

- 4 sessões simultâneas.
- 30 admissões por dia (UTC).
- 60 000 mensagens reservadas por dia.
- Reserva por sessão: duração × 60 Hz × 1,1.
- Duração máxima de 180 s.
- Bilhete de 128 bits, de uso único, válido por 30 s.
- 64 B por mensagem.
- 120 mensagens por segundo em média, com rajada de até 360 de uma vez (cobre um engasgo de rede de ~6 s a 60 Hz).
- 60 s de inatividade.

### Ajuste na VM, sem mudar código (`bt3probe-limites`)

```sh
sudo bt3probe-limites mostrar                         # arquivo atual e tetos em uso no serviço
sudo bt3probe-limites definir mensagens_dia 300000    # muda um teto e reinicia o serviço
sudo bt3probe-limites remover mensagens_dia           # aquele teto volta ao padrão
sudo bt3probe-limites padrao                          # apaga o arquivo: tudo no padrão
```

| Chave | Campo | Teto absoluto |
|---|---|---|
| `mensagens_dia` | mensagens reservadas por dia | 1 a 1 000 000 |
| `admissoes_dia` | admissões por dia | 1 a 200 |
| `conexoes_simultaneas` | sessões simultâneas | 1 a 8 |
| `mensagens_por_segundo` | taxa média por conexão | 1 a 240 |
| `rajada_mensagens` | rajada máxima por conexão (tamanho do balde) | 1 a 1 000 |
| `duracao_maxima_s` | duração máxima da sessão | 1 a 600 |

- O arquivo é `/etc/bt3probe/limites.json` (root, 0644). O serviço só lê, e **só ao iniciar**.
- Mudar **reinicia o serviço**, e o reinício **fecha a janela** (de propósito). Para testar, rode `bt3probe-janela abrir` de novo.
- **Fail-safe:** arquivo ilegível, JSON inválido, chave desconhecida ou valor fora do teto absoluto → o arquivo **inteiro** é ignorado e valem os padrões do código. O health mostra `tetos_origem` (`arquivo` ou `padrao`) e `tetos_aviso`; o log registra o evento `limites`.
- O script valida com o próprio código do servidor (`/opt/bt3probe/dist/limits.js`) e recusa o valor antes de gravar.
- Fixos no código: 64 B por mensagem, bilhete de 30 s, margem de 10%, 60 s de inatividade e a janela fechada por padrão.

## 6. O que nunca vai para log ou disco

- IP.
- URL (que carrega o bilhete).
- User agent e cabeçalhos.
- `instance_id`.
- IDs do Discord.
- O conteúdo das mensagens.

O log só aceita os campos `event`, `kind`, `code`, `reason`, `status`, `received`, `closed` e `port`.
