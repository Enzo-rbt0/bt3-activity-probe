// F3b: eco contínuo (plano da F3b, seções 3 e 4).
//   N-ECHO · 1 sessão: 2 s de aquecimento + 60 s de medição, 60 mensagens/s de 16 bytes, cada uma
//            devolvida pelo servidor. O RTT é medido pelo relógio do PRÓPRIO cliente (instante de
//            envio guardado aqui), sem depender do relógio do servidor.
// Regras:
//   - Agendador por prazo absoluto (início + k × 16,67 ms). Se atrasar mais de 1 período, os envios
//     perdidos NÃO são compensados (seriam rajadas acima de 120/s e o servidor fecharia com 4002):
//     ficam contados como "pulados".
//   - Mensagem sem resposta é "sem eco", nunca "perda de pacote".
//   - Queda: até 3 reconexões (1, 2 e 4 s), cada uma com bilhete NOVO e só o tempo que falta.
//   - Página escondida durante a medição → INV (segundo plano é da F3d).
// O relatório guarda só resumos (percentis, histograma, contagens, as 20 piores): nenhuma das ~3.600
// amostras, nenhum bilhete, ID de sessão, IP, cabeçalho ou URL.
import type { Basic } from '../report/types';
import { SERVER_REGION } from '../net-config';
import { admitError, describe, probeHealth, TICKET_RE, type Bases, type NetDeps, type NetRoute, type WsCtor, type WsLike } from './c-net';

export interface EchoConfig {
  hz: number;
  warmupMs: number;
  measureMs: number;
  sessionExtraS: number; // folga pedida ao servidor além do tempo de envio
  maxReconnects: number;
  backoffMs: number[];
  graceMs: number; // espera pelos últimos ecos depois do último envio
}
export const ECHO_CONFIG: EchoConfig = { hz: 60, warmupMs: 2000, measureMs: 60_000, sessionExtraS: 3, maxReconnects: 3, backoffMs: [1000, 2000, 4000], graceMs: 1000 };
export const MSG_BYTES = 16;
export const WORST_N = 20;
export const HIST_STEP_MS = 10;
export const HIST_CAP_MS = 1000; // a última faixa é "1000 ms ou mais"

export const sessionSeconds = (sendMs: number, c: EchoConfig = ECHO_CONFIG) => Math.ceil(sendMs / 1000) + c.sessionExtraS;
// Reserva que o servidor faz para uma sessão: duração × 60 Hz × 1,1 (mesma conta do servidor).
export const reservedFor = (seconds: number) => Math.ceil(Math.round(seconds * 60 * 1.1 * 1000) / 1000);

// ---------- protocolo (16 bytes) ----------
// [0..3] número de sequência (uint32 LE) · [4..11] instante de envio, performance.now() (float64 LE) · [12..15] zeros
export function encodeMsg(seq: number, t: number): ArrayBuffer {
  const b = new ArrayBuffer(MSG_BYTES);
  const v = new DataView(b);
  v.setUint32(0, seq >>> 0, true);
  v.setFloat64(4, t, true);
  return b;
}

export function decodeMsg(d: unknown): { seq: number; t: number } | null {
  let v: DataView;
  if (d instanceof ArrayBuffer) v = new DataView(d);
  else if (ArrayBuffer.isView(d)) v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  else return null;
  if (v.byteLength !== MSG_BYTES) return null;
  if (v.getUint32(12, true) !== 0) return null;
  return { seq: v.getUint32(0, true), t: v.getFloat64(4, true) };
}

