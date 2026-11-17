// F3a: conectividade da Activity com o servidor da sonda (plano F3, seção 4).
//   N-PATH     · Dentro do Discord, por qual caminho o URL Mapping chega ao servidor: "/net/…",
//                "/.proxy/net/…" e o endereço absoluto (este último deve ser barrado pela CSP do
//                Discord; serve de controle). Fora do Discord: SKIP.
//   N-HTTP     · GET /net/health pelo caminho que a sonda vai usar (proxy do Discord dentro dele;
//                endereço direto fora).
//   N-WS-OPEN  · 5 sessões de eco seguidas: admissão (POST /net/session) → WebSocket aberto em até
//                5 s → 1 mensagem de eco → fechamento. AP = 5 de 5; INV = 1 a 4; RP = nenhuma.
// Nada daqui guarda bilhete, ID de sessão, IP ou cabeçalho: só códigos, tempos e categorias de erro.
// A lógica recebe fetch, WebSocket e relógio por parâmetro, para ser testada sem rede.
import type { Basic } from '../report/types';
import { SERVER_HOST, SERVER_ORIGIN, SERVER_REGION } from '../net-config';

export const NET_TIMEOUT_MS = 5000;
export const WS_ATTEMPTS = 5;
export const ECHO_SESSION_S = 5; // reserva pequena: 5 s × 60 Hz × 1,1 = 330 mensagens por sessão
const ECHO_PAYLOAD = 'bt3probe-eco';

// O servidor da F3-0 devolve o eco como mensagem BINÁRIA mesmo quando recebe texto (ws.send(Buffer)).
// Com binaryType = 'arraybuffer', o navegador entrega bytes; aqui texto e bytes são comparados pelo
// conteúdo. (Achado pelo teste de contrato com o servidor real.)
export function echoText(d: unknown): string | null {
  if (typeof d === 'string') return d;
  if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
  if (ArrayBuffer.isView(d)) return new TextDecoder().decode(d);
  return null;
}
const TICKET_RE = /^[0-9a-f]{32}$/;

export type NetRoute = 'relativo' | 'proxy' | 'absoluto';
export type NetError = 'tempo' | 'rede' | 'http' | 'json';

export interface RouteProbe {
  route: NetRoute;
  tested: boolean;
  http_status: number | null;
  json_ok: boolean;
  server_open: boolean | null;
  ms: number | null;
  error: NetError | null;
}

export interface NetHttpResult extends Basic {
  route: NetRoute | null;
  http_status: number | null;
  json_ok: boolean;
  server_open: boolean | null;
  ms: number | null;
  error: NetError | null;
  server_host: string;
  server_region: string;
}

export interface NetPathResult extends Basic {
  routes: RouteProbe[];
  working_prefix: '' | '/.proxy' | null;
}

export type WsStage = 'janela' | 'admissao' | 'upgrade' | 'eco';
export interface WsAttempt {
  n: number;
  admit_status: number | null;
  open_ok: boolean;
  open_ms: number | null;
  echo_ok: boolean;
  echo_ms: number | null;
  close_code: number | null;
  closed_by_server: boolean;
  failed_stage: WsStage | null;
  error: string | null;
}
export interface NetWsOpenResult extends Basic {
  ran: boolean;
  window_open: boolean | null;
  attempts: WsAttempt[];
  opened: number;
  echoed: number;
}

// ---------- dependências injetáveis ----------
export interface ResponseLike { status: number; ok: boolean; text(): Promise<string> }
export type FetchLike = (url: string, init?: RequestInit) => Promise<ResponseLike>;
export interface WsLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', fn: (ev: { data?: unknown; code?: number }) => void): void;
}
export type WsCtor = new (url: string) => WsLike;
export interface NetDeps { fetch: FetchLike; now: () => number; timeoutMs?: number }

export type Mode = 'discord' | 'standalone';

export function healthUrl(route: NetRoute, pageOrigin: string): string {
  if (route === 'absoluto') return `${SERVER_ORIGIN}/net/health`;
  return `${pageOrigin}${route === 'proxy' ? '/.proxy' : ''}/net/health`;
}

export async function probeHealth(deps: NetDeps, route: NetRoute, url: string): Promise<RouteProbe> {
  const t0 = deps.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? NET_TIMEOUT_MS);
  const base: RouteProbe = { route, tested: true, http_status: null, json_ok: false, server_open: null, ms: null, error: null };
  try {
    const res = await deps.fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    const text = await res.text();
    const ms = Math.round(deps.now() - t0);
    if (!res.ok) return { ...base, http_status: res.status, ms, error: 'http' };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ...base, http_status: res.status, ms, error: 'json' };
    }
    const b = body as { aberto?: unknown; tetos?: unknown } | null;
    const ok = !!b && typeof b === 'object' && typeof b.aberto === 'boolean' && !!b.tetos && typeof b.tetos === 'object';
    return { ...base, http_status: res.status, ms, json_ok: ok, server_open: ok ? (b!.aberto as boolean) : null, error: ok ? null : 'json' };
  } catch {
    // TypeError de fetch: rede, DNS, TLS, CORS ou CSP (o navegador não diz qual, de propósito).
    return { ...base, ms: Math.round(deps.now() - t0), error: ctrl.signal.aborted ? 'tempo' : 'rede' };
  } finally {
    clearTimeout(timer);
  }
}

