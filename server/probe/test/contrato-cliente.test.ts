// Contrato cliente × servidor (F3a): o código de rede da página (apps/probe/src/tests/c-net.ts)
// contra o servidor REAL desta pasta, em 127.0.0.1. Prova que o formato da admissão, o bilhete, o
// upgrade, o eco e os códigos de recusa batem dos dois lados. Nada sai da máquina.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { probeHealth, WsOpenTest, type FetchLike, type WsCtor, type WsLike } from '../../../apps/probe/src/tests/c-net';
import { harness, ORIGIN, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

// No navegador quem põe o Origin é o próprio navegador; aqui o teste faz o papel dele.
const fetchWithOrigin = (origin: string): FetchLike => (url, init) =>
  fetch(url, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), origin } });

function wsWithOrigin(origin: string): WsCtor {
  return class {
    private ws: WebSocket;
    constructor(url: string) {
      this.ws = new WebSocket(url, { origin });
      this.ws.on('error', () => undefined); // a recusa chega como 'close' (como no navegador)
    }
    get readyState() {
      return this.ws.readyState;
    }
    send(d: string) {
      this.ws.send(d);
    }
    close(code?: number, reason?: string) {
      this.ws.close(code, reason);
    }
    addEventListener(type: 'open' | 'message' | 'error' | 'close', fn: (ev: { data?: unknown; code?: number }) => void) {
      if (type === 'open') this.ws.on('open', () => fn({}));
      if (type === 'message') this.ws.on('message', (d: Buffer, bin: boolean) => fn({ data: bin ? d : d.toString() }));
      if (type === 'error') this.ws.on('unexpected-response', () => fn({}));
      // Recusa no upgrade: o navegador vê 1006; o ws (Node) entrega 'unexpected-response' e depois fecha.
      if (type === 'close') {
        this.ws.on('close', (code: number) => fn({ code }));
        this.ws.on('unexpected-response', (_req, res) => {
          res.resume();
          fn({ code: 1006 });
        });
      }
    }
  } as unknown as WsCtor;
}

const make = (port: number, origin = ORIGIN) =>
  ({
    test: new WsOpenTest({ fetch: fetchWithOrigin(origin), now: () => performance.now(), timeoutMs: 3000, WebSocket: wsWithOrigin(origin) }),
    bases: { httpBase: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` },
  });

describe('contrato cliente (página) × servidor (VM)', () => {
  it('health real é reconhecido pelo cliente (aberto e fechado)', async () => {
    h = await harness({ open: false });
    const deps = { fetch: fetchWithOrigin(ORIGIN), now: () => performance.now(), timeoutMs: 3000 };
    const closed = await probeHealth(deps, 'relativo', `http://127.0.0.1:${h.port}/net/health`);
    expect(closed).toMatchObject({ json_ok: true, server_open: false, http_status: 200, error: null });
    h.open();
    const open = await probeHealth(deps, 'relativo', `http://127.0.0.1:${h.port}/net/health`);
    expect(open).toMatchObject({ json_ok: true, server_open: true });
  });

  it('janela aberta: 5 de 5 abertas com eco → AP; reservas devolvidas e nenhuma sessão presa', async () => {
    h = await harness();
    const { test, bases } = make(h.port);
    await test.run(bases);
    const r = test.result();
    expect(r).toMatchObject({ status: 'AP', opened: 5, echoed: 5, window_open: true });
    expect(r.attempts.every((a) => a.admit_status === 201 && a.close_code === 1000 && !a.closed_by_server)).toBe(true);
    await new Promise((res) => setTimeout(res, 100));
    const st = h.server.budget.stats(h.clock.now());
    expect(st).toMatchObject({ admissions: 5, active: 0, reserved_msgs: 5 }); // 1 mensagem usada por sessão; o resto voltou
    const rows = h.db.raw.prepare('SELECT duration_ms, used_msgs, ended_at IS NOT NULL AS ended FROM sessions').all();
    expect(rows).toHaveLength(5);
    expect(rows.every((x) => (x as { duration_ms: number }).duration_ms === 5000 && (x as { ended: number }).ended === 1)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{32}/);
  });

  it('janela fechada: INV e nenhuma admissão gasta', async () => {
    h = await harness({ open: false });
    const { test, bases } = make(h.port);
    await test.run(bases);
    expect(test.result()).toMatchObject({ status: 'INV', window_open: false, attempts: [] });
    expect(h.server.budget.stats(h.clock.now()).admissions).toBe(0);
  });

  it('origem não permitida: a admissão é recusada com 403 e o cliente explica "origem"', async () => {
    h = await harness();
    const { test, bases } = make(h.port, 'https://evil.example');
    await test.run(bases);
    const r = test.result();
    expect(r.status).toBe('RP');
    expect(r.attempts[0]).toMatchObject({ admit_status: 403, failed_stage: 'admissao' });
    expect(r.detail).toContain('origem');
    expect(h.server.budget.stats(h.clock.now()).admissions).toBe(0);
  });

  it('limite do dia no meio do teste: o cliente para no 429 e dá INV (não gasta à toa)', async () => {
    h = await harness({ limits: { maxAdmissionsPerDay: 3 } });
    const { test, bases } = make(h.port);
    await test.run(bases);
    const r = test.result();
    expect(r.status).toBe('INV');
    expect(r.attempts.map((a) => a.admit_status)).toEqual([201, 201, 201, 429]);
    expect(r.opened).toBe(3);
  });

  it('upgrade recusado pelo servidor (bilhete aceito na admissão, mas janela fechou antes do WebSocket) → etapa "upgrade"', async () => {
    h = await harness();
    // Fecha a janela assim que a 1ª admissão for concedida: o upgrade recebe HTTP 503.
    const origFetch = fetchWithOrigin(ORIGIN);
    let closedAfterFirst = false;
    const fetchClosing: FetchLike = async (url, init) => {
      const res = await origFetch(url, init);
      if (url.endsWith('/net/session') && !closedAfterFirst) {
        closedAfterFirst = true;
        h!.windowText.value = null;
        h!.server.window.reload();
      }
      return res;
    };
    const test = new WsOpenTest({ fetch: fetchClosing, now: () => performance.now(), timeoutMs: 3000, WebSocket: wsWithOrigin(ORIGIN) });
    await test.run({ httpBase: `http://127.0.0.1:${h.port}`, wsBase: `ws://127.0.0.1:${h.port}` });
    const r = test.result();
    expect(r.attempts[0]).toMatchObject({ admit_status: 201, failed_stage: 'upgrade', open_ok: false, close_code: 1006 });
    expect(r.attempts[1]).toMatchObject({ admit_status: 503, failed_stage: 'admissao' }); // e para aqui
    expect(r.status).toBe('INV');
  });
});

// Garante que o tipo do wrapper bate com a interface usada pelo cliente.
const _check: WsLike | null = null;
void _check;