// ---------- estatística ----------
// Percentil por "nearest-rank": posição ⌈p/100 × N⌉ na lista ordenada.
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function histogram(values: number[]): [number, number][] {
  const counts = new Map<number, number>();
  for (const x of values) {
    // Arredonda a 0,1 ms antes (como os valores do relatório): 99,99999 ms conta como 100.
    const lower = Math.min(HIST_CAP_MS, Math.floor(Math.max(0, round1(x)) / HIST_STEP_MS) * HIST_STEP_MS);
    counts.set(lower, (counts.get(lower) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

// Variação entre RTTs consecutivos (na ordem de envio): média e desvio de |RTT[n] − RTT[n−1]|.
// NÃO é o jitter do RFC 3550.
export function variation(rttsBySeq: number[]): { mean_ms: number | null; std_ms: number | null } {
  if (rttsBySeq.length < 2) return { mean_ms: null, std_ms: null };
  const d: number[] = [];
  for (let i = 1; i < rttsBySeq.length; i++) d.push(Math.abs(rttsBySeq[i]! - rttsBySeq[i - 1]!));
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const std = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
  return { mean_ms: round1(mean), std_ms: round1(std) };
}

// Estimativa (aproximação, NÃO aprovação): D ≈ ⌈(RTT_p99 / 2) / 16,7 ms⌉ + 1.
export const dEstimate = (p99: number | null) => (p99 === null ? null : Math.ceil(p99 / 2 / (1000 / 60)) + 1);

const round1 = (x: number) => Math.round(x * 10) / 10;
const r1 = (x: number | null) => (x === null ? null : round1(x));

// ---------- resultado ----------
export type EchoStage = 'janela' | 'admissao' | 'upgrade' | 'conexao' | 'limite';
export interface EchoConnection {
  admissions: number;
  admit_statuses: number[];
  open_ms: number[];
  reconnects: number;
  reconnect_ms: number[];
  close_codes: number[];
  completed: boolean;
  stopped_by_user: boolean;
  hidden_during: boolean;
  hidden_at_ms: number | null;
  focus_lost: number;
  wake_lock: 'ativo' | 'negado' | 'indisponivel' | null;
  failed_stage: EchoStage | null;
  error: string | null;
}
export interface NetEchoResult extends Basic {
  ran: boolean;
  window_open: boolean | null;
  pair_label: string;
  route: NetRoute | null;
  server_region: string;
  config: { hz: number; msg_bytes: number; warmup_s: number; measure_s: number; session_s: number };
  connection: EchoConnection;
  measured_ms: number | null;
  sent: number;
  received: number;
  no_echo: number;
  unexpected: number;
  echo_ratio: number | null;
  warmup: { sent: number; received: number };
  rtt: { p50: number | null; p95: number | null; p99: number | null; max: number | null; mean: number | null };
  variation: { mean_ms: number | null; std_ms: number | null };
  histogram: [number, number][];
  cadence: { rate_hz: number | null; interval_mean_ms: number | null; interval_p95_ms: number | null; interval_p99_ms: number | null; late_over_5ms: number; skipped: number };
  delays: { over_50ms: number; over_100ms: number; over_250ms: number; over_1s: number; gaps_over_250ms: number; max_gap_ms: number | null };
  worst: { t_ms: number; rtt_ms: number }[];
  d_estimate_frames: number | null;
}

export interface TimerLike { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const realTimers: TimerLike = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export interface EchoDeps extends NetDeps {
  WebSocket: WsCtor;
  timers?: TimerLike;
  wakeLock?: () => Promise<{ release(): Promise<void> } | null>;
}

type Opened = { ok: true; ws: WsLike; events: Events } | { ok: false; stage: EchoStage; status: number | null; error: string };
type Ev = { kind: 'open' | 'message' | 'close' | 'error'; data?: unknown; code?: number };
// Fila de eventos do WebSocket: cada fase (abertura, envio, fechamento) assume a escuta com on();
// entre as fases (off), os eventos ficam guardados e são entregues à fase seguinte, sem perder nada.
type Events = { on(fn: (e: Ev) => void): void; off(): void };
type PumpEnd = { kind: 'done' } | { kind: 'stopped' } | { kind: 'closed'; code: number | null };

export class EchoTest {
  private c: EchoConfig;
  private t: TimerLike;
  private running = false;
  private ran = false;
  private stopRequested = false;
  private stopWake: (() => void) | null = null;
  private healthFailed: string | null = null;
  private windowOpen: boolean | null = null;
  private route: NetRoute | null = null;
  private pairLabel = '';
  private conn!: EchoConnection;
  // estado da medição
  private sendStart: number | null = null;
  private lastActivity = 0;
  private nextSeq = 0;
  private pending = new Map<number, number>(); // seq → instante de envio
  private sentW = 0;
  private recvW = 0;
  private sentM = 0;
  private recvM = 0;
  private unexpected = 0;
  private rtts: { seq: number; rtt: number; t: number }[] = [];
  private intervals: number[] = [];
  private lateOver5 = 0;
  private skipped = 0;
  private lastSendAt: number | null = null;
  private lastRecvAt: number | null = null;
  private gaps = 0;
  private maxGap: number | null = null;
  private measuredEnd: number | null = null;

  constructor(private deps: EchoDeps, config: Partial<EchoConfig> = {}) {
    this.c = { ...ECHO_CONFIG, ...config };
    this.t = deps.timers ?? realTimers;
    this.reset();
  }

  get config(): EchoConfig {
    return this.c;
  }

  isRunning(): boolean {
    return this.running;
  }

  setPairLabel(s: string): void {
    this.pairLabel = s.trim().slice(0, 40);
  }

  /** Pedido de parada pela pessoa (botão "Parar"). */
  stop(): void {
    if (!this.running) return;
    this.stopRequested = true;
    this.stopWake?.();
  }

  /** Página escondida (visibilitychange). Só conta durante a medição. */
  noteHidden(): void {
    if (!this.running || this.sendStart === null || this.conn.hidden_during) return;
    this.conn.hidden_during = true;
    this.conn.hidden_at_ms = Math.round(this.deps.now() - this.sendStart);
  }

  /** Perda de foco (informativa). */
  noteBlur(): void {
    if (this.running && this.sendStart !== null) this.conn.focus_lost++;
  }

  /** Segundos enviados até agora (para a barra de progresso). */
  progress(): { elapsed_s: number; total_s: number; sent: number; received: number; p50: number | null } {
    const total = (this.c.warmupMs + this.c.measureMs) / 1000;
    const el = this.sendStart === null ? 0 : Math.min(total, (this.deps.now() - this.sendStart) / 1000);
    const sorted = this.rtts.map((r) => r.rtt).sort((a, b) => a - b);
    return { elapsed_s: Math.floor(el), total_s: total, sent: this.sentW + this.sentM, received: this.recvW + this.recvM, p50: r1(percentile(sorted, 50)) };
  }

  private reset(): void {
    this.conn = {
      admissions: 0, admit_statuses: [], open_ms: [], reconnects: 0, reconnect_ms: [], close_codes: [],
      completed: false, stopped_by_user: false, hidden_during: false, hidden_at_ms: null, focus_lost: 0,
      wake_lock: null, failed_stage: null, error: null,
    };
    this.healthFailed = null;
    this.windowOpen = null;
    this.stopRequested = false;
    this.sendStart = null;
    this.nextSeq = 0;
    this.pending.clear();
    this.sentW = this.recvW = this.sentM = this.recvM = this.unexpected = 0;
    this.rtts = [];
    this.intervals = [];
    this.lateOver5 = this.skipped = this.gaps = 0;
    this.lastSendAt = this.lastRecvAt = this.maxGap = this.measuredEnd = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const h = this.t.set(() => {
        this.stopWake = null;
        resolve();
      }, ms);
      this.stopWake = () => {
        this.t.clear(h);
        this.stopWake = null;
        resolve();
      };
    });
  }

  async run(bases: Bases, route: NetRoute, onProgress: () => void = () => {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ran = true;
    this.reset();
    this.route = route;
    let wake: { release(): Promise<void> } | null = null;
    try {
      const h = await probeHealth(this.deps, route, `${bases.httpBase}/net/health`);
      if (!h.json_ok) {
        this.healthFailed = describe(h);
        return;
      }
      this.windowOpen = h.server_open;
      if (!h.server_open) return;

      // Tela acesa durante a medição (celular). Pode ser negado dentro do Discord: só registra.
      if (this.deps.wakeLock) {
        try {
          wake = await this.deps.wakeLock();
          this.conn.wake_lock = wake ? 'ativo' : 'indisponivel';
        } catch {
          this.conn.wake_lock = 'negado';
        }
      } else this.conn.wake_lock = 'indisponivel';

      const total = this.c.warmupMs + this.c.measureMs;
      let disconnectedAt: number | null = null;
      for (;;) {
        if (this.stopRequested) break;
        const remaining = this.sendStart === null ? total : total - (this.deps.now() - this.sendStart);
        if (remaining <= 0) break;
        const o = await this.open(bases, sessionSeconds(remaining, this.c));
        if (!o.ok) {
          this.conn.failed_stage = o.stage;
          this.conn.error = o.error;
          // Admissão recusada por regra do servidor (limite, janela, origem, pedido): não insiste.
          const hard = o.stage === 'admissao' && o.status !== null;
          if (disconnectedAt === null || hard || this.conn.reconnects >= this.c.maxReconnects) break;
          await this.sleep(this.c.backoffMs[Math.min(this.conn.reconnects, this.c.backoffMs.length - 1)]!);
          this.conn.reconnects++;
          continue;
        }
        if (this.sendStart === null) this.sendStart = this.deps.now();
        else if (disconnectedAt !== null) this.conn.reconnect_ms.push(Math.round(this.deps.now() - disconnectedAt));
        this.conn.failed_stage = null;
        this.conn.error = null;
        disconnectedAt = null;
        const end = await this.pump(o.ws, o.events, this.sendStart + total, onProgress);
        if (end.kind === 'done') {
          this.conn.completed = true;
          await this.finish(o.ws, o.events);
          break;
        }
        if (end.kind === 'stopped') {
          this.conn.stopped_by_user = true;
          await this.finish(o.ws, o.events, 0);
          break;
        }
        // Queda: o que estava pendente fica "sem eco" (contado em no_echo = enviados − recebidos).
        if (this.conn.close_codes.length < 4) this.conn.close_codes.push(end.code ?? 1006);
        this.pending.clear();
        disconnectedAt = this.deps.now();
        if (end.code === 4002) {
          this.conn.failed_stage = 'limite';
          this.conn.error = 'o servidor fechou por limite (4002): taxa, tamanho ou cota';
          break;
        }
        this.conn.failed_stage = 'conexao';
        this.conn.error = `conexão caiu (código ${end.code ?? 1006})`;
        if (this.conn.reconnects >= this.c.maxReconnects) break;
        await this.sleep(this.c.backoffMs[Math.min(this.conn.reconnects, this.c.backoffMs.length - 1)]!);
        this.conn.reconnects++;
      }
      if (this.stopRequested) this.conn.stopped_by_user = true;
    } finally {
      this.measuredEnd = this.sendStart === null ? null : this.deps.now();
      this.pending.clear();
      try {
        await wake?.release();
      } catch {
        /* já liberado */
      }
      this.running = false;
      onProgress();
    }
  }

  // Admissão (bilhete de uso único, só nesta função) + abertura do WebSocket em até 5 s.
  private async open(bases: Bases, durationS: number): Promise<Opened> {
    const timeout = this.deps.timeoutMs ?? 5000;
    let ticket: string;
    const ctrl = new AbortController();
    const timer = this.t.set(() => ctrl.abort(), timeout);
    this.conn.admissions++;
    try {
      const res = await this.deps.fetch(`${bases.httpBase}/net/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'echo', duration_s: durationS }),
        cache: 'no-store',
        credentials: 'omit',
        signal: ctrl.signal,
      });
      if (this.conn.admit_statuses.length < 4) this.conn.admit_statuses.push(res.status);
      const text = await res.text();
      if (res.status !== 201) return { ok: false, stage: 'admissao', status: res.status, error: admitError(res.status) };
      const b = JSON.parse(text) as { bilhete?: unknown };
      if (typeof b.bilhete !== 'string' || !TICKET_RE.test(b.bilhete)) return { ok: false, stage: 'admissao', status: null, error: 'admissão sem bilhete válido' };
      ticket = b.bilhete;
    } catch {
      return { ok: false, stage: 'admissao', status: null, error: ctrl.signal.aborted ? `admissão sem resposta em ${timeout / 1000} s` : 'admissão falhou: rede/CORS/CSP' };
    } finally {
      this.t.clear(timer);
    }

    const t0 = this.deps.now();
    let ws: WsLike;
    try {
      ws = new this.deps.WebSocket(`${bases.wsBase}/net/ws/echo?bilhete=${ticket}`);
    } catch {
      return { ok: false, stage: 'upgrade', status: null, error: 'o navegador recusou criar o WebSocket (endereço ou CSP)' };
    }
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* sem binaryType */
    }
    let listener: ((e: Ev) => void) | null = null;
    const early: Ev[] = [];
    const emit = (e: Ev) => (listener ? listener(e) : void early.push(e));
    ws.addEventListener('open', () => emit({ kind: 'open' }));
    ws.addEventListener('message', (ev) => emit({ kind: 'message', data: ev.data }));
    ws.addEventListener('error', () => emit({ kind: 'error' }));
    ws.addEventListener('close', (ev) => emit({ kind: 'close', code: typeof ev.code === 'number' ? ev.code : undefined }));
    const events: Events = {
      on(fn) {
        listener = fn;
        while (early.length && listener === fn) fn(early.shift()!);
      },
      off() {
        listener = null;
      },
    };
    const first = await new Promise<Ev | 'tempo'>((resolve) => {
      const h = this.t.set(() => resolve('tempo'), timeout);
      events.on((e) => {
        if (e.kind === 'error') return; // o "close" vem em seguida
        this.t.clear(h);
        events.off();
        resolve(e);
      });
    });
    events.off();
    if (first !== 'tempo' && first.kind === 'open') {
      if (this.conn.open_ms.length < 4) this.conn.open_ms.push(Math.round(this.deps.now() - t0));
      return { ok: true, ws, events };
    }
    if (first !== 'tempo' && first.kind === 'close' && this.conn.close_codes.length < 4) this.conn.close_codes.push(first.code ?? 1006);
    try {
      ws.close(1000, 'fim');
    } catch {
      /* já fechado */
    }
    return {
      ok: false,
      stage: 'upgrade',
      status: null,
      error: first === 'tempo' ? `WebSocket não abriu em ${timeout / 1000} s` : `WebSocket recusado antes de abrir (código ${first.code ?? '—'})`,
    };
  }

  // Envia a 60 Hz até `until`, recebendo os ecos. Termina no prazo, na parada ou na queda.
  private pump(ws: WsLike, events: Events, until: number, onProgress: () => void): Promise<PumpEnd> {
    const period = 1000 / this.c.hz;
    const start = this.sendStart!;
    let k = Math.max(0, Math.ceil((this.deps.now() - start) / period));
    let timer: unknown = null;
    let lastUi = 0;
    return new Promise<PumpEnd>((resolve) => {
      let ended = false;
      const end = (r: PumpEnd) => {
        if (ended) return;
        ended = true;
        if (timer !== null) this.t.clear(timer);
        this.stopWake = null;
        events.off();
        resolve(r);
      };
      this.stopWake = () => end({ kind: 'stopped' });
      events.on((e) => {
        if (e.kind === 'message') this.onEcho(e.data);
        else if (e.kind === 'close') end({ kind: 'closed', code: e.code ?? null });
      });
      const tick = () => {
        timer = null;
        if (ended) return;
        if (this.stopRequested) return end({ kind: 'stopped' });
        const now = this.deps.now();
        if (now >= until) return end({ kind: 'done' });
        let due = start + k * period;
        const late = now - due;
        const measured = now - start >= this.c.warmupMs;
        if (late >= period) {
          const missed = Math.floor(late / period);
          if (measured) this.skipped += missed;
          k += missed;
          due = start + k * period;
        }
        const seq = this.nextSeq++;
        try {
          ws.send(encodeMsg(seq, now));
        } catch {
          return end({ kind: 'closed', code: null });
        }
        this.pending.set(seq, now);
        if (measured) {
          this.sentM++;
          if (now - due > 5) this.lateOver5++;
          if (this.lastSendAt !== null && this.lastSendAt - start >= this.c.warmupMs) this.intervals.push(now - this.lastSendAt);
        } else this.sentW++;
        this.lastSendAt = now;
        k++;
        if (now - lastUi >= 500) {
          lastUi = now;
          onProgress();
        }
        timer = this.t.set(tick, Math.max(0, start + k * period - this.deps.now()));
      };
      tick();
    });
  }

  private onEcho(data: unknown): void {
    const now = this.deps.now();
    const m = decodeMsg(data);
    const sentAt = m ? this.pending.get(m.seq) : undefined;
    if (!m || sentAt === undefined) {
      this.unexpected++;
      return;
    }
    this.pending.delete(m.seq);
    const start = this.sendStart!;
    const rtt = now - sentAt;
    const measured = sentAt - start >= this.c.warmupMs;
    if (this.lastRecvAt !== null && measured) {
      const gap = now - this.lastRecvAt;
      if (gap > 250) this.gaps++;
      this.maxGap = Math.max(this.maxGap ?? 0, gap);
    }
    this.lastRecvAt = now;
    if (!measured) {
      this.recvW++;
      return;
    }
    this.recvM++;
    this.rtts.push({ seq: m.seq, rtt, t: sentAt - start });
  }

  // Fim normal: espera os últimos ecos (até graceMs) e fecha com 1000.
  private async finish(ws: WsLike, events: Events, graceMs = this.c.graceMs): Promise<void> {
    let closed = false;
    await new Promise<void>((resolve) => {
      let h: unknown = null;
      const done = () => {
        if (h !== null) this.t.clear(h);
        events.off();
        resolve();
      };
      events.on((e) => {
        if (e.kind === 'message') {
          this.onEcho(e.data);
          if (this.pending.size === 0) done();
        } else if (e.kind === 'close') {
          closed = true;
          done();
        }
      });
      if (this.pending.size === 0 || graceMs <= 0) return done();
      h = this.t.set(done, graceMs);
    });
    if (closed) return;
    await new Promise<void>((resolve) => {
      const h = this.t.set(resolve, 2000);
      events.on((e) => {
        if (e.kind === 'close') {
          this.t.clear(h);
          resolve();
        }
      });
      try {
        ws.close(1000, 'fim');
      } catch {
        this.t.clear(h);
        resolve();
      }
    });
    events.off();
  }

  result(): NetEchoResult {
    const total = this.c.warmupMs + this.c.measureMs;
    const sortedRtt = this.rtts.map((r) => r.rtt).sort((a, b) => a - b);
    const bySeq = [...this.rtts].sort((a, b) => a.seq - b.seq).map((r) => r.rtt);
    const sortedInt = [...this.intervals].sort((a, b) => a - b);
    const measuredMs = this.sendStart === null || this.measuredEnd === null ? null : Math.max(0, Math.min(this.measuredEnd, this.sendStart + total) - this.sendStart - this.c.warmupMs);
    const p99 = r1(percentile(sortedRtt, 99));
    const ratio = this.sentM ? Math.round((this.recvM / this.sentM) * 10000) / 10000 : null;
    const mean = sortedRtt.length ? sortedRtt.reduce((a, b) => a + b, 0) / sortedRtt.length : null;
    const base: Omit<NetEchoResult, 'status' | 'detail'> = {
      ran: this.ran,
      window_open: this.windowOpen,
      pair_label: this.pairLabel,
      route: this.route,
      server_region: SERVER_REGION,
      config: { hz: this.c.hz, msg_bytes: MSG_BYTES, warmup_s: this.c.warmupMs / 1000, measure_s: this.c.measureMs / 1000, session_s: sessionSeconds(total, this.c) },
      connection: { ...this.conn, admit_statuses: [...this.conn.admit_statuses], open_ms: [...this.conn.open_ms], reconnect_ms: [...this.conn.reconnect_ms], close_codes: this.conn.close_codes.slice(0, 4) },
      measured_ms: measuredMs === null ? null : Math.round(measuredMs),
      sent: this.sentM,
      received: this.recvM,
      no_echo: Math.max(0, this.sentM - this.recvM),
      unexpected: this.unexpected,
      echo_ratio: ratio,
      warmup: { sent: this.sentW, received: this.recvW },
      rtt: {
        p50: r1(percentile(sortedRtt, 50)),
        p95: r1(percentile(sortedRtt, 95)),
        p99,
        max: r1(sortedRtt.length ? sortedRtt[sortedRtt.length - 1]! : null),
        mean: r1(mean),
      },
      variation: variation(bySeq),
      histogram: histogram(sortedRtt),
      cadence: {
        rate_hz: measuredMs ? round1(this.sentM / (measuredMs / 1000)) : null,
        interval_mean_ms: sortedInt.length ? round1(sortedInt.reduce((a, b) => a + b, 0) / sortedInt.length) : null,
        interval_p95_ms: r1(percentile(sortedInt, 95)),
        interval_p99_ms: r1(percentile(sortedInt, 99)),
        late_over_5ms: this.lateOver5,
        skipped: this.skipped,
      },
      delays: {
        over_50ms: sortedRtt.filter((x) => x > 50).length,
        over_100ms: sortedRtt.filter((x) => x > 100).length,
        over_250ms: sortedRtt.filter((x) => x > 250).length,
        over_1s: sortedRtt.filter((x) => x > 1000).length,
        gaps_over_250ms: this.gaps,
        max_gap_ms: r1(this.maxGap),
      },
      worst: [...this.rtts].sort((a, b) => b.rtt - a.rtt).slice(0, WORST_N).map((r) => ({ t_ms: Math.round(r.t), rtt_ms: round1(r.rtt) })),
      d_estimate_frames: dEstimate(p99),
    };
    return { ...this.status(base, ratio), ...base };
  }

  private status(b: Omit<NetEchoResult, 'status' | 'detail'>, ratio: number | null): Basic {
    const c = this.conn;
    if (this.running) {
      const p = this.progress();
      return { status: 'SKIP', detail: this.sendStart === null ? 'conectando…' : `medindo… ${p.elapsed_s} de ${p.total_s} s` };
    }
    if (!this.ran) return { status: 'SKIP', detail: 'ainda não feito (precisa da janela aberta no servidor)' };
    if (this.healthFailed) return { status: 'RP', detail: `Servidor inacessível pelo caminho da sonda: ${this.healthFailed}.` };
    if (this.windowOpen === false) return { status: 'INV', detail: 'Rede FECHADA no servidor: abra a janela pelo SSH (bt3probe-janela abrir) e repita.' };
    const pct = ratio === null ? '—' : `${(ratio * 100).toFixed(1).replace('.', ',')}%`;
    const summary =
      b.rtt.p50 === null
        ? `eco ${pct}`
        : `RTT p50 ${b.rtt.p50} · p95 ${b.rtt.p95} · p99 ${b.rtt.p99} · máx ${b.rtt.max} ms; eco ${pct}; ${b.cadence.rate_hz ?? '—'} msg/s; D≈${b.d_estimate_frames} quadros`;
    if (this.sendStart === null) {
      const soft = c.failed_stage === 'admissao' && (c.admit_statuses.at(-1) === 429 || c.admit_statuses.at(-1) === 503);
      if (c.stopped_by_user) return { status: 'INV', detail: 'Interrompido antes de começar.' };
      return { status: soft ? 'INV' : 'RP', detail: `Não conectou (${c.failed_stage}): ${c.error}.` };
    }
    if (c.stopped_by_user) return { status: 'INV', detail: `Interrompido pela pessoa depois de ${Math.round((b.measured_ms ?? 0) / 1000)} s de medição. ${summary}.` };
    if (c.failed_stage === 'limite') return { status: 'RP', detail: `${c.error}. ${summary}.` };
    if (!c.completed) {
      const soft = c.failed_stage === 'admissao' && (c.admit_statuses.at(-1) === 429 || c.admit_statuses.at(-1) === 503);
      return { status: soft ? 'INV' : 'RP', detail: `Não completou os 60 s (${c.reconnects} reconexões; ${c.error ?? 'queda'}). ${summary}.` };
    }
    if (c.hidden_during) return { status: 'INV', detail: `Página escondida aos ${Math.round((c.hidden_at_ms ?? 0) / 1000)} s (segundo plano é da F3d). ${summary}.` };
    if (ratio === null || ratio < 0.95) return { status: 'RP', detail: `Eco abaixo de 95%. ${summary}.` };
    if (c.reconnects > 0) return { status: 'INV', detail: `Completou com ${c.reconnects} reconexão(ões). ${summary}.` };
    if (ratio < 0.99) return { status: 'INV', detail: `Eco entre 95% e 99%. ${summary}.` };
    return { status: 'AP', detail: `${summary}.` };
  }
}
