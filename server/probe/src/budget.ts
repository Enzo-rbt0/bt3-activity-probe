// Orçamento e admissão. Modelo de reserva por sessão (plano F3 v3, seção 3.2):
//  - POST /net/session reserva, numa transação BEGIN IMMEDIATE, a cota de mensagens da sessão e emite
//    um bilhete aleatório de 128 bits, de uso único, válido por 30 s;
//  - o upgrade do WebSocket resgata o bilhete (transacional, uso único);
//  - durante a sessão o banco não é tocado; no fim, a sobra é devolvida uma única vez (idempotente);
//  - se a devolução falhar ou o processo cair, a cota continua gasta (conservador).
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export interface Limits {
  maxConcurrent: number;
  maxAdmissionsPerDay: number;
  maxReservedPerDay: number;
  ticketTtlMs: number;
  maxDurationMs: number;
  defaultDurationMs: number;
  targetHz: number;
  margin: number;
  maxMsgBytes: number;
  maxRatePerSec: number;
  idleMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxConcurrent: 4,
  maxAdmissionsPerDay: 30,
  maxReservedPerDay: 60_000,
  ticketTtlMs: 30_000,
  maxDurationMs: 180_000,
  defaultDurationMs: 60_000,
  targetHz: 60,
  margin: 1.1,
  maxMsgBytes: 64,
  maxRatePerSec: 120,
  idleMs: 60_000,
};

export type Kind = 'echo';
export const KINDS: readonly string[] = ['echo']; // 'relay' entra na F3c

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// Arredonda a 3 casas antes do teto: 60 × 60 × 1,1 dá 3960,0000000000005 em ponto flutuante,
// e o teto direto reservaria 3961.
export function quotaFor(durationMs: number, l: Limits): number {
  return Math.ceil(Math.round((durationMs / 1000) * l.targetHz * l.margin * 1000) / 1000);
}

export type AdmitResult =
  | { ok: true; ticket: string; sessionId: string; expiresAt: number; durationMs: number; reserved: number }
  | { ok: false; status: 429; reason: string };

export interface Session { id: string; deadline: number; reserved: number }

interface DailyRow { admissions: number; reserved_msgs: number }

export class Budget {
  constructor(private db: Db, private limits: Limits = DEFAULT_LIMITS) {}

  private daily(day: string): DailyRow {
    this.db.raw.prepare('INSERT OR IGNORE INTO daily (day) VALUES (?)').run(day);
    return this.db.raw.prepare('SELECT admissions, reserved_msgs FROM daily WHERE day = ?').get(day) as unknown as DailyRow;
  }

  // Bilhetes vencidos sem uso nunca mais podem ser resgatados: liberam a vaga e devolvem a reserva.
  private reapExpiredTickets(now: number): void {
    const rows = this.db.raw
      .prepare('SELECT id, day, reserved_msgs FROM sessions WHERE ended_at IS NULL AND redeemed_at IS NULL AND ticket_expires_at <= ?')
      .all(now) as unknown as { id: string; day: string; reserved_msgs: number }[];
    for (const r of rows) {
      this.db.raw.prepare('UPDATE sessions SET ended_at = ?, used_msgs = 0 WHERE id = ? AND ended_at IS NULL').run(now, r.id);
      this.db.raw.prepare('UPDATE daily SET reserved_msgs = MAX(0, reserved_msgs - ?) WHERE day = ?').run(r.reserved_msgs, r.day);
    }
  }

