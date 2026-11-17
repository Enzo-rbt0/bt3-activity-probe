// Relógio falso e servidor de eco simulado para os testes da F3b (não entram na build da página).
// O relógio controla o agendador do N-ECHO, os tempos de abertura e a latência de cada eco: 62 s de
// medição rodam em poucas centenas de milissegundos e com resultado exato.
import type { TimerLike } from '../tests/c-echo';
import type { WsCtor, WsLike } from '../tests/c-net';

const macrotask = () => new Promise<void>((r) => setImmediate(r));

export class FakeClock implements TimerLike {
  t = 1000;
  private seq = 0;
  private timers: { at: number; id: number; fn: () => void }[] = [];
  private stalls: { at: number; ms: number }[] = [];
  now = () => this.t;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), id, fn });
    return id;
  }
  clear(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  /** Simula a thread principal travada: o primeiro timer que disparar a partir de `at` atrasa `ms`. */
  stallAt(at: number, ms: number): void {
    this.stalls.push({ at, ms });
  }
  /** Roda timers em ordem até a promessa terminar (ou até `limitMs` de tempo simulado). */
  async runUntil(p: Promise<unknown>, limitMs = 200_000): Promise<void> {
    let done = false;
    void p.finally(() => (done = true));
    const end = this.t + limitMs;
    await macrotask();
    while (!done) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers.shift();
      if (!next) {
        await macrotask();
        if (!done && !this.timers.length) throw new Error('nada agendado e a execução não terminou');
        continue;
      }
      if (next.at > end) throw new Error('tempo simulado esgotado');
      this.t = Math.max(this.t, next.at);
      const stall = this.stalls.findIndex((s) => this.t >= s.at);
      if (stall >= 0) {
        this.t += this.stalls[stall]!.ms;
        this.stalls.splice(stall, 1);
      }
      next.fn();
      await macrotask();
    }
  }
}

export interface EchoServerOpts {
  openMs?: number;
  latency?: (seq: number, sentAt: number) => number;
  drop?: (seq: number) => boolean;
  /** Fecha a conexão n (0, 1, …) com este código depois de `afterMs` aberta. */
  closeAfter?: { conn: number; afterMs: number; code: number }[];
  refuse?: boolean;
}

/** WebSocket simulado: abre, devolve cada mensagem de 16 bytes depois da latência pedida. */
export function echoServer(clock: FakeClock, o: EchoServerOpts = {}): WsCtor & { urls: string[]; sends: number[]; clientCloses: (number | undefined)[] } {
  const urls: string[] = [];
  const sends: number[] = [];
  const clientCloses: (number | undefined)[] = [];
  let n = 0;
  class W implements WsLike {
    readyState = 0;
    binaryType = 'blob';
    private fns: Record<string, ((ev: { data?: unknown; code?: number }) => void)[]> = {};
    private open = false;
    constructor(url: string) {
      urls.push(url);
      const idx = n++;
      clock.set(() => {
        if (o.refuse) {
          this.emit('error', {});
          this.emit('close', { code: 1006 });
          return;
        }
        this.open = true;
        this.readyState = 1;
        this.emit('open', {});
        for (const c of o.closeAfter ?? []) {
          if (c.conn === idx) clock.set(() => this.serverClose(c.code), c.afterMs);
        }
      }, o.openMs ?? 50);
    }
    addEventListener(type: string, fn: (ev: { data?: unknown; code?: number }) => void) {
      (this.fns[type] ??= []).push(fn);
    }
    private emit(type: string, ev: { data?: unknown; code?: number }) {
      for (const fn of this.fns[type] ?? []) fn(ev);
    }
    private serverClose(code: number) {
      if (!this.open) return;
      this.open = false;
      this.emit('close', { code });
    }
    send(data: string | ArrayBuffer) {
      if (!this.open) throw new Error('fechado');
      sends.push(clock.now());
      if (!(data instanceof ArrayBuffer)) return;
      const seq = new DataView(data).getUint32(0, true);
      if (o.drop?.(seq)) return;
      const copy = data.slice(0); // o servidor real devolve os mesmos bytes, em binário
      clock.set(() => {
        if (this.open) this.emit('message', { data: copy });
      }, o.latency?.(seq, clock.now()) ?? 100);
    }
    close(code?: number) {
      clientCloses.push(code);
      const was = this.open;
      this.open = false;
      if (was || this.readyState === 0) clock.set(() => this.emit('close', { code: code ?? 1005 }), 1);
    }
  }
  const C = W as unknown as WsCtor & { urls: string[]; sends: number[]; clientCloses: (number | undefined)[] };
  C.urls = urls;
  C.sends = sends;
  C.clientCloses = clientCloses;
  return C;
}
