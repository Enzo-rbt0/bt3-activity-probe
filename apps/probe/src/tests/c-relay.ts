// F3c: relay entre dois aparelhos (plano da F3c, seções 2 e 4).
//   N-RELAY · cada aparelho pede a PRÓPRIA admissão (kind "relay") e entra numa sala do servidor por um
//             código curto. Com os dois prontos, o servidor manda "comecar" aos dois; cada um envia o
//             quadro k (16 bytes) no instante local largada + k × 16,67 ms, durante 2 s de aquecimento +
//             60 s, e o servidor repassa ao outro.
// O que cada aparelho mede (só a SUA parte; o outro gera o próprio relatório):
//   - RTT até o servidor: 20 pings antes e 20 depois (o servidor responde "pong").
//   - Atraso de chegada do quadro k do outro = chegada − (largada local + k × 16,67 ms).
//       · bruto: como medido. A largada chega a cada um em instantes diferentes (metade do RTT de cada
//         lado), então o bruto ≈ RTT do outro + variação.
//       · corrigido: bruto + (RTT próprio − RTT do outro) / 2 ≈ ida do outro até o servidor + volta até
//         aqui, como se os dois tivessem começado juntos. Incerteza: ±(RTT próprio + RTT do outro) / 2
//         (assimetria de ida e volta). O nome registrado é "estimativa sob o protocolo de início".
//   - Curva D × travadas: para D = 1…30 quadros, a % dos quadros do outro que chegariam depois de
//     prazo + D (ou não chegaram). Daí o menor D com ≤ 1% e com ≤ 0,1% de travadas.
// Regras:
//   - Sem reconexão: se a conexão cai, a sala acaba no servidor; fica registrado como interrupção.
//   - Agendador por prazo absoluto. Atrasou? Envia os quadros atrasados (como um jogo faria), no máximo
//     120 de uma vez (bem abaixo da rajada de 360 do servidor); o excesso vira "pulados".
//   - O código da sala existe só na memória e na tela: NUNCA vai para o relatório, o log ou o JSON.
//   - Página escondida durante a medição → INV (segundo plano é da F3d).
import type { Basic } from '../report/types';
import { SERVER_REGION } from '../net-config';
import { admitError, describe, probeHealth, TICKET_RE, type Bases, type NetDeps, type NetRoute, type WsCtor, type WsLike } from './c-net';
import { decodeMsg, encodeMsg, histogram, limitError, MSG_BYTES, percentile, reservedFor, WORST_N, type TimerLike } from './c-echo';

export interface RelayConfig {
  hz: number;
  warmupMs: number;
  measureMs: number;
  sessionS: number; // duração pedida ao servidor (máximo dele: 180 s)
  pings: number; // antes e depois
  pingTimeoutMs: number;
  pingGapMs: number;
  keepaliveMs: number; // ping de "mantém viva" enquanto espera (o servidor fecha com 60 s parado)
  replyTimeoutMs: number; // resposta do servidor a "criar"/"entrar"
  readyTimeoutMs: number; // espera pela largada depois do "pronto"
  graceMs: number; // espera pelos últimos quadros do outro
  needAfterPairMs: number; // tempo de sessão que precisa sobrar quando o par chega
  roomWaitMs: number; // o servidor vence a sala em 2 min
  maxBacklog: number;
  dMax: number;
}
export const RELAY_CONFIG: RelayConfig = {
  hz: 60, warmupMs: 2000, measureMs: 60_000, sessionS: 180, pings: 20, pingTimeoutMs: 1000, pingGapMs: 50,
  keepaliveMs: 10_000, replyTimeoutMs: 5000, readyTimeoutMs: 30_000, graceMs: 1500, needAfterPairMs: 90_000,
  roomWaitMs: 120_000, maxBacklog: 120, dMax: 30,
};

// Mesmo alfabeto do servidor (sem 0/O e 1/I). Conferido pelo teste de contrato.
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LEN = 6;
export function normalizeCode(s: string): string | null {
  const t = s.toUpperCase().replace(/[\s-]/g, '');
  if (t.length !== CODE_LEN) return null;
  for (const ch of t) if (!CODE_ALPHABET.includes(ch)) return null;
  return t;
}
export const formatCode = (c: string) => `${c.slice(0, 3)}-${c.slice(3)}`;

/** Tempo que o outro aparelho tem para entrar, contado da criação da sala. */
export const joinWindowMs = (c: RelayConfig = RELAY_CONFIG) => Math.min(c.roomWaitMs, c.sessionS * 1000 - c.needAfterPairMs);
export const relayFrames = (c: RelayConfig = RELAY_CONFIG) => Math.round(((c.warmupMs + c.measureMs) / 1000) * c.hz);
export const relayReserve = (c: RelayConfig = RELAY_CONFIG) => reservedFor(c.sessionS);

