# Deploy: servidor 0.3.0 (rajada separada da taxa média)

> **Pré-requisito:** o merge deste PR, com o seu "pode". Use o **commit do merge** que eu informar no lugar de `<COMMIT>`.
>
> **O que muda na VM:**
> - só o código do servidor (`/opt/bt3probe/dist`);
> - o script `bt3probe-limites` (ganha a chave `rajada_mensagens`, e o `mostrar` passa a esperar o serviço subir).
>
> **O que não muda:** unidade systemd, Caddy, DNS, firewall, URL Mapping, banco, `bt3probe-janela`, a página.
>
> **Depois do deploy,** a taxa volta ao padrão (120/s em média) e a rajada fica em 360 (cobre um engasgo de rede de cerca de 6 s a 60 Hz).

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

O `npm test` deve passar todos os testes (cerca de 91). **Se algum falhar, pare aqui** e me mande a saída.

## 2. Guardar a versão atual e instalar

```bash
sudo rm -rf /opt/bt3probe/dist.anterior
sudo cp -a /opt/bt3probe/dist /opt/bt3probe/dist.anterior
sudo systemctl stop bt3probe
sudo rm -rf /opt/bt3probe/dist
sudo cp -r dist /opt/bt3probe/dist
sudo install -m 0755 ops/bt3probe-limites /usr/local/sbin/bt3probe-limites
sudo systemctl start bt3probe
```

A primeira linha apaga a cópia da versão 0.1.0. A cópia nova guarda a 0.2.0, que é a que está no ar agora.

## 3. Voltar a taxa ao padrão e conferir

```bash
sudo bt3probe-limites remover mensagens_por_segundo
```

O esperado no fim:
- `tetos em uso (origem: arquivo)`;
- `mensagens_por_segundo: 120`;
- **`rajada_mensagens: 360`**;
- `admissoes_por_dia: 60`;
- `mensagens_reservadas_por_dia: 300000`;
- `rede: fechada`.

## Se algo der errado

```bash
sudo systemctl stop bt3probe
sudo rm -rf /opt/bt3probe/dist
sudo cp -a /opt/bt3probe/dist.anterior /opt/bt3probe/dist
sudo bt3probe-limites definir mensagens_por_segundo 240
sudo systemctl start bt3probe
```

Volta à 0.2.0 com a taxa de 240/s, que é a situação de hoje. A 0.2.0 não conhece `rajada_mensagens`; enquanto essa chave não estiver no arquivo, isso não causa problema.