const untested = (route: NetRoute): RouteProbe => ({ route, tested: false, http_status: null, json_ok: false, server_open: null, ms: null, error: null });

export interface PathRun { routes: RouteProbe[] }

export async function runPathChecks(deps: NetDeps, mode: Mode, pageOrigin: string): Promise<PathRun> {
  const routes: RouteProbe[] = [];
  for (const route of ['relativo', 'proxy', 'absoluto'] as const) {
    if (mode === 'standalone' && route !== 'absoluto') {
      routes.push(untested(route));
      continue;
    }
    routes.push(await probeHealth(deps, route, healthUrl(route, pageOrigin)));
  }
  return { routes };
}

const ERR_TXT: Record<NetError, string> = {
  tempo: 'sem resposta em 5 s',
  rede: 'bloqueado ou sem conexão (rede, CORS ou CSP)',
  http: 'resposta HTTP de erro',
  json: 'respondeu, mas não é o servidor da sonda',
};

function describe(p: RouteProbe): string {
  if (!p.tested) return 'não testado';
  if (p.json_ok) return `ok (${p.ms} ms)`;
  return `${ERR_TXT[p.error ?? 'rede']}${p.http_status !== null ? ` [HTTP ${p.http_status}]` : ''}`;
}

export function pathResult(run: PathRun | null, mode: Mode): NetPathResult {
  if (!run) return { status: 'SKIP', detail: 'verificando…', routes: [], working_prefix: null };
  const by = (r: NetRoute) => run.routes.find((x) => x.route === r)!;
  const rel = by('relativo');
  const prx = by('proxy');
  const abs = by('absoluto');
  if (mode === 'standalone') {
    return { status: 'SKIP', detail: `Só faz sentido dentro do Discord (URL Mapping). Direto: ${describe(abs)}.`, routes: run.routes, working_prefix: null };
  }
  const control = abs.json_ok ? ' Atenção: o endereço direto também respondeu (a CSP não barrou).' : '';
  if (rel.json_ok) {
    return { status: 'AP', detail: `URL Mapping funciona em /net/… (${rel.ms} ms).${control}`, routes: run.routes, working_prefix: '' };
  }
  if (prx.json_ok) {
    return { status: 'AP', detail: `Funciona só com /.proxy/net/… (${prx.ms} ms); /net/…: ${describe(rel)}.${control}`, routes: run.routes, working_prefix: '/.proxy' };
  }
  const hint =
    rel.http_status === 404 || prx.http_status === 404
      ? ' Se o Discord tira o prefixo ao repassar, o alvo do mapeamento deve ser sonda.kingszin.com.br/net.'
      : ' Confira o URL Mapping /net no Developer Portal.';
  return {
    status: 'RP',
    detail: `Nenhum caminho pelo Discord chegou ao servidor. /net: ${describe(rel)}; /.proxy/net: ${describe(prx)}.${hint}`,
    routes: run.routes,
    working_prefix: null,
  };
}

export function httpResult(run: PathRun | null, mode: Mode): NetHttpResult {
  const base = { server_host: SERVER_HOST, server_region: SERVER_REGION };
  if (!run) {
    return { status: 'SKIP', detail: 'verificando…', route: null, http_status: null, json_ok: false, server_open: null, ms: null, error: null, ...base };
  }
  // Dentro do Discord, o caminho que a sonda usa é o do proxy (o direto é barrado pela CSP).
  const pick =
    mode === 'standalone'
      ? run.routes.find((r) => r.route === 'absoluto')!
      : (run.routes.find((r) => r.route === 'relativo' && r.json_ok) ?? run.routes.find((r) => r.route === 'proxy' && r.json_ok) ?? run.routes.find((r) => r.route === 'relativo')!);
  const fields = { route: pick.route, http_status: pick.http_status, json_ok: pick.json_ok, server_open: pick.server_open, ms: pick.ms, error: pick.error, ...base };
  if (pick.json_ok) {
    return { status: 'AP', detail: `Servidor respondeu em ${pick.ms} ms (${pick.route}); rede ${pick.server_open ? 'ABERTA' : 'fechada'} no servidor.`, ...fields };
  }
  return { status: 'RP', detail: `Sem resposta válida do servidor (${pick.route}): ${describe(pick)}.`, ...fields };
}