// Curva D × travadas: % (2 casas) dos quadros esperados que chegaram depois de prazo + D, ou não chegaram.
export function dCurve(lateness: number[], expected: number, hz: number, dMax: number): number[] {
  if (expected <= 0) return [];
  const missing = Math.max(0, expected - lateness.length);
  const period = 1000 / hz;
  const out: number[] = [];
  for (let d = 1; d <= dMax; d++) {
    const lim = d * period + 1e-6;
    let late = 0;
    for (const x of lateness) if (x > lim) late++;
    out.push(Math.round(((late + missing) / expected) * 10000) / 100);
  }
  return out;
}
export const dMinWithin = (curve: number[], pct: number): number | null => {
  const i = curve.findIndex((x) => x <= pct);
  return i < 0 ? null : i + 1;
};
export const framesToMs = (d: number | null, hz = 60) => (d === null ? null : Math.round((d * 1000) / hz));

const round1 = (x: number) => Math.round(x * 10) / 10;
const r1 = (x: number | null) => (x === null ? null : round1(x));

// ---------- resultado ----------
export type RelayRole = 'criou' | 'entrou';
export type RelayStage = 'codigo' | 'admissao' | 'upgrade' | 'sala' | 'par' | 'largada' | 'conexao' | 'limite';
export interface RelayConnection {
  admit_status: number | null;
  open_ms: number | null;
  close_code: number | null;
  wait_partner_ms: number | null;
  completed: boolean;
  stopped_by_user: boolean;
  peer_left: boolean;
  peer_left_at_ms: number | null;
  hidden_during: boolean;
  hidden_at_ms: number | null;
  focus_lost: number;
  wake_lock: 'ativo' | 'negado' | 'indisponivel' | null;
  failed_stage: RelayStage | null;
  error: string | null;
}
export interface RttSummary { sent: number; answered: number; p50: number | null; p95: number | null }
export interface LatenessSummary { p50: number | null; p95: number | null; p99: number | null; p999: number | null; max: number | null; min: number | null }
export interface NetRelayResult extends Basic {
  ran: boolean;
  window_open: boolean | null;
  role: RelayRole | null;
  pair_label: string;
  route: NetRoute | null;
  server_region: string;
  config: { hz: number; msg_bytes: number; warmup_s: number; measure_s: number; session_s: number; pings: number };
  connection: RelayConnection;
  rtt_before: RttSummary;
  rtt_after: RttSummary;
  rtt_self_ms: number | null;
  rtt_peer_ms: number | null;
  uncertainty_ms: number | null;
  measured_ms: number | null;
  sent: number;
  skipped: number;
  cadence: { rate_hz: number | null; interval_mean_ms: number | null; interval_p95_ms: number | null; interval_p99_ms: number | null; late_over_5ms: number };
  expected: number;
  received: number;
  missing: number;
  received_ratio: number | null;
  out_of_order: number;
  duplicates: number;
  unexpected: number;
  warmup: { sent: number; received: number };
  gaps: { over_250ms: number; max_ms: number | null };
  lateness_raw: LatenessSummary;
  lateness: LatenessSummary;
  histogram: [number, number][];
  curve_basis: 'corrigido' | 'bruto' | null;
  d_curve: number[];
  d_min_1pct: number | null;
  d_min_01pct: number | null;
  worst: { t_ms: number; lateness_ms: number }[];
}

export interface RelayDeps extends NetDeps {
  WebSocket: WsCtor;
  timers?: TimerLike;
  wakeLock?: () => Promise<{ release(): Promise<void> } | null>;
}
const realTimers: TimerLike = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

type Ctl = { t: string; [k: string]: unknown };
type Abort = { kind: 'fechou' } | { kind: 'parado' };
const isAbort = (x: unknown): x is Abort => typeof x === 'object' && x !== null && 'kind' in x && !('t' in x);
export type RelayPhase = 'parado' | 'conectando' | 'sala' | 'pings' | 'pronto' | 'medindo' | 'finalizando';

export class RelayTest {
  private c: RelayConfig;
  private t: TimerLike;
  private running = false;
  private ran = false;
  private stopRequested = false;
  private healthFailed: string | null = null;
  private windowOpen: boolean | null = null;
  private route: NetRoute | null = null;
  private role: RelayRole | null = null;
  private pairLabel = '';
  private phase: RelayPhase = 'parado';
  private code: string | null = null; // só memória e tela
  private roomUntil: number | null = null;
  private conn!: RelayConnection;
  private ws: WsLike | null = null;
  private closed: { code: number | null; reason: string } | null = null;
  private wakers = new Set<() => void>();
  private ctl: Ctl[] = [];
  private nextPing = 0;
  private pingsAt = new Map<number, number>();
  private pongs = new Map<number, number>(); // n → RTT
  private before: number[] = [];
  private after: number[] = [];
  private beforeSent = 0;
  private afterSent = 0;
  private rttPeer: number | null = null;
  private t0: number | null = null;
  private arrival: Float64Array = new Float64Array(0);
  private maxSeq = -1;
  private outOfOrder = 0;
  private duplicates = 0;
  private unexpected = 0;
  private lastRecvAt: number | null = null;
  private gaps = 0;
  private maxGap: number | null = null;
  private sentW = 0;
  private sentM = 0;
  private skipped = 0;
  private lateOver5 = 0;
  private intervals: number[] = [];
  private lastSend: { k: number; at: number } | null = null;
  private measuredEnd: number | null = null;
  private peerLeftAt: number | null = null;

