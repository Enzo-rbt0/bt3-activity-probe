// Servidor de relay simulado para os testes da F3c (não entra na build da página). Faz o papel das
// salas do servidor 0.4.0 (criar, entrar, ping, pronto → comecar, repasse binário, saiu) com o relógio
// falso da F3b: cada conexão tem um atraso de ida (up) e de volta (down) conhecido, e o resultado da
// medição sai exato.
import type { WsCtor, WsLike } from '../tests/c-net';
import { RelayTest, type RelayConfig } from '../tests/c-relay';
import { FakeClock } from './echo-fakes';
import { fakeFetch, server } from './net-fakes';

export const ROOM_CODE = 'K7Q4MD';
type Ev = { data?: unknown; code?: number; reason?: string };

export interface RelayHubOpts {
  /** Atraso de ida e de volta de cada conexão, na ordem em que abrem (0 = primeira). */
  links?: { up: number; down: number }[];
  /** Atraso extra no repasse do quadro `seq` que veio da conexão `from`. */
  frameDelay?: (from: number, seq: number) => number;
  /** O servidor "perde" o quadro (simula um quadro que nunca chega). */
  drop?: (from: number, seq: number) => boolean;
  /** O servidor fecha a conexão n com este código depois de `afterMs` aberta. */
  closeAfter?: { conn: number; afterMs: number; code: number; reason?: string }[];
  /** Resposta de erro ao "entrar". */
  joinError?: string;
}

export function relayHub(clock: FakeClock, o: RelayHubOpts = {}): WsCtor & { urls: string[]; texts: string[]; clientCloses: (number | undefined)[] } {
  const urls: string[] = [];
  const texts: string[] = [];
  const clientCloses: (number | undefined)[] = [];
  const conns: W[] = [];
  let room: { members: W[]; ready: Map<W, number | null>; started: boolean } | null = null;
  const link = (i: number) => o.links?.[i] ?? { up: 50, down: 50 };

  const toClient = (w: W, data: unknown, extra = 0) => clock.set(() => w.deliver(data), extra + link(w.idx).down);
  const json = (w: W, m: Record<string, unknown>) => toClient(w, JSON.stringify(m));
  const left = (w: W) => {
    if (!room || !room.members.includes(w)) return;
    for (const x of room.members) if (x !== w) json(x, { t: 'saiu' });
    room = null;
  };
  const handle = (w: W, data: string | ArrayBuffer) => {
    if (!w.serverOpen) return;
    if (typeof data === 'string') {
      const m = JSON.parse(data) as { t: string; n?: number; codigo?: string; rtt?: number };
      if (m.t === 'ping') return json(w, { t: 'pong', n: m.n });
      if (m.t === 'criar') {
        room = { members: [w], ready: new Map(), started: false };
        return json(w, { t: 'sala', codigo: ROOM_CODE });
      }
      if (m.t === 'entrar') {
        if (o.joinError) return json(w, { t: 'erro', motivo: o.joinError });
        if (!room || m.codigo !== ROOM_CODE) return json(w, { t: 'erro', motivo: 'código inválido ou vencido' });
        if (room.members.length >= 2) return json(w, { t: 'erro', motivo: 'sala cheia' });
        room.members.push(w);
        for (const x of room.members) json(x, { t: 'par' });
        return;
      }
      if (m.t === 'pronto' && room && !room.started) {
        room.ready.set(w, typeof m.rtt === 'number' ? m.rtt : null);
        if (room.ready.size === 2) {
          room.started = true;
          const [a, b] = room.members as [W, W];
          json(a, { t: 'comecar', rtt_outro: room.ready.get(b) ?? null });
          json(b, { t: 'comecar', rtt_outro: room.ready.get(a) ?? null });
        }
      }
      return;
    }
    if (!room?.started) return;
    const seq = new DataView(data).getUint32(0, true);
    if (o.drop?.(w.idx, seq)) return;
    for (const x of room.members) if (x !== w) toClient(x, data.slice(0), o.frameDelay?.(w.idx, seq) ?? 0);
  };

  class W implements WsLike {
    readyState = 0;
    binaryType = 'blob';
    serverOpen = false;
    readonly idx: number;
    private fns: Record<string, ((ev: Ev) => void)[]> = {};
    private clientOpen = false;
    constructor(url: string) {
      urls.push(url);
      this.idx = conns.length;
      conns.push(this);
      clock.set(() => {
        this.serverOpen = this.clientOpen = true;
        this.readyState = 1;
        this.emit('open', {});
        for (const c of o.closeAfter ?? []) if (c.conn === this.idx) clock.set(() => this.serverClose(c.code, c.reason ?? ''), c.afterMs);
      }, 50);
    }
    addEventListener(type: string, fn: (ev: Ev) => void) {
      (this.fns[type] ??= []).push(fn);
    }
    private emit(type: string, ev: Ev) {
      for (const fn of this.fns[type] ?? []) fn(ev);
    }
    deliver(data: unknown) {
      if (this.clientOpen) this.emit('message', { data });
    }
    private serverClose(code: number, reason: string) {
      if (!this.serverOpen) return;
      this.serverOpen = false;
      left(this);
      clock.set(() => {
        if (!this.clientOpen) return;
        this.clientOpen = false;
        this.emit('close', { code, reason });
      }, link(this.idx).down);
    }
    send(data: string | ArrayBuffer) {
      if (!this.clientOpen) throw new Error('fechado');
      if (typeof data === 'string') texts.push(data);
      clock.set(() => handle(this, data), link(this.idx).up);
    }
    close(code?: number) {
      clientCloses.push(code);
      if (!this.clientOpen) return;
      this.clientOpen = false;
      clock.set(() => this.emit('close', { code: code ?? 1005 }), 1);
      clock.set(() => {
        if (!this.serverOpen) return;
        this.serverOpen = false;
        left(this);
      }, link(this.idx).up);
    }
  }
  const C = W as unknown as WsCtor & { urls: string[]; texts: string[]; clientCloses: (number | undefined)[] };
  C.urls = urls;
  C.texts = texts;
  C.clientCloses = clientCloses;
  return C;
}

