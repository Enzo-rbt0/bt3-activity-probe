// Cartões de rede.
//   F3a · N-PATH e N-HTTP rodam sozinhos ao abrir (só leitura: GET /net/health); N-WS-OPEN só roda
//         quando a pessoa aperta o botão, porque gasta 5 admissões do dia no servidor.
//   F3b · N-ECHO (eco contínuo de 62 s a 60 Hz) só roda depois de uma confirmação explícita: gasta
//         1 admissão e reserva ~4.290 mensagens. Durante a medição a página só atualiza o progresso
//         (a tabela e o JSON ficam para o fim), para não disputar a thread com o agendador de envio.
import type { Tests } from './report/types';
import { EchoTest, ECHO_CONFIG, reservedFor, sessionSeconds } from './tests/c-echo';
import {
  basesFor, ECHO_SESSION_S, httpResult, pathResult, runPathChecks, WS_ATTEMPTS, WsOpenTest,
  type FetchLike, type Mode, type NetRoute, type PathRun, type WsCtor,
} from './tests/c-net';

type NetKeys = 'N-HTTP' | 'N-PATH' | 'N-WS-OPEN' | 'N-ECHO';
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
  root.append(card, ecard);

  const results = (): NetResults => ({
    'N-HTTP': httpResult(run, mode),
    'N-PATH': pathResult(run, mode),
    'N-WS-OPEN': ws.result(),
    'N-ECHO': echo.result(),
  });

  const echoProgress = () => {
    const p = echo.progress();
    elive.textContent =
      p.elapsed_s === 0 && p.sent === 0
        ? 'Conectando…'
        : `Medindo… ${p.elapsed_s} de ${p.total_s} s · enviados ${p.sent} · eco ${p.received}${p.p50 !== null ? ` · RTT p50 até agora ${p.p50} ms` : ''}`;
  };

  const show = () => {
    const r = results();
    const busy = checking || ws.isRunning() || echo.isRunning();
    start.disabled = recheck.disabled = skip.disabled = measure.disabled = busy;
    stop.disabled = !echo.isRunning();
    pair.disabled = echo.isRunning();
    live.textContent = `Servidor: ${r['N-HTTP'].status} · Caminho: ${r['N-PATH'].status} · Conexões: ${r['N-WS-OPEN'].status} — ${r['N-WS-OPEN'].detail}`;
    const chip = document.getElementById('chip-NET');
    if (chip) chip.textContent = checking ? 'verificando…' : ws.isRunning() ? 'testando…' : r['N-WS-OPEN'].status;
    const echip = document.getElementById('chip-ECHO');
    if (echip) echip.textContent = echo.isRunning() ? 'medindo…' : r['N-ECHO'].status;
    if (echo.isRunning()) echoProgress();
    else elive.textContent = `${r['N-ECHO'].status} — ${r['N-ECHO'].detail}`;
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
  pair.addEventListener('input', () => {
    if (!echo.isRunning()) echo.setPairLabel(pair.value);
    onChange();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) echo.noteHidden();
  });
  window.addEventListener('blur', () => echo.noteBlur());

  void check();
  return results;
}