  constructor(private deps: RelayDeps, config: Partial<RelayConfig> = {}) {
    this.c = { ...RELAY_CONFIG, ...config };
    this.t = deps.timers ?? realTimers;
    this.reset();
  }

  get config(): RelayConfig {
    return this.c;
  }
  isRunning(): boolean {
    return this.running;
  }
  setPairLabel(s: string): void {
    this.pairLabel = s.trim().slice(0, 40);
  }
  stop(): void {
    if (!this.running) return;
    this.stopRequested = true;
    this.wake();
  }
  noteHidden(): void {
    if (!this.running || this.t0 === null || this.conn.hidden_during) return;
    this.conn.hidden_during = true;
    this.conn.hidden_at_ms = Math.round(this.deps.now() - this.t0);
  }
  noteBlur(): void {
    if (this.running && this.t0 !== null) this.conn.focus_lost++;
  }

  /** Para a tela: fase, código (só aqui) e números leves. */
  progress(): { phase: RelayPhase; code: string | null; join_left_s: number | null; pings: number; elapsed_s: number; total_s: number; sent: number; received: number } {
    const now = this.deps.now();
    const total = (this.c.warmupMs + this.c.measureMs) / 1000;
    let received = 0;
    for (let i = 0; i < this.arrival.length; i++) if (!Number.isNaN(this.arrival[i]!)) received++;
    return {
      phase: this.phase,
      code: this.code === null ? null : formatCode(this.code),
      join_left_s: this.phase === 'sala' && this.roomUntil !== null ? Math.max(0, Math.ceil((this.roomUntil - now) / 1000)) : null,
      pings: this.phase === 'pings' ? this.before.length : this.after.length,
      elapsed_s: this.t0 === null ? 0 : Math.floor(Math.min(total, (now - this.t0) / 1000)),
      total_s: total,
      sent: this.sentW + this.sentM,
      received,
    };
  }

  private reset(): void {
    this.conn = {
      admit_status: null, open_ms: null, close_code: null, wait_partner_ms: null, completed: false, stopped_by_user: false,
      peer_left: false, peer_left_at_ms: null, hidden_during: false, hidden_at_ms: null, focus_lost: 0, wake_lock: null,
      failed_stage: null, error: null,
    };
    this.healthFailed = null;
    this.windowOpen = null;
    this.stopRequested = false;
    this.phase = 'parado';
    this.code = this.roomUntil = null;
    this.ws = null;
    this.closed = null;
    this.ctl = [];
    this.nextPing = 0;
    this.pingsAt.clear();
    this.pongs.clear();
    this.before = [];
    this.after = [];
    this.beforeSent = this.afterSent = 0;
    this.rttPeer = this.t0 = null;
    this.arrival = new Float64Array(relayFrames(this.c)).fill(NaN);
    this.maxSeq = -1;
    this.outOfOrder = this.duplicates = this.unexpected = this.gaps = 0;
    this.lastRecvAt = this.maxGap = null;
    this.sentW = this.sentM = this.skipped = this.lateOver5 = 0;
    this.intervals = [];
    this.lastSend = null;
    this.measuredEnd = this.peerLeftAt = null;
  }

