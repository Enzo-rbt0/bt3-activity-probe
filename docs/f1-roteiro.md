# Roteiro de teste da F1 (Discord Desktop)

Objetivo da F1: a Activity mínima abre dentro do Discord Desktop e gera o **primeiro relatório JSON válido**. Nada pesado roda nesta fase: só lê informações do ambiente e pinta 1 pixel com WebGL 2.

Quem faz: o usuário. Tempo estimado: 10 minutos.

## 0. Antes (uma vez)

1. O PR da F1 foi aprovado e o merge feito na `main`.
2. Em **GitHub → Actions**, o workflow **Publicar no GitHub Pages** terminou verde.
3. Abra no navegador do PC: https://enzo-rbt0.github.io/bt3-activity-probe/
   - Deve aparecer "Fora do Discord (modo standalone)" e "Relatório válido".
   - Isso é só a base de comparação (ADR-09): **não** prova nada sobre o Discord.

## 1. Configuração no Discord Developer Portal (aplicação `1571332639812493522`)

1. **Activities → URL Mappings:** prefixo `/` → `enzo-rbt0.github.io/bt3-activity-probe` (já feito).
2. **Activities → Settings:** "Enable Activities" ligado; em plataformas suportadas, marque **Desktop/Web** (Android fica para depois da F1).
3. **Installation:** deixe "Guild Install" disponível e use o link de instalação para adicionar a aplicação a um **servidor de teste seu** (de preferência um servidor só para isso, sem o bot da NBA).
   - Os nomes das telas do portal podem mudar um pouco; o essencial é: Activities ligadas, mapeamento `/` e aplicação instalada num servidor seu.

## 2. Rodar no Discord Desktop

1. Feche e abra o Discord Desktop (para ele ver a aplicação nova).
2. No servidor de teste, entre num canal de voz (ou abra um canal de texto) e clique no ícone de **Activities** (foguete) → escolha a aplicação.
3. A sonda abre. Em até 10 segundos a linha do topo deve dizer **"Dentro do Discord (desktop). SDK conectado."**
4. Preencha "Aparelho", "Sistema", "Rede" e "Em chamada de voz?".
5. Confira "Relatório válido (schema bt3probe.report/1)" em verde.
6. Clique **Baixar JSON**. Se nada acontecer (o Discord pode bloquear download dentro da Activity), clique **Copiar JSON** e cole num arquivo `.json`; se nem isso funcionar, selecione todo o texto da caixa e copie.

## 3. O que mandar de volta

- O arquivo JSON (ou o texto colado).
- Um print da tela da sonda dentro do Discord.
- Se algo falhou: o que apareceu na linha do topo.

## 4. Como ler o resultado

| Teste | AP (aprovado) | INV (inconclusivo) | RP (reprovado) |
|---|---|---|---|
| A-ENV | Handshake com o Discord concluído | — | A URL parecia do Discord, mas o SDK não respondeu em 10 s |
| A-GL2 | WebGL 2 desenha com placa de vídeo | WebGL 2 funciona, mas em software, ou o nome da placa ficou oculto | Sem WebGL 2, ou o desenho falhou |

## 5. Privacidade do relatório

- Nenhum ID ou nome de usuário.
- Servidor e canal aparecem só como `true`/`false` (`in_guild`, `in_channel`).
- A instância da Activity aparece só como hash de 12 caracteres (`instance_hash`).
- O schema rejeita qualquer campo a mais; um `user_id` ou `guild_id` deixa o relatório inválido.

## 6. Depois

A F1 termina aqui. **F2 (WebAssembly, controles, áudio, arquivo, Android) só começa com nova aprovação.**