  private activeCount(now: number): number {
    const r = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL AND (
           (redeemed_at IS NULL AND ticket_expires_at > ?) OR (redeemed_at IS NOT NULL AND deadline > ?))`,
      )
      .get(now, now) as unknown as { n: number };
    return r.n;
  }

  admit(kind: Kind, durationMs: number, now: number): AdmitResult {
    const dur = Math.min(Math.max(1000, Math.floor(durationMs)), this.limits.maxDurationMs);
    const reserved = quotaFor(dur, this.limits);
    return this.db.tx(() => {
      this.reapExpiredTickets(now);
      const day = utcDay(now);
      const d = this.daily(day);
      if (d.admissions >= this.limits.maxAdmissionsPerDay) return { ok: false, status: 429, reason: 'limite de admissões do dia' } as const;
      if (this.activeCount(now) >= this.limits.maxConcurrent) return { ok: false, status: 429, reason: 'limite de sessões simultâneas' } as const;
      if (d.reserved_msgs + reserved > this.limits.maxReservedPerDay) return { ok: false, status: 429, reason: 'orçamento de mensagens do dia' } as const;
      const sessionId = randomUUID();
      const ticket = randomBytes(16).toString('hex');
      const expiresAt = now + this.limits.ticketTtlMs;
      this.db.raw
        .prepare('INSERT INTO sessions (id, ticket, kind, day, duration_ms, reserved_msgs, ticket_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sessionId, ticket, kind, day, dur, reserved, expiresAt);
      this.db.raw.prepare('UPDATE daily SET admissions = admissions + 1, reserved_msgs = reserved_msgs + ? WHERE day = ?').run(reserved, day);
      return { ok: true, ticket, sessionId, expiresAt, durationMs: dur, reserved } as const;
    });
  }

  // Resgate de uso único. O prazo da sessão nunca passa do fim da janela.
  redeem(ticket: string, windowUntil: number, now: number): Session | null {
    if (!/^[0-9a-f]{32}$/.test(ticket)) return null;
    return this.db.tx(() => {
      const r = this.db.raw
        .prepare('SELECT id, duration_ms, reserved_msgs, ticket_expires_at, redeemed_at, ended_at FROM sessions WHERE ticket = ?')
        .get(ticket) as unknown as
        | { id: string; duration_ms: number; reserved_msgs: number; ticket_expires_at: number; redeemed_at: number | null; ended_at: number | null }
        | undefined;
      if (!r || r.redeemed_at !== null || r.ended_at !== null || r.ticket_expires_at <= now) return null;
      const deadline = Math.min(windowUntil, now + r.duration_ms);
      const changed = this.db.raw
        .prepare('UPDATE sessions SET redeemed_at = ?, deadline = ? WHERE id = ? AND redeemed_at IS NULL')
        .run(now, deadline, r.id);
      if (Number(changed.changes) !== 1) return null;
      return { id: r.id, deadline, reserved: r.reserved_msgs };
    });
  }

  // Encerramento idempotente: devolve a sobra uma única vez. Devolve true só na primeira chamada.
  end(sessionId: string, used: number, now: number): boolean {
    return this.db.tx(() => {
      const r = this.db.raw.prepare('SELECT day, reserved_msgs, ended_at FROM sessions WHERE id = ?').get(sessionId) as unknown as
        | { day: string; reserved_msgs: number; ended_at: number | null }
        | undefined;
      if (!r || r.ended_at !== null) return false;
      const usedClamped = Math.min(Math.max(0, used), r.reserved_msgs);
      this.db.raw.prepare('UPDATE sessions SET ended_at = ?, used_msgs = ? WHERE id = ? AND ended_at IS NULL').run(now, usedClamped, sessionId);
      this.db.raw.prepare('UPDATE daily SET reserved_msgs = MAX(0, reserved_msgs - ?) WHERE day = ?').run(r.reserved_msgs - usedClamped, r.day);
      return true;
    });
  }

  // Depois de um reinício: o que estava aberto fica gasto por inteiro (sem devolução) e nenhum bilhete
  // emitido antes do reinício vale mais.
  recoverOnStart(now: number): { closed: number } {
    return this.db.tx(() => {
      const res = this.db.raw.prepare('UPDATE sessions SET ended_at = ?, used_msgs = reserved_msgs WHERE ended_at IS NULL').run(now);
      return { closed: Number(res.changes) };
    });
  }

  stats(now: number): { day: string; admissions: number; reserved_msgs: number; active: number } {
    return this.db.tx(() => {
      const day = utcDay(now);
      const d = this.daily(day);
      return { day, admissions: d.admissions, reserved_msgs: d.reserved_msgs, active: this.activeCount(now) };
    });
  }
}