  // ---------- espera genérica (acordada por mensagem, queda ou parada) ----------
  private wake(): void {
    for (const w of [...this.wakers]) w();
  }
  private abort(): Abort | undefined {
    if (this.closed) return { kind: 'fechou' };
    if (this.stopRequested) return { kind: 'parado' };
    return undefined;
  }
  private waitUntil<R>(check: () => R | undefined, timeoutMs: number): Promise<R | Abort | 'tempo'> {
    return new Promise((resolve) => {
      let h: unknown = null;
      let done = false;
      const finish = (r: R | Abort | 'tempo') => {
        if (done) return;
        done = true;
        if (h !== null) this.t.clear(h);
        this.wakers.delete(w);
        resolve(r);
      };
      const w = () => {
        const a = this.abort();
        if (a) return finish(a);
        const r = check();
        if (r !== undefined) finish(r);
      };
      this.wakers.add(w);
      h = this.t.set(() => finish('tempo'), timeoutMs);
      w();
    });
  }
  private sleep(ms: number): Promise<void> {
    return this.waitUntil(() => undefined, ms).then(() => undefined);
  }
  private takeCtl(types: string[]): Ctl | undefined {
    const i = this.ctl.findIndex((m) => types.includes(m.t));
    return i < 0 ? undefined : this.ctl.splice(i, 1)[0];
  }
  private say(m: Record<string, unknown>): boolean {
    try {
      this.ws!.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }
  private ping(): number {
    const n = this.nextPing++;
    this.pingsAt.set(n, this.deps.now());
    this.say({ t: 'ping', n });
    return n;
  }

  // ---------- recepção ----------
  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      let m: unknown;
      try {
        m = JSON.parse(data);
      } catch {
        this.unexpected++;
        return;
      }
      if (typeof m !== 'object' || m === null || typeof (m as Ctl).t !== 'string') {
        this.unexpected++;
        return;
      }
      const msg = m as Ctl;
      if (msg.t === 'pong') {
        const at = typeof msg.n === 'number' ? this.pingsAt.get(msg.n) : undefined;
        if (at !== undefined) {
          this.pingsAt.delete(msg.n as number);
          this.pongs.set(msg.n as number, this.deps.now() - at);
        }
      } else if (msg.t === 'saiu') {
        if (this.peerLeftAt === null) this.peerLeftAt = this.deps.now();
      } else this.ctl.push(msg);
      this.wake();
      return;
    }
    this.onFrame(data);
  }

  private onFrame(data: unknown): void {
    const now = this.deps.now();
    const m = decodeMsg(data);
    if (!m || this.t0 === null || m.seq >= this.arrival.length) {
      this.unexpected++;
      return;
    }
    if (!Number.isNaN(this.arrival[m.seq]!)) {
      this.duplicates++;
      return;
    }
    this.arrival[m.seq] = now;
    if (m.seq < this.maxSeq) this.outOfOrder++;
    else this.maxSeq = m.seq;
    const W = this.warmupFrames();
    if (m.seq >= W) {
      if (this.lastRecvAt !== null) {
        const gap = now - this.lastRecvAt;
        if (gap > 250) this.gaps++;
        this.maxGap = Math.max(this.maxGap ?? 0, gap);
      }
      this.lastRecvAt = now;
    }
    if (m.seq === this.arrival.length - 1) this.wake();
  }

  private warmupFrames(): number {
    return Math.round((this.c.warmupMs / 1000) * this.c.hz);
  }

  // ---------- execução ----------
  async run(bases: Bases, route: NetRoute, how: { create: true } | { join: string }, onProgress: () => void = () => {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ran = true;
    this.reset();
    this.route = route;
    this.role = 'create' in how ? 'criou' : 'entrou';
    let wake: { release(): Promise<void> } | null = null;
    let keepalive: unknown = null;
    const fail = (stage: RelayStage, error: string) => {
      this.conn.failed_stage = stage;
      this.conn.error = error;
    };
    try {
      let code: string | null = null;
      if ('join' in how) {
        code = normalizeCode(how.join);
        if (!code) return fail('codigo', `código inválido: são ${CODE_LEN} letras/números (sem 0, O, 1 e I)`);
      }
      this.phase = 'conectando';
      onProgress();
      const h = await probeHealth(this.deps, route, `${bases.httpBase}/net/health`);
      if (!h.json_ok) {
        this.healthFailed = describe(h);
        return;
      }
      this.windowOpen = h.server_open;
      if (!h.server_open) return;

      if (this.deps.wakeLock) {
        try {
          wake = await this.deps.wakeLock();
          this.conn.wake_lock = wake ? 'ativo' : 'indisponivel';
        } catch {
          this.conn.wake_lock = 'negado';
        }
      } else this.conn.wake_lock = 'indisponivel';

      const opened = await this.open(bases);
      if (!opened.ok) return fail(opened.stage, opened.error);
      const sessionEnd = opened.at + this.c.sessionS * 1000;
      const kick = () => {
        keepalive = this.t.set(() => {
          if (this.phase === 'sala' || this.phase === 'pronto') this.ping();
          kick();
        }, this.c.keepaliveMs);
      };
      kick();

      // Sala
      const roomStart = this.deps.now();
      if (code === null) {
        this.say({ t: 'criar' });
        const r = await this.waitUntil(() => this.takeCtl(['sala', 'erro']), this.c.replyTimeoutMs);
        if (r === 'tempo') return fail('sala', 'o servidor não respondeu ao "criar sala"');
        if (isAbort(r)) return this.aborted(r);
        if (r.t === 'erro' || typeof r.codigo !== 'string') return fail('sala', `o servidor recusou: ${String(r.motivo ?? 'sem código')}`);
        this.code = r.codigo;
        this.roomUntil = roomStart + joinWindowMs(this.c);
        this.phase = 'sala';
        onProgress();
        const p = await this.waitUntil(() => this.takeCtl(['par', 'erro']), Math.max(0, Math.min(this.roomUntil, sessionEnd - this.c.needAfterPairMs) - this.deps.now()));
        if (p === 'tempo') return fail('par', `ninguém entrou na sala em ${Math.round(joinWindowMs(this.c) / 1000)} s`);
        if (isAbort(p)) return this.aborted(p);
        if (p.t === 'erro') return fail('par', String(p.motivo ?? 'erro na sala'));
      } else {
        this.code = code;
        this.say({ t: 'entrar', codigo: code });
        const r = await this.waitUntil(() => this.takeCtl(['par', 'erro']), this.c.replyTimeoutMs);
        if (r === 'tempo') return fail('sala', 'o servidor não respondeu ao "entrar"');
        if (isAbort(r)) return this.aborted(r);
        if (r.t === 'erro') return fail('sala', String(r.motivo ?? 'erro na sala'));
      }
      this.conn.wait_partner_ms = Math.round(this.deps.now() - roomStart);
      this.code = null; // o código não serve mais para nada: sai até da memória

      // RTT antes
      this.phase = 'pings';
      onProgress();
      const pb = await this.pings(this.before, () => this.beforeSent++, onProgress);
      if (pb) return this.aborted(pb);
      if (this.peerLeftAt !== null) return this.peerLeft();
      const self = percentile([...this.before].sort((a, b) => a - b), 50);

      // Largada
      this.phase = 'pronto';
      onProgress();
      this.say(self === null ? { t: 'pronto' } : { t: 'pronto', rtt: Math.round(self) });
      const go = await this.waitUntil(() => (this.peerLeftAt !== null ? ({ t: 'saiu' } as Ctl) : this.takeCtl(['comecar', 'erro'])), this.c.readyTimeoutMs);
      if (go === 'tempo') return fail('largada', 'o outro aparelho não ficou pronto a tempo');
      if (isAbort(go)) return this.aborted(go);
      if (go.t === 'saiu') return this.peerLeft();
      if (go.t === 'erro') return fail('largada', String(go.motivo ?? 'erro na largada'));
      this.t0 = this.deps.now();
      this.rttPeer = typeof go.rtt_outro === 'number' && Number.isFinite(go.rtt_outro) ? go.rtt_outro : null;

      // Medição
      this.phase = 'medindo';
      onProgress();
      const end = await this.pump(onProgress);
      if (end === 'parado' || end === 'fechou') return this.aborted({ kind: end });
      if (end === 'saiu') return this.peerLeft();
      const last = this.arrival.length - 1;
      const g = await this.waitUntil(() => (!Number.isNaN(this.arrival[last]!) || this.peerLeftAt !== null ? true : undefined), this.c.graceMs);
      this.measuredEnd = this.deps.now();
      if (isAbort(g)) return this.aborted(g);
      this.conn.completed = true;

      // RTT depois (o outro pode já ter saído: os pings continuam valendo)
      this.phase = 'finalizando';
      onProgress();
      // Uma parada ou queda aqui não muda o resultado: a medição já terminou.
      await this.pings(this.after, () => this.afterSent++, onProgress);
    } finally {
      if (keepalive !== null) this.t.clear(keepalive);
      if (this.measuredEnd === null && this.t0 !== null) this.measuredEnd = this.deps.now();
      this.code = null;
      await this.close();
      try {
        await wake?.release();
      } catch {
        /* já liberado */
      }
      this.phase = 'parado';
      this.running = false;
      onProgress();
    }
  }

  private aborted(a: Abort): void {
    if (this.measuredEnd === null && this.t0 !== null) this.measuredEnd = this.deps.now();
    if (a.kind === 'parado') {
      this.conn.stopped_by_user = true;
      return;
    }
    const code = this.closed?.code ?? null;
    if (code === 4002) {
      this.conn.failed_stage = 'limite';
      const silent = this.deps.now() - (this.lastRecvAt ?? this.t0 ?? this.deps.now());
      this.conn.error = limitError(this.closed?.reason ?? '', silent);
      return;
    }
    this.conn.failed_stage = 'conexao';
    this.conn.error = code === 4001 ? 'o servidor encerrou a sessão (4001: prazo, fim da janela ou inatividade)' : `conexão caiu (código ${code ?? 1006})`;
  }

  private peerLeft(): void {
    const now = this.deps.now();
    if (this.measuredEnd === null && this.t0 !== null) this.measuredEnd = now;
    this.conn.peer_left = true;
    this.conn.peer_left_at_ms = this.t0 === null ? null : Math.round((this.peerLeftAt ?? now) - this.t0);
  }

  // 20 pings em sequência: o próximo sai quando o anterior responde (ou em 1 s).
  private async pings(into: number[], count: () => void, onProgress: () => void): Promise<Abort | undefined> {
    for (let i = 0; i < this.c.pings; i++) {
      const n = this.ping();
      count();
      const r = await this.waitUntil(() => this.pongs.get(n), this.c.pingTimeoutMs);
      if (typeof r === 'object') return r;
      if (r !== 'tempo') into.push(r);
      onProgress();
      if (this.c.pingGapMs > 0) {
        await this.sleep(this.c.pingGapMs);
        const a = this.abort();
        if (a) return a;
      }
    }
    return undefined;
  }

  // Admissão + abertura do WebSocket em até 5 s.
  private async open(bases: Bases): Promise<{ ok: true; at: number } | { ok: false; stage: RelayStage; error: string }> {
    const timeout = this.deps.timeoutMs ?? 5000;
    let ticket: string;
    const ctrl = new AbortController();
    const timer = this.t.set(() => ctrl.abort(), timeout);
    try {
      const res = await this.deps.fetch(`${bases.httpBase}/net/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'relay', duration_s: this.c.sessionS }),
        cache: 'no-store',
        credentials: 'omit',
        signal: ctrl.signal,
      });
      this.conn.admit_status = res.status;
      const text = await res.text();
      if (res.status !== 201) return { ok: false, stage: 'admissao', error: admitError(res.status) };
      const b = JSON.parse(text) as { bilhete?: unknown };
      if (typeof b.bilhete !== 'string' || !TICKET_RE.test(b.bilhete)) return { ok: false, stage: 'admissao', error: 'admissão sem bilhete válido' };
      ticket = b.bilhete;
    } catch {
      return { ok: false, stage: 'admissao', error: ctrl.signal.aborted ? `admissão sem resposta em ${timeout / 1000} s` : 'admissão falhou: rede/CORS/CSP' };
    } finally {
      this.t.clear(timer);
    }
    const t0 = this.deps.now();
    let ws: WsLike;
    try {
      ws = new this.deps.WebSocket(`${bases.wsBase}/net/ws/relay?bilhete=${ticket}`);
    } catch {
      return { ok: false, stage: 'upgrade', error: 'o navegador recusou criar o WebSocket (endereço ou CSP)' };
    }
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* sem binaryType */
    }
    let isOpen = false;
    ws.addEventListener('open', () => {
      isOpen = true;
      this.wake();
    });
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('close', (ev) => {
      if (!this.closed) this.closed = { code: typeof ev.code === 'number' ? ev.code : null, reason: typeof ev.reason === 'string' ? ev.reason.slice(0, 60) : '' };
      if (this.conn.close_code === null) this.conn.close_code = this.closed.code ?? 1006;
      this.wake();
    });
    this.ws = ws;
    const r = await this.waitUntil(() => (isOpen ? true : undefined), timeout);
    if (r === true) {
      this.conn.open_ms = Math.round(this.deps.now() - t0);
      return { ok: true, at: t0 };
    }
    this.ws = null;
    try {
      ws.close(1000, 'fim');
    } catch {
      /* já fechado */
    }
    if (r === 'tempo') return { ok: false, stage: 'upgrade', error: `WebSocket não abriu em ${timeout / 1000} s` };
    if (r.kind === 'parado') return { ok: false, stage: 'upgrade', error: 'interrompido antes de abrir' };
    return { ok: false, stage: 'upgrade', error: `WebSocket recusado antes de abrir (código ${this.closed?.code ?? '—'})` };
  }

  // Envia os quadros k = 0…N−1 nos prazos largada + k × período. Termina no fim, na parada, na queda
  // ou quando o outro sai.
  private pump(onProgress: () => void): Promise<'done' | 'parado' | 'fechou' | 'saiu'> {
    const period = 1000 / this.c.hz;
    const N = this.arrival.length;
    const W = this.warmupFrames();
    const t0 = this.t0!;
    let k = 0;
    let timer: unknown = null;
    let lastUi = 0;
    return new Promise((resolve) => {
      let ended = false;
      const end = (r: 'done' | 'parado' | 'fechou' | 'saiu') => {
        if (ended) return;
        ended = true;
        if (timer !== null) this.t.clear(timer);
        this.wakers.delete(watch);
        resolve(r);
      };
      const watch = () => {
        const a = this.abort();
        if (a) return end(a.kind);
        if (this.peerLeftAt !== null) end('saiu');
      };
      this.wakers.add(watch);
      const tick = () => {
        timer = null;
        if (ended) return;
        watch();
        if (ended) return;
        const now = this.deps.now();
        const due = Math.min(N - 1, Math.floor((now - t0) / period + 1e-9));
        const backlog = due - k + 1;
        if (backlog > this.c.maxBacklog) {
          const skip = backlog - this.c.maxBacklog;
          for (let j = k; j < k + skip; j++) if (j >= W) this.skipped++;
          k += skip;
        }
        while (k <= due) {
          try {
            this.ws!.send(encodeMsg(k, now));
          } catch {
            return end('fechou');
          }
          if (k >= W) {
            this.sentM++;
            if (now - (t0 + k * period) > 5) this.lateOver5++;
            if (this.lastSend && this.lastSend.k === k - 1 && this.lastSend.k >= W) this.intervals.push(now - this.lastSend.at);
          } else this.sentW++;
          this.lastSend = { k, at: now };
          k++;
        }
        if (now - lastUi >= 500) {
          lastUi = now;
          onProgress();
        }
        if (k >= N) return end('done');
        timer = this.t.set(tick, Math.max(0, t0 + k * period - this.deps.now()));
      };
      tick();
    });
  }

  private async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || this.closed) return;
    await new Promise<void>((resolve) => {
      const h = this.t.set(resolve, 2000);
      const w = () => {
        if (this.closed) {
          this.t.clear(h);
          this.wakers.delete(w);
          resolve();
        }
      };
      this.wakers.add(w);
      try {
        ws.close(1000, 'fim');
      } catch {
        this.t.clear(h);
        this.wakers.delete(w);
        resolve();
      }
    });
  }

  // ---------- resultado ----------
  private expectedUpTo(): number {
    // Quadros cujo prazo passou (com 1 s para chegar) antes do fim da medição.
    const N = this.arrival.length;
    if (this.t0 === null || this.measuredEnd === null) return 0;
    if (this.conn.completed) return N;
    const period = 1000 / this.c.hz;
    return Math.max(0, Math.min(N, Math.floor((this.measuredEnd - this.t0 - 1000) / period) + 1));
  }

  result(): NetRelayResult {
    const period = 1000 / this.c.hz;
    const W = this.warmupFrames();
    const upTo = this.expectedUpTo();
    const expected = Math.max(0, upTo - W);
    const raw: { seq: number; late: number }[] = [];
    let recvW = 0;
    if (this.t0 !== null) {
      for (let s = 0; s < upTo; s++) {
        const a = this.arrival[s]!;
        if (Number.isNaN(a)) continue;
        if (s < W) recvW++;
        else raw.push({ seq: s, late: a - (this.t0 + s * period) });
      }
    }
    const sortedB = [...this.before].sort((a, b) => a - b);
    const self = percentile(sortedB, 50);
    const peer = this.rttPeer;
    const corr = self !== null && peer !== null ? (self - peer) / 2 : null;
    const basis: 'corrigido' | 'bruto' | null = raw.length === 0 && expected === 0 ? null : corr === null ? 'bruto' : 'corrigido';
    const lat = raw.map((r) => ({ seq: r.seq, late: r.late + (corr ?? 0) }));
    const sortedRaw = raw.map((r) => r.late).sort((a, b) => a - b);
    const sortedLat = lat.map((r) => r.late).sort((a, b) => a - b);
    const curve = basis === null ? [] : dCurve(sortedLat, expected, this.c.hz, this.c.dMax);
    const sortedInt = [...this.intervals].sort((a, b) => a - b);
    const measuredMs = this.t0 === null || this.measuredEnd === null ? null : Math.max(0, Math.min(this.measuredEnd, this.t0 + this.c.warmupMs + this.c.measureMs) - this.t0 - this.c.warmupMs);
    const ratio = expected ? Math.round((raw.length / expected) * 10000) / 10000 : null;
    const base: Omit<NetRelayResult, 'status' | 'detail'> = {
      ran: this.ran,
      window_open: this.windowOpen,
      role: this.role,
      pair_label: this.pairLabel,
      route: this.route,
      server_region: SERVER_REGION,
      config: { hz: this.c.hz, msg_bytes: MSG_BYTES, warmup_s: this.c.warmupMs / 1000, measure_s: this.c.measureMs / 1000, session_s: this.c.sessionS, pings: this.c.pings },
      connection: { ...this.conn },
      rtt_before: rttSummary(this.beforeSent, this.before),
      rtt_after: rttSummary(this.afterSent, this.after),
      rtt_self_ms: r1(self),
      rtt_peer_ms: peer,
      uncertainty_ms: self !== null && peer !== null ? round1((self + peer) / 2) : null,
      measured_ms: measuredMs === null ? null : Math.round(measuredMs),
      sent: this.sentM,
      skipped: this.skipped,
      cadence: {
        rate_hz: measuredMs ? round1(this.sentM / (measuredMs / 1000)) : null,
        interval_mean_ms: sortedInt.length ? round1(sortedInt.reduce((a, b) => a + b, 0) / sortedInt.length) : null,
        interval_p95_ms: r1(percentile(sortedInt, 95)),
        interval_p99_ms: r1(percentile(sortedInt, 99)),
        late_over_5ms: this.lateOver5,
      },
      expected,
      received: raw.length,
      missing: Math.max(0, expected - raw.length),
      received_ratio: ratio,
      out_of_order: this.outOfOrder,
      duplicates: this.duplicates,
      unexpected: this.unexpected,
      warmup: { sent: this.sentW, received: recvW },
      gaps: { over_250ms: this.gaps, max_ms: r1(this.maxGap) },
      lateness_raw: latSummary(sortedRaw),
      lateness: corr === null ? latSummary([]) : latSummary(sortedLat),
      histogram: histogram(sortedLat.map((x) => Math.max(0, x))),
      curve_basis: basis,
      d_curve: curve,
      d_min_1pct: dMinWithin(curve, 1),
      d_min_01pct: dMinWithin(curve, 0.1),
      worst: [...lat].sort((a, b) => b.late - a.late).slice(0, WORST_N).map((r) => ({ t_ms: Math.round((r.seq - W) * period), lateness_ms: round1(r.late) })),
    };
    return { ...this.status(base), ...base };
  }

  private status(b: Omit<NetRelayResult, 'status' | 'detail'>): Basic {
    const c = this.conn;
    if (this.running) return { status: 'SKIP', detail: `em andamento (${this.phase})…` };
    if (!this.ran) return { status: 'SKIP', detail: 'ainda não feito (precisa da janela aberta e de dois aparelhos)' };
    if (c.failed_stage === 'codigo') return { status: 'INV', detail: `${c.error}. Nada foi gasto no servidor.` };
    if (this.healthFailed) return { status: 'RP', detail: `Servidor inacessível pelo caminho da sonda: ${this.healthFailed}.` };
    if (this.windowOpen === false) return { status: 'INV', detail: 'Rede FECHADA no servidor: abra a janela pelo SSH (bt3probe-janela abrir) e repita.' };
    const lat = b.lateness.p50 !== null ? b.lateness : b.lateness_raw;
    const kind = b.lateness.p50 !== null ? 'corrigido' : 'bruto';
    const unc = b.uncertainty_ms === null ? '' : ` (±${b.uncertainty_ms} ms)`;
    const dm = (d: number | null) => (d === null ? `> ${this.c.dMax}` : `${d} (${framesToMs(d, this.c.hz)} ms)`);
    const summary =
      lat.p50 === null
        ? `recebidos ${b.received} de ${b.expected}`
        : `atraso ${kind} p50 ${lat.p50} · p95 ${lat.p95} · p99 ${lat.p99} · máx ${lat.max} ms${unc}; RTT próprio ${b.rtt_self_ms ?? '—'} · do outro ${b.rtt_peer_ms ?? '—'} ms; D com ≤ 1% de travadas: ${dm(b.d_min_1pct)}; com ≤ 0,1%: ${dm(b.d_min_01pct)}`;
    if (c.stopped_by_user) return { status: 'INV', detail: b.measured_ms ? `Interrompido pela pessoa aos ${Math.round(b.measured_ms / 1000)} s de medição. ${summary}.` : 'Interrompido antes da medição.' };
    if (c.failed_stage === 'admissao' || c.failed_stage === 'upgrade') {
      const soft = c.admit_status === 429 || c.admit_status === 503;
      return { status: soft ? 'INV' : 'RP', detail: `Não conectou (${c.failed_stage}): ${c.error}.` };
    }
    if (c.failed_stage === 'sala' || c.failed_stage === 'par' || c.failed_stage === 'largada') return { status: 'INV', detail: `Sala: ${c.error}. Crie outra sala e repita.` };
    if (c.failed_stage === 'limite') return { status: 'RP', detail: `${c.error}. ${summary}.` };
    if (c.failed_stage === 'conexao') return { status: 'RP', detail: `Interrompido: ${c.error}${b.measured_ms ? ` aos ${Math.round(b.measured_ms / 1000)} s de medição` : ''}. ${summary}.` };
    if (c.peer_left) return { status: 'INV', detail: `O outro aparelho saiu${c.peer_left_at_ms !== null ? ` aos ${Math.round(c.peer_left_at_ms / 1000)} s` : ' antes da largada'} (veja o relatório dele). ${summary}.` };
    if (!c.completed) return { status: 'RP', detail: `Não completou a medição. ${summary}.` };
    if (c.hidden_during) return { status: 'INV', detail: `Página escondida aos ${Math.round((c.hidden_at_ms ?? 0) / 1000)} s (segundo plano é da F3d). ${summary}.` };
    const ratio = b.received_ratio;
    const pct = ratio === null ? '—' : `${(ratio * 100).toFixed(1).replace('.', ',')}%`;
    if (ratio === null || ratio < 0.95) return { status: 'RP', detail: `Chegaram ${pct} dos quadros do outro (abaixo de 95%). ${summary}.` };
    const jog = b.d_min_01pct === null ? '' : ` Jogável (proposta): D = ${b.d_min_01pct} quadros (${framesToMs(b.d_min_01pct, this.c.hz)} ms).`;
    if (ratio < 0.99) return { status: 'INV', detail: `Chegaram ${pct} dos quadros do outro (entre 95% e 99%). ${summary}.${jog}` };
    return { status: 'AP', detail: `${summary}.${jog}` };
  }
}

function rttSummary(sent: number, xs: number[]): RttSummary {
  const s = [...xs].sort((a, b) => a - b);
  return { sent, answered: xs.length, p50: r1(percentile(s, 50)), p95: r1(percentile(s, 95)) };
}

function latSummary(sorted: number[]): LatenessSummary {
  return {
    p50: r1(percentile(sorted, 50)),
    p95: r1(percentile(sorted, 95)),
    p99: r1(percentile(sorted, 99)),
    p999: r1(percentile(sorted, 99.9)),
    max: r1(sorted.length ? sorted[sorted.length - 1]! : null),
    min: r1(sorted.length ? sorted[0]! : null),
  };
}
