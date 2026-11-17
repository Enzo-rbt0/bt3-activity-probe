# Deploy: tetos configuráveis na VM (servidor 0.2.0)

> **Pré-requisito:** o merge deste PR, com o seu "pode". Use o **commit do merge** que eu informar no lugar de `<COMMIT>`.
>
> **O que muda na VM:**
> - o código do servidor (`/opt/bt3probe/dist`);
> - a unidade systemd (ganha uma linha: `BT3PROBE_LIMITS_FILE`);
> - o comando novo `bt3probe-limites`.
>
> **O que não muda:** Caddy, DNS, firewall, URL Mapping, banco de dados, `bt3probe-janela`, a página publicada.
>
> **Duração:** cerca de 10 minutos. O serviço fica parado por poucos segundos (passo 3). A janela de rede fica fechada o tempo todo.

## 1. Baixar e testar a versão nova (na VM, como `ubuntu`)

```bash
cd ~/src/bt3-activity-probe
git fetch origin
git checkout --detach <COMMIT>
cd server/probe
npm ci
npm test
npm run build
```

- O `npm test` deve terminar com **todos os testes passando** (por volta de 88), agora na própria VM ARM.
- **Se algum teste falhar, pare aqui** e me mande a saída. Nada foi alterado no serviço ainda.

## 2. Guardar a versão atual (para voltar, se precisar)

```bash
sudo cp -a /opt/bt3probe/dist /opt/bt3probe/dist.anterior
sudo cp -a /etc/systemd/system/bt3probe.service /etc/systemd/system/bt3probe.service.anterior
```

## 3. Instalar

```bash
sudo systemctl stop bt3probe
sudo rm -rf /opt/bt3probe/dist
sudo cp -r dist /opt/bt3probe/dist
sudo install -m 0644 ops/bt3probe.service /etc/systemd/system/bt3probe.service
sudo install -m 0755 ops/bt3probe-limites /usr/local/sbin/bt3probe-limites
sudo systemctl daemon-reload
sudo systemctl start bt3probe
```

As dependências (`ws`) não mudaram, então não é preciso rodar `npm ci` em `/opt/bt3probe`.

## 4. Conferir (ainda com os tetos padrão)

```bash
sudo bt3probe-limites mostrar
sudo journalctl -u bt3probe -n 5 --no-pager -o cat
```

O esperado:
- `sem arquivo: valem os tetos padrão do código`;
- `tetos em uso (origem: padrao)`, com `admissoes_por_dia: 30` e `mensagens_reservadas_por_dia: 60000`;
- `rede: fechada`;
- no log, `{"event":"limites","reason":"padrao"}` e depois `{"event":"start",...}`.

## 5. Aumentar os tetos

```bash
sudo bt3probe-limites definir mensagens_dia 300000
sudo bt3probe-limites definir admissoes_dia 60
```

Cada comando reinicia o serviço e mostra os tetos em uso. No fim deve aparecer:
- `tetos em uso (origem: arquivo)`;
- `admissoes_por_dia: 60` e `mensagens_reservadas_por_dia: 300000`;
- `rede: fechada`.

Confira também de fora:

```bash
curl -s https://sonda.kingszin.com.br/net/health; echo
```

## Se algo der errado: voltar à versão anterior

```bash
sudo systemctl stop bt3probe
sudo rm -rf /opt/bt3probe/dist
sudo cp -a /opt/bt3probe/dist.anterior /opt/bt3probe/dist
sudo cp -a /etc/systemd/system/bt3probe.service.anterior /etc/systemd/system/bt3probe.service
sudo rm -f /etc/bt3probe/limites.json
sudo systemctl daemon-reload
sudo systemctl start bt3probe
```

A versão anterior ignora o arquivo de tetos, mas ele é removido mesmo assim, para não ficar esquecido.

## Depois

Quando tudo estiver certo, a cópia de segurança pode ser apagada:

```bash
sudo rm -rf /opt/bt3probe/dist.anterior /etc/systemd/system/bt3probe.service.anterior
```

**Regras que continuam valendo:**
- a janela só abre pelo SSH, por você;
- mudar um teto reinicia o serviço e fecha a janela;
- um arquivo de tetos com erro faz o servidor voltar aos tetos padrão, nunca a tetos maiores.
