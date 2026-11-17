# Deploy: servidor 0.4.0 (salas de relay da F3c)

> **Pré-requisito:** o merge deste PR, com o seu "pode". Use o **commit do merge** que eu informar no lugar de `<COMMIT>`.
>
> **O que muda na VM:** só o código do servidor (`/opt/bt3probe/dist`). Ele ganha a rota `/net/ws/relay` e as salas de dois aparelhos.
>
> **O que não muda:**
> - unidade systemd, Caddy (já repassa todo `/net/*`), DNS, firewall, URL Mapping;
> - banco, `limites.json`, `bt3probe-janela`, `bt3probe-limites`;
> - a página (a 0.6.0 vem em outro PR);
> - o eco da F3b continua igual.
>
> **A janela continua fechada.** Nada fica acessível até você rodar `bt3probe-janela abrir` no dia do teste.

## 1. Baixar e testar (na VM, como `ubuntu`)

```bash
cd ~/src/bt3-activity-probe
git fetch origin
git checkout --detach <COMMIT>
cd server/probe
npm ci
npm test
npm run build
```

O `npm test` deve passar **105 testes**. **Se algum falhar, pare aqui** e me mande a saída.

## 2. Guardar a versão atual e instalar

```bash
sudo rm -rf /opt/bt3probe/dist.anterior
sudo cp -a /opt/bt3probe/dist /opt/bt3probe/dist.anterior
sudo systemctl stop bt3probe
sudo rm -rf /opt/bt3probe/dist
sudo cp -r dist /opt/bt3probe/dist
sudo systemctl start bt3probe
```

A primeira linha apaga a cópia da 0.2.0. A cópia nova guarda a 0.3.0, que é a que está no ar agora.

## 3. Conferir

```bash
sudo bt3probe-limites mostrar
```

O esperado (igual a antes do deploy):
- `tetos em uso (origem: arquivo)`;
- `mensagens_por_segundo: 120`;
- `rajada_mensagens: 360`;
- `admissoes_por_dia: 60`;
- `mensagens_reservadas_por_dia: 300000`;
- `rede: fechada`.

## Se algo der errado

```bash
sudo systemctl stop bt3probe
sudo rm -rf /opt/bt3probe/dist
sudo cp -a /opt/bt3probe/dist.anterior /opt/bt3probe/dist
sudo systemctl start bt3probe
```

Volta à 0.3.0. Nenhum arquivo de configuração precisa mudar: a 0.4.0 não criou chave nova.