export const RELAY_BASES = { httpBase: 'https://1571332639812493522.discordsays.com', wsBase: 'wss://1571332639812493522.discordsays.com' };

/** Dois aparelhos: A cria a sala; B entra com o código `joinAtMs` depois (ou não entra, se null). */
export function relayPair(o: RelayHubOpts = {}, opts: { joinAtMs?: number | null; joinCode?: string; cfg?: Partial<RelayConfig> } = {}) {
  const clock = new FakeClock();
  const WS = relayHub(clock, o);
  const fetchA = fakeFetch(server());
  const fetchB = fakeFetch(server());
  const A = new RelayTest({ fetch: fetchA, now: clock.now, timeoutMs: 5000, WebSocket: WS, timers: clock }, opts.cfg);
  const B = new RelayTest({ fetch: fetchB, now: clock.now, timeoutMs: 5000, WebSocket: WS, timers: clock }, opts.cfg);
  A.setPairLabel('PC-S26-1');
  B.setPairLabel('PC-S26-1');
  const run = async () => {
    const pa = A.run(RELAY_BASES, 'relativo', { create: true });
    let pb: Promise<void> = Promise.resolve();
    const joined = new Promise<void>((resolve) => {
      if (opts.joinAtMs === null) return resolve();
      clock.set(() => {
        pb = B.run(RELAY_BASES, 'proxy', { join: opts.joinCode ?? 'k7q-4md' });
        resolve();
      }, opts.joinAtMs ?? 3000);
    });
    const all = Promise.all([pa, joined.then(() => pb)]);
    await clock.runUntil(all, 400_000);
    await all;
    return { a: A.result(), b: B.result() };
  };
  return { clock, WS, A, B, fetchA, fetchB, run };
}
