// Cartões de rede.
//   F3a · N-PATH e N-HTTP rodam sozinhos ao abrir (só leitura: GET /net/health); N-WS-OPEN só roda
//         quando a pessoa aperta o botão, porque gasta 5 admissões do dia no servidor.
//   F3b · N-ECHO (eco contínuo de 62 s a 60 Hz) só roda depois de uma confirmação explícita: gasta
//         1 admissão e reserva ~4.290 mensagens. Durante a medição a página só atualiza o progresso
//         (a tabela e o JSON ficam para o fim), para não disputar a thread com o agendador de envio.
//   F3c · N-RELAY: dois aparelhos numa sala do servidor, pareados por código curto. Cada um gasta 1
//         admissão. O código aparece só na tela (nunca no relatório).
import type { Tests } from './report/types';
import { EchoTest, ECHO_CONFIG, reservedFor, sessionSeconds } from './tests/c-echo';
import { joinWindowMs, RELAY_CONFIG, relayReserve, RelayTest } from './tests/c-relay';
import {
  basesFor, ECHO_SESSION_S, httpResult, pathResult, runPathChecks, WS_ATTEMPTS, WsOpenTest,
  type FetchLike, type Mode, type NetRoute, type PathRun, type WsCtor,
} from './tests/c-net';

type NetKeys = 'N-HTTP' | 'N-PATH' | 'N-WS-OPEN' | 'N-ECHO' | 'N-RELAY';
export type NetResults = Pick<Tests, NetKeys>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

type WakeNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };

export function mountNet(root: HTMLElement, mode: Mode, onChange: () => void): () => NetResults {
  const deps = {
    fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as FetchLike,
    now: () => performance.now(),
  };
  let run: PathRun | null = null;
  let checking = false;
  const ws = new WsOpenTest({ ...deps, WebSocket: WebSocket as unknown as WsCtor });
  const nav = navigator as WakeNav;
  const echo = new EchoTest({
    ...deps,
    WebSocket: WebSocket as unknown as WsCtor,
    wakeLock: nav.wakeLock ? () => nav.wakeLock!.request('screen') : undefined,
  });
  const relay = new RelayTest({
    ...deps,
    WebSocket: WebSocket as unknown as WsCtor,
    wakeLock: nav.wakeLock ? () => nav.wakeLock!.request('screen') : undefined,
  });

  // ---------- cartão F3a ----------
  const card = el('div', { class: 'icard', id: 'card-NET' });
  const head = el('div', { class: 'icard-head' });
  head.append(el('h3', {}, 'Conexão com o servidor (N-HTTP · N-PATH · N-WS-OPEN)'), el('span', { class: 'chip', id: 'chip-NET' }, '—'));
  const ol = el('ol', { class: 'steps' });
  for (const s of [
    'A verificação do caminho até o servidor roda sozinha ao abrir a página (N-HTTP e N-PATH).',
    `O teste de conexões (N-WS-OPEN) só funciona com a rede ABERTA no servidor. Ele abre ${WS_ATTEMPTS} sessões curtas (${ECHO_SESSION_S} s cada) e gasta ${WS_ATTEMPTS} admissões do dia.`,
    'Dentro do Discord, use “Copiar JSON” no fim (o download não funciona lá).',
  ]) ol.append(el('li', {}, s));
  const live = el('p', { class: 'live', id: 'live-NET' });
  const buttons = el('div', { class: 'buttons' });
  const recheck = el('button', { type: 'button', class: 'secondary' }, 'Repetir verificação');
  const start = el('button', { type: 'button' }, `Testar ${WS_ATTEMPTS} conexões`);
  const skip = el('button', { type: 'button', class: 'secondary' }, 'Pular');
  buttons.append(start, recheck, skip);
  card.append(head, ol, live, buttons);

  // ---------- cartão F3b ----------
  const total = (ECHO_CONFIG.warmupMs + ECHO_CONFIG.measureMs) / 1000;
  const reserve = reservedFor(sessionSeconds(total * 1000));
  const ecard = el('div', { class: 'icard', id: 'card-ECHO' });
  const ehead = el('div', { class: 'icard-head' });
  ehead.append(el('h3', {}, 'Eco contínuo (N-ECHO · F3b)'), el('span', { class: 'chip', id: 'chip-ECHO' }, '—'));
  const eol = el('ol', { class: 'steps' });
  for (const s of [
    `Precisa da rede ABERTA no servidor. Mede ${total} s seguidos (${ECHO_CONFIG.warmupMs / 1000} s de aquecimento + ${ECHO_CONFIG.measureMs / 1000} s) a ${ECHO_CONFIG.hz} mensagens por segundo.`,
    'Deixe esta tela aberta e na frente o tempo todo. No celular, deixe o tempo de tela em 2 min ou mais. Se a página for escondida, o resultado fica INV.',
    `Gasta 1 admissão e reserva ${reserve.toLocaleString('pt-BR')} mensagens do dia (a sobra volta no fim).`,
    'Alterne: Discord → fora do Discord → Discord…, no mesmo aparelho e na mesma rede, com o mesmo rótulo do par.',
  ]) eol.append(el('li', {}, s));
  const labelWrap = el('label', { class: 'pair' }, 'Rótulo do par (ex.: PC-1, S26-2): ');
  const pair = el('input', { type: 'text', maxlength: '40', id: 'echo-pair', autocomplete: 'off' });
  labelWrap.append(pair);
  const elive = el('p', { class: 'live', id: 'live-ECHO' });
  const ebuttons = el('div', { class: 'buttons' });
  const measure = el('button', { type: 'button', id: 'echo-start' }, `Medir ${ECHO_CONFIG.measureMs / 1000} s`);
  const confirm = el('button', { type: 'button', id: 'echo-confirm', hidden: '' }, 'Confirmar: medir agora');
  const cancel = el('button', { type: 'button', class: 'secondary', id: 'echo-cancel', hidden: '' }, 'Cancelar');
  const stop = el('button', { type: 'button', class: 'secondary', id: 'echo-stop', disabled: '' }, 'Parar');
  ebuttons.append(measure, confirm, cancel, stop);
  ecard.append(ehead, eol, labelWrap, elive, ebuttons);

  // ---------- cartão F3c ----------
  const rtotal = (RELAY_CONFIG.warmupMs + RELAY_CONFIG.measureMs) / 1000;
  const joinS = Math.round(joinWindowMs() / 1000);
  const rcard = el('div', { class: 'icard', id: 'card-RELAY' });
  const rhead = el('div', { class: 'icard-head' });
  rhead.append(el('h3', {}, 'Relay entre dois aparelhos (N-RELAY · F3c)'), el('span', { class: 'chip', id: 'chip-RELAY' }, '—'));
  const rol = el('ol', { class: 'steps' });
  for (const s of [
    'Precisa da rede ABERTA no servidor e de DOIS aparelhos com esta página aberta (dentro ou fora do Discord).',
    `Num aparelho, aperte “Criar sala” e passe o código ao outro (pela chamada ou pelo chat). O outro tem até ${Math.floor(joinS / 60)} min ${joinS % 60} s para digitar o código e apertar “Entrar”.`,
    `Com os dois dentro, a medição começa sozinha: ${RELAY_CONFIG.pings} pings, ${rtotal} s de quadros a ${RELAY_CONFIG.hz} por segundo e mais ${RELAY_CONFIG.pings} pings (cerca de 75 s). Deixe a tela aberta e na frente nos DOIS aparelhos.`,
    `Cada aparelho gasta 1 admissão e reserva ${relayReserve().toLocaleString('pt-BR')} mensagens do dia (a sobra volta no fim). Cada um gera o próprio relatório: copie o JSON dos dois.`,
  ]) rol.append(el('li', {}, s));
  const rlabelWrap = el('label', { class: 'pair' }, 'Rótulo do par (ex.: PC-S26-1): ');
  const rpair = el('input', { type: 'text', maxlength: '40', id: 'relay-pair', autocomplete: 'off' });
  rlabelWrap.append(rpair);
  const codeBox = el('p', { class: 'room-code', id: 'relay-code', hidden: '', 'aria-live': 'polite' });
  const rlive = el('p', { class: 'live', id: 'live-RELAY' });
  const rbuttons = el('div', { class: 'buttons' });
  const create = el('button', { type: 'button', id: 'relay-create' }, 'Criar sala');
  const rstop = el('button', { type: 'button', class: 'secondary', id: 'relay-stop', disabled: '' }, 'Parar');
  rbuttons.append(create, rstop);
  const joinRow = el('div', { class: 'join' });
  const codeIn = el('input', { type: 'text', maxlength: '7', id: 'relay-code-in', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'K7Q-4MD', 'aria-label': 'Código da sala' });
  const join = el('button', { type: 'button', id: 'relay-join' }, 'Entrar');
  joinRow.append(el('span', {}, 'Ou entre na sala do outro aparelho: '), codeIn, join);
  rcard.append(rhead, rol, rlabelWrap, rbuttons, codeBox, rlive, joinRow);
  root.append(card, ecard, rcard);

  const results = (): NetResults => ({
    'N-HTTP': httpResult(run, mode),
    'N-PATH': pathResult(run, mode),
    'N-WS-OPEN': ws.result(),
    'N-ECHO': echo.result(),
    'N-RELAY': relay.result(),
  });

  const echoProgress = () => {
    const p = echo.progress();
    elive.textContent =
      p.elapsed_s === 0 && p.sent === 0
        ? 'Conectando…'
        : `Medindo… ${p.elapsed_s} de ${p.total_s} s · enviados ${p.sent} · eco ${p.received}${p.p50 !== null ? ` · RTT p50 até agora ${p.p50} ms` : ''}`;
  };

  const relayProgress = () => {
    const p = relay.progress();
    codeBox.hidden = p.phase !== 'sala' || p.code === null;
    if (p.phase === 'sala' && p.code !== null) codeBox.textContent = p.code;
    const left = p.join_left_s ?? 0;
    const texts: Record<string, string> = {
      parado: '',
      conectando: 'Conectando ao servidor…',
      sala: `Passe este código para o outro aparelho. Tempo para ele entrar: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`,
      pings: `Par encontrado! Medindo o RTT até o servidor (${p.pings} de ${RELAY_CONFIG.pings})…`,
      pronto: 'Esperando o outro aparelho ficar pronto…',
      medindo: `Medindo… ${p.elapsed_s} de ${p.total_s} s · enviados ${p.sent} · recebidos do outro ${p.received}`,
      finalizando: `Medindo o RTT de novo (${p.pings} de ${RELAY_CONFIG.pings})…`,
    };
    rlive.textContent = texts[p.phase] ?? '';
    const rchip = document.getElementById('chip-RELAY');
    const chipText: Record<string, string> = { conectando: 'conectando…', sala: 'esperando…', pings: 'preparando…', pronto: 'preparando…', medindo: 'medindo…', finalizando: 'finalizando…' };
    if (rchip && relay.isRunning()) rchip.textContent = chipText[p.phase] ?? 'em andamento…';
  };
  let relayTimer: ReturnType<typeof setInterval> | null = null;

  const show = () => {
    const r = results();
    const busy = checking || ws.isRunning() || echo.isRunning() || relay.isRunning();
    start.disabled = recheck.disabled = skip.disabled = measure.disabled = busy;
    create.disabled = join.disabled = codeIn.disabled = rpair.disabled = busy;
    rstop.disabled = !relay.isRunning();
    stop.disabled = !echo.isRunning();
    pair.disabled = echo.isRunning();
    live.textContent = `Servidor: ${r['N-HTTP'].status} · Caminho: ${r['N-PATH'].status} · Conexões: ${r['N-WS-OPEN'].status} — ${r['N-WS-OPEN'].detail}`;
    const chip = document.getElementById('chip-NET');
    if (chip) chip.textContent = checking ? 'verificando…' : ws.isRunning() ? 'testando…' : r['N-WS-OPEN'].status;
    const echip = document.getElementById('chip-ECHO');
    if (echip) echip.textContent = echo.isRunning() ? 'medindo…' : r['N-ECHO'].status;
    if (echo.isRunning()) echoProgress();
    else elive.textContent = `${r['N-ECHO'].status} — ${r['N-ECHO'].detail}`;
    const rchip = document.getElementById('chip-RELAY');
    if (rchip) {
      const ph = relay.progress().phase;
      const chipText: Record<string, string> = { conectando: 'conectando…', sala: 'esperando…', pings: 'preparando…', pronto: 'preparando…', medindo: 'medindo…', finalizando: 'finalizando…' };
      rchip.textContent = relay.isRunning() ? chipText[ph] ?? 'em andamento…' : r['N-RELAY'].status;
    }
    if (relay.isRunning()) relayProgress();
    else {
      codeBox.hidden = true;
      rlive.textContent = `${r['N-RELAY'].status} — ${r['N-RELAY'].detail}`;
    }
    onChange();
  };

  const check = async () => {
    checking = true;
    show();
    try {
      run = await runPathChecks(deps, mode, window.location.origin);
    } finally {
      checking = false;
      show();
    }
  };

  recheck.addEventListener('click', () => void check());
  start.addEventListener('click', async () => {
    if (!run) await check();
    const prefix = pathResult(run, mode).working_prefix;
    await ws.run(basesFor(mode, window.location, prefix), show);
  });
  skip.addEventListener('click', () => {
    ws.skip();
    show();
  });

  // Confirmação em dois passos (sem window.confirm: diálogos podem ser bloqueados dentro do Discord).
  const confirming = (on: boolean) => {
    measure.hidden = on;
    confirm.hidden = cancel.hidden = !on;
  };
  measure.addEventListener('click', () => confirming(true));
  cancel.addEventListener('click', () => confirming(false));
  confirm.addEventListener('click', async () => {
    confirming(false);
    if (!run) await check();
    const prefix = pathResult(run, mode).working_prefix;
    const route: NetRoute = mode === 'standalone' ? 'absoluto' : prefix === '/.proxy' ? 'proxy' : 'relativo';
    echo.setPairLabel(pair.value);
    // Durante a medição só o progresso é atualizado (sem refazer tabela e JSON a cada 0,5 s).
    const p = echo.run(basesFor(mode, window.location, prefix), route, () => (echo.isRunning() ? (echoProgress(), (stop.disabled = false)) : undefined));
    show();
    await p;
    show();
  });
  stop.addEventListener('click', () => echo.stop());

  const runRelay = async (how: { create: true } | { join: string }) => {
    if (!run) await check();
    const prefix = pathResult(run, mode).working_prefix;
    const route: NetRoute = mode === 'standalone' ? 'absoluto' : prefix === '/.proxy' ? 'proxy' : 'relativo';
    relay.setPairLabel(rpair.value);
    // Como no eco: durante a medição só o texto de progresso muda (1 vez por segundo).
    const p = relay.run(basesFor(mode, window.location, prefix), route, how, () => (relay.isRunning() ? relayProgress() : undefined));
    show();
    relayTimer = setInterval(relayProgress, 1000);
    try {
      await p;
    } finally {
      if (relayTimer !== null) clearInterval(relayTimer);
      relayTimer = null;
      codeIn.value = '';
      show();
    }
  };
  create.addEventListener('click', () => void runRelay({ create: true }));
  join.addEventListener('click', () => void runRelay({ join: codeIn.value }));
  codeIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !join.disabled) void runRelay({ join: codeIn.value });
  });
  rstop.addEventListener('click', () => relay.stop());
  rpair.addEventListener('input', () => {
    if (!relay.isRunning()) relay.setPairLabel(rpair.value);
    onChange();
  });
  pair.addEventListener('input', () => {
    if (!echo.isRunning()) echo.setPairLabel(pair.value);
    onChange();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      echo.noteHidden();
      relay.noteHidden();
    }
  });
  window.addEventListener('blur', () => {
    echo.noteBlur();
    relay.noteBlur();
  });

  void check();
  return results;
}
