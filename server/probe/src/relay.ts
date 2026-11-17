// F3c: salas de relay entre DOIS aparelhos (plano da F3c). Tudo na memória do processo: nenhum SQLite
// por mensagem, e um reinício desfaz as salas (as sessões já ficam gastas pelo recoverOnStart).
//
// Cada aparelho tem a SUA sessão admitida (bilhete próprio, limites próprios). O código da sala só junta
// duas sessões já admitidas: não é identidade nem credencial, vence em 2 min se ninguém entrar, e nunca
// vai para log ou relatório.
//
// Mensagens de controle (texto JSON, ≤ 64 bytes, como qualquer mensagem):
//   → {"t":"criar"}                      ← {"t":"sala","codigo":"K7Q4MD"}
//   → {"t":"entrar","codigo":"K7Q4MD"}   ← {"t":"par"} para os dois
//   → {"t":"ping","n":3}                 ← {"t":"pong","n":3}            (RTT até o servidor; mantém viva)
//   → {"t":"pronto","rtt":185}           ← {"t":"comecar","rtt_outro":190} para os dois, quando ambos prontos
//                                         ← {"t":"saiu"} quando o outro sai (a sala acaba)
//                                         ← {"t":"erro","motivo":"..."}
// Quadros binários: depois da largada, tudo o que um manda é repassado ao outro, sem mudança.
import { randomInt } from 'node:crypto';
import type { Logger } from './log.js';
import { CLOSE_LIMIT, type Conn } from './ws/conn.js';

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 símbolos, sem 0/O e 1/I
export const CODE_LEN = 6; // 32^6 ≈ 1 bilhão de códigos
export const ROOM_WAIT_MS = 120_000;
export const MAX_JOIN_TRIES = 5;

interface Room {
  code: string;
  members: Conn[];
  createdAt: number;
  ready: Map<Conn, number | null>;
  started: boolean;
}

const send = (c: Conn, msg: Record<string, unknown>) => c.send(JSON.stringify(msg));

export function normalizeCode(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.toUpperCase().replace(/[\s-]/g, '');
  if (t.length !== CODE_LEN) return null;
  for (const ch of t) if (!CODE_ALPHABET.includes(ch)) return null;
  return t;
}

export class Rooms {
  private byCode = new Map<string, Room>();
  private byConn = new Map<Conn, Room>();
  private tries = new WeakMap<Conn, number>();

  constructor(
    private now: () => number,
    private log: Logger,
    private pick: (n: number) => number = (n) => randomInt(n),
  ) {}

  get active(): number {
    return this.byCode.size;
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[this.pick(CODE_ALPHABET.length)];
      if (!this.byCode.has(c)) return c;
    }
  }

  /** Mensagem de texto de uma conexão de relay. */
  control(c: Conn, text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return send(c, { t: 'erro', motivo: 'mensagem inválida' });
    }
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return send(c, { t: 'erro', motivo: 'mensagem inválida' });
    const msg = m as Record<string, unknown>;
    switch (msg.t) {
      case 'ping': {
        const n = msg.n;
        if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > 1_000_000) return send(c, { t: 'erro', motivo: 'ping inválido' });
        return send(c, { t: 'pong', n });
      }
      case 'criar': {
        if (this.byConn.has(c)) return send(c, { t: 'erro', motivo: 'já está numa sala' });
        const room: Room = { code: this.newCode(), members: [c], createdAt: this.now(), ready: new Map(), started: false };
        this.byCode.set(room.code, room);
        this.byConn.set(c, room);
        this.log('sala_criada', {});
        return send(c, { t: 'sala', codigo: room.code });
      }
      case 'entrar': {
        if (this.byConn.has(c)) return send(c, { t: 'erro', motivo: 'já está numa sala' });
        const tries = (this.tries.get(c) ?? 0) + 1;
        this.tries.set(c, tries);
        if (tries > MAX_JOIN_TRIES) return c.close(CLOSE_LIMIT, 'tentativas demais');
        const code = normalizeCode(msg.codigo);
        const room = code ? this.byCode.get(code) : undefined;
        if (!room || this.now() - room.createdAt >= ROOM_WAIT_MS) return send(c, { t: 'erro', motivo: 'código inválido ou vencido' });
        if (room.members.length >= 2) return send(c, { t: 'erro', motivo: 'sala cheia' });
        room.members.push(c);
        this.byConn.set(c, room);
        this.log('sala_completa', {});
        for (const x of room.members) send(x, { t: 'par' });
        return;
      }
      case 'pronto': {
        const room = this.byConn.get(c);
        if (!room || room.members.length !== 2) return send(c, { t: 'erro', motivo: 'sala sem par' });
        if (room.started) return;
        const rtt = typeof msg.rtt === 'number' && Number.isFinite(msg.rtt) && msg.rtt >= 0 && msg.rtt <= 60_000 ? Math.round(msg.rtt) : null;
        room.ready.set(c, rtt);
        if (room.ready.size === 2) {
          room.started = true;
          const [a, b] = room.members as [Conn, Conn];
          send(a, { t: 'comecar', rtt_outro: room.ready.get(b) ?? null });
          send(b, { t: 'comecar', rtt_outro: room.ready.get(a) ?? null });
          this.log('sala_largada', {});
        }
        return;
      }
      default:
        return send(c, { t: 'erro', motivo: 'mensagem inválida' });
    }
  }

  /** Quadro binário: só depois da largada, e só para o OUTRO membro. */
  relay(c: Conn, data: Buffer): void {
    const room = this.byConn.get(c);
    if (!room || !room.started) return;
    for (const x of room.members) if (x !== c) x.send(data);
  }

  /** Conexão terminou (qualquer motivo): a sala acaba e o outro é avisado. */
  left(c: Conn): void {
    const room = this.byConn.get(c);
    if (!room) return;
    this.byConn.delete(c);
    this.byCode.delete(room.code);
    for (const x of room.members) {
      if (x === c) continue;
      this.byConn.delete(x);
      send(x, { t: 'saiu' });
    }
    this.log('sala_encerrada', { reason: room.started ? 'depois da largada' : 'antes da largada' });
  }

  /** Salas esperando o segundo aparelho há 2 min ou mais vencem. */
  sweep(): void {
    const now = this.now();
    for (const room of [...this.byCode.values()]) {
      if (room.members.length < 2 && now - room.createdAt >= ROOM_WAIT_MS) {
        this.byCode.delete(room.code);
        for (const x of room.members) {
          this.byConn.delete(x);
          send(x, { t: 'erro', motivo: 'sala venceu sem o segundo aparelho' });
        }
        this.log('sala_expirada', {});
      }
    }
  }
}
