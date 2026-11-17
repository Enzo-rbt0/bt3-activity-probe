// Cartão "Rede (F3a)". N-PATH e N-HTTP rodam sozinhos ao abrir (só leitura: GET /net/health);
// N-WS-OPEN só roda quando a pessoa aperta o botão, porque gasta 5 das 30 admissões diárias do servidor.
import type { Tests } from './report/types';
import {
  basesFor, ECHO_SESSION_S, httpResult, pathResult, runPathChecks, WS_ATTEMPTS, WsOpenTest,
  type FetchLike, type Mode, type PathRun, type WsCtor,
} from './tests/c-net';

type NetKeys = 'N-HTTP' | 'N-PATH' | 'N-WS-OPEN';
export type NetResults = Pick<Tests, NetKeys>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

export function mountNet(root: HTMLElement, mode: Mode, onChange: () => void): () => NetResults {
  const deps = {
    fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as FetchLike,
    now: () => performance.now(),
  };
  let run: PathRun | null = null;
  let checking = false;
  const ws = new WsOpenTest({ ...deps, WebSocket: WebSocket as unknown as WsCtor });

  const card = el('div', { class: 'icard', id: 'card-NET' });
  const head = el('div', { class: 'icard-head' });
  head.append(el('h3', {}, 'Conexão com o servidor (N-HTTP · N-PATH · N-WS-OPEN)'), el('span', { class: 'chip', id: 'chip-NET' }, '—'));
  const ol = el('ol', { class: 'steps' });
  for (const s of [
    'A verificação do caminho até o servidor roda sozinha ao abrir a página (N-HTTP e N-PATH).',
    `O teste de conexões (N-WS-OPEN) só funciona com a rede ABERTA no servidor. Ele abre ${WS_ATTEMPTS} sessões curtas (${ECHO_SESSION_S} s cada) e gasta ${WS_ATTEMPTS} das 30 admissões do dia.`,
    'Faça uma vez por ambiente (Desktop, Web, celular, fora do Discord) e baixe ou copie o relatório no fim.',
  ]) ol.append(el('li', {}, s));
  const live = el('p', { class: 'live', id: 'live-NET' });
  const buttons = el('div', { class: 'buttons' });
  const recheck = el('button', { type: 'button', class: 'secondary' }, 'Repetir verificação');
  const start = el('button', { type: 'button' }, `Testar ${WS_ATTEMPTS} conexões`);
  const skip = el('button', { type: 'button', class: 'secondary' }, 'Pular');
  buttons.append(start, recheck, skip);
  card.append(head, ol, live, buttons);
  root.append(card);

  const results = (): NetResults => ({
    'N-HTTP': httpResult(run, mode),
    'N-PATH': pathResult(run, mode),
    'N-WS-OPEN': ws.result(),
  });

  const show = () => {
    const r = results();
    const busy = checking || ws.isRunning();
    start.disabled = recheck.disabled = skip.disabled = busy;
    live.textContent = `Servidor: ${r['N-HTTP'].status} · Caminho: ${r['N-PATH'].status} · Conexões: ${r['N-WS-OPEN'].status} — ${r['N-WS-OPEN'].detail}`;
    const chip = document.getElementById('chip-NET');
    if (chip) chip.textContent = checking ? 'verificando…' : ws.isRunning() ? 'testando…' : r['N-WS-OPEN'].status;
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

  void check();
  return results;
}
