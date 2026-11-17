// Simuladores de servidor e WebSocket para os testes da F3a (não entram na build da página).
import type { FetchLike, ResponseLike, WsCtor, WsLike } from '../tests/c-net';

export const T = 40; // tempo-limite curto nos testes (o real é 5 s)
export const now = () => performance.now();
export const PAGE = 'https://1571332639812493522.discordsays.com';
export const HEALTH = (aberto: boolean) => JSON.stringify({ aberto, fecha_em: null, motivo: 'x', tetos: { sessoes_simultaneas: 4 }, uso_do_dia: {} });
export const TICKET = '0123456789abcdef0123456789abcdef';

export const res = (status: number, body: string): ResponseLike => ({ status, ok: status >= 200 && status < 300, text: async () => body });
export type Handler = (url: string, init?: RequestInit) => ResponseLike | 'falha' | 'trava';

export function fakeFetch(h: Handler): FetchLike & { calls: { url: string; method: string; body: string | null }[] } {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    const r = h(url, init);
    if (r === 'falha') throw new TypeError('Failed to fetch');
    if (r === 'trava') {
      return new Promise<ResponseLike>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')));
      });
    }
    return r;
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

// Servidor feliz: health aberto, admissão 201 com bilhete.
export const server = (over: Partial<Record<'health' | 'session', ResponseLike | 'falha' | 'trava'>> = {}): Handler => (url) => {
  if (url.endsWith('/net/health')) return over.health ?? res(200, HEALTH(true));
  if (url.endsWith('/net/session')) return over.session ?? res(201, JSON.stringify({ bilhete: TICKET, bilhete_vale_ate: 'x', duracao_s: 5, mensagens_reservadas: 330 }));
  return res(404, '{}');
};

export type Mode = 'ok' | 'eco-binario' | 'recusa' | 'trava' | 'fecha-4002' | 'eco-errado' | 'eco-mudo';
export function fakeWs(modes: Mode[] | Mode): WsCtor & { urls: string[]; closes: (number | undefined)[] } {
  const urls: string[] = [];
  const closes: (number | undefined)[] = [];
  let i = 0;
  class W implements WsLike {
    readyState = 0;
    binaryType = 'blob';
    private fns: Record<string, ((ev: { data?: unknown; code?: number }) => void)[]> = {};
    private mode: Mode;
    constructor(url: string) {
      urls.push(url);
      this.mode = Array.isArray(modes) ? modes[i++] ?? 'ok' : modes;
      setTimeout(() => {
        if (this.mode === 'recusa') {
          this.emit('error', {});
          this.emit('close', { code: 1006 });
        } else if (this.mode !== 'trava') {
          this.readyState = 1;
          this.emit('open', {});
        }
      }, 1);
    }
    addEventListener(type: string, fn: (ev: { data?: unknown; code?: number }) => void) {
      (this.fns[type] ??= []).push(fn);
    }
    private emit(type: string, ev: { data?: unknown; code?: number }) {
      for (const fn of this.fns[type] ?? []) fn(ev);
    }
    send(data: string) {
      setTimeout(() => {
        if (this.mode === 'fecha-4002') this.emit('close', { code: 4002 });
        else if (this.mode === 'eco-errado') this.emit('message', { data: 'outra coisa' });
        else if (this.mode === 'eco-binario') this.emit('message', { data: new TextEncoder().encode(data).buffer });
        else if (this.mode !== 'eco-mudo') this.emit('message', { data });
      }, 1);
    }
    close(code?: number) {
      closes.push(code);
      setTimeout(() => this.emit('close', { code: code ?? 1005 }), 1);
    }
  }
  const C = W as unknown as WsCtor & { urls: string[]; closes: (number | undefined)[] };
  C.urls = urls;
  C.closes = closes;
  return C;
}