// ---------- N-WS-OPEN ----------
export interface Bases { httpBase: string; wsBase: string }

export function basesFor(mode: Mode, loc: { protocol: string; host: string; origin: string }, prefix: '' | '/.proxy' | null): Bases {
  if (mode === 'standalone') return { httpBase: SERVER_ORIGIN, wsBase: `wss://${SERVER_HOST}` };
  const p = prefix ?? '';
  return { httpBase: `${loc.origin}${p}`, wsBase: `${loc.protocol === 'http:' ? 'ws' : 'wss'}://${loc.host}${p}` };
}

type WaitResult = { kind: 'open' | 'message' | 'close' | 'error' | 'tempo'; data?: unknown; code?: number };

export class WsOpenTest {
  private attempts: WsAttempt[] = [];
  private ran = false;
  private skipped = false;
  private running = false;
  private windowOpen: boolean | null = null;
  private healthFailed: string | null = null;

  constructor(private deps: NetDeps & { WebSocket: WsCtor }) {}

  isRunning(): boolean {
    return this.running;
  }

  skip(): void {
    if (!this.running) this.skipped = true;
  }

  async run(bases: Bases, onProgress: () => void = () => {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.skipped = false;
    this.ran = true;
    this.attempts = [];
    this.windowOpen = null;
    this.healthFailed = null;
    try {
      const h = await probeHealth(this.deps, 'relativo', `${bases.httpBase}/net/health`);
      if (!h.json_ok) {
        this.healthFailed = describe(h);
        return;
      }
      this.windowOpen = h.server_open;
      if (!h.server_open) return;
      for (let n = 1; n <= WS_ATTEMPTS; n++) {
        this.attempts.push(await this.attempt(n, bases));
        onProgress();
        const last = this.attempts[this.attempts.length - 1]!;
        // Limite ou janela fechada no servidor: parar, para não gastar admissões à toa.
        if (last.failed_stage === 'admissao' && (last.admit_status === 429 || last.admit_status === 503)) break;
      }
    } finally {
      this.running = false;
      onProgress();
    }
  }

  private timeout(): number {
    return this.deps.timeoutMs ?? NET_TIMEOUT_MS;
  }

  private async attempt(n: number, bases: Bases): Promise<WsAttempt> {
    const a: WsAttempt = {
      n, admit_status: null, open_ok: false, open_ms: null, echo_ok: false, echo_ms: null,
      close_code: null, closed_by_server: false, failed_stage: null, error: null,
    };
    // 1) Admissão: bilhete de uso único. O bilhete só existe nesta função e não vai para o relatório.
    let ticket: string;
    {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout());
      try {
        const res = await this.deps.fetch(`${bases.httpBase}/net/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'echo', duration_s: ECHO_SESSION_S }),
          cache: 'no-store',
          credentials: 'omit',
          signal: ctrl.signal,
        });
        a.admit_status = res.status;
        const text = await res.text();
        if (res.status !== 201) {
          a.failed_stage = 'admissao';
          a.error = admitError(res.status);
          return a;
        }
        const b = JSON.parse(text) as { bilhete?: unknown };
        if (typeof b.bilhete !== 'string' || !TICKET_RE.test(b.bilhete)) throw new Error('bilhete inválido');
        ticket = b.bilhete;
      } catch (e) {
        a.failed_stage = 'admissao';
        a.error = ctrl.signal.aborted ? 'admissão sem resposta em 5 s' : `admissão falhou: ${e instanceof Error && e.message === 'bilhete inválido' ? 'resposta sem bilhete' : 'rede/CORS/CSP'}`;
        return a;
      } finally {
        clearTimeout(timer);
      }
    }

    // 2) Abertura do WebSocket, 3) eco, 4) fechamento.
    const t0 = this.deps.now();
    let ws: WsLike;
    try {
      ws = new this.deps.WebSocket(`${bases.wsBase}/net/ws/echo?bilhete=${ticket}`);
    } catch {
      a.failed_stage = 'upgrade';
      a.error = 'o navegador recusou criar o WebSocket (endereço ou CSP)';
      return a;
    }
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* implementações sem binaryType */
    }
    const queue: WaitResult[] = [];
    let waiter: ((r: WaitResult) => void) | null = null;
    const push = (r: WaitResult) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(r);
      } else queue.push(r);
    };
    let closed = false;
    ws.addEventListener('open', () => push({ kind: 'open' }));
    ws.addEventListener('message', (ev) => push({ kind: 'message', data: ev.data }));
    ws.addEventListener('error', () => push({ kind: 'error' }));
    ws.addEventListener('close', (ev) => {
      closed = true;
      a.close_code = typeof ev.code === 'number' ? ev.code : null;
      push({ kind: 'close', code: ev.code });
    });
    const next = (ms: number) =>
      new Promise<WaitResult>((resolve) => {
        const q = queue.shift();
        if (q) return resolve(q);
        const timer = setTimeout(() => {
          waiter = null;
          resolve({ kind: 'tempo' });
        }, ms);
        waiter = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
      });
    const finish = async () => {
      if (!closed) {
        try {
          ws.close(1000, 'fim');
        } catch {
          /* já fechando */
        }
        // Espera o fechamento confirmar (ou desiste em 2 s).
        const end = this.deps.now() + 2000;
        while (!closed && this.deps.now() < end) {
          const r = await next(Math.max(1, end - this.deps.now()));
          if (r.kind === 'tempo') break;
        }
      }
    };

    let ev = await next(this.timeout());
    while (ev.kind === 'error') ev = await next(this.timeout()); // o "close" vem logo depois do "error"
    if (ev.kind !== 'open') {
      a.failed_stage = 'upgrade';
      a.closed_by_server = ev.kind === 'close';
      a.error =
        ev.kind === 'tempo'
          ? 'WebSocket não abriu em 5 s'
          : `WebSocket recusado antes de abrir (código ${a.close_code ?? '—'}; o motivo HTTP não chega ao navegador)`;
      if (ev.kind === 'tempo') await finish();
      return a;
    }
    a.open_ms = Math.round(this.deps.now() - t0);
    // O limite de 5 s já é aplicado pela espera acima (sem "open" a tempo, a tentativa falha em "upgrade").
    a.open_ok = true;

    const tSend = this.deps.now();
    try {
      ws.send(ECHO_PAYLOAD);
    } catch {
      a.failed_stage = 'eco';
      a.error = 'falha ao enviar a mensagem';
      await finish();
      return a;
    }
    ev = await next(this.timeout());
    if (ev.kind === 'message' && echoText(ev.data) === ECHO_PAYLOAD) {
      a.echo_ok = true;
      a.echo_ms = Math.round(this.deps.now() - tSend);
      await finish();
      return a;
    }
    a.failed_stage = 'eco';
    if (ev.kind === 'close') {
      a.closed_by_server = true;
      a.error = `servidor fechou antes do eco (código ${a.close_code ?? '—'})`;
    } else if (ev.kind === 'message') {
      a.error = 'eco diferente do enviado';
    } else {
      a.error = 'eco não voltou em 5 s';
    }
    await finish();
    return a;
  }

  result(): NetWsOpenResult {
    const opened = this.attempts.filter((a) => a.open_ok).length;
    const echoed = this.attempts.filter((a) => a.echo_ok).length;
    const base = { ran: this.ran, window_open: this.windowOpen, attempts: this.attempts, opened, echoed };
    if (this.running) return { status: 'SKIP', detail: `em andamento (${this.attempts.length} de ${WS_ATTEMPTS})…`, ...base };
    if (this.skipped) return { status: 'SKIP', detail: 'pulado', ...base };
    if (!this.ran) return { status: 'SKIP', detail: 'ainda não feito (precisa da janela aberta no servidor)', ...base };
    if (this.healthFailed) return { status: 'RP', detail: `Servidor inacessível pelo caminho da sonda: ${this.healthFailed}.`, ...base };
    if (this.windowOpen === false) {
      return { status: 'INV', detail: 'Rede FECHADA no servidor: abra a janela pelo SSH (bt3probe-janela abrir) e repita.', ...base };
    }
    const stopped = this.attempts.find((a) => a.failed_stage === 'admissao' && (a.admit_status === 429 || a.admit_status === 503));
    if (stopped) {
      return { status: 'INV', detail: `Parado na tentativa ${stopped.n}: ${stopped.error}. Abertas: ${opened} de ${this.attempts.length}.`, ...base };
    }
    const firstFail = this.attempts.find((a) => !a.open_ok);
    const summary = `${opened} de ${WS_ATTEMPTS} abertas em até 5 s; eco em ${echoed}.`;
    if (opened === WS_ATTEMPTS) {
      const times = this.attempts.map((a) => a.open_ms ?? 0);
      return { status: 'AP', detail: `${summary} Abertura: ${Math.min(...times)}–${Math.max(...times)} ms.`, ...base };
    }
    const why = firstFail ? ` Primeira falha (${firstFail.failed_stage}): ${firstFail.error}.` : '';
    return { status: opened === 0 ? 'RP' : 'INV', detail: `${summary}${why}`, ...base };
  }
}

function admitError(status: number): string {
  if (status === 403) return 'admissão recusada (403): o servidor não reconheceu a origem da página';
  if (status === 429) return 'admissão recusada (429): limite do servidor (vagas, admissões ou mensagens do dia)';
  if (status === 503) return 'admissão recusada (503): rede fechada no servidor';
  if (status === 400) return 'admissão recusada (400): pedido inválido';
  return `admissão recusada (HTTP ${status})`;
}
