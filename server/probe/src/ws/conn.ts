// Limites de uma conexão já estabelecida. Tudo na memória: nenhum acesso ao SQLite por mensagem.
// Códigos de fechamento (só depois do upgrade; antes dele a recusa é HTTP):
//   4001 prazo — fim da janela, fim da duração da sessão ou inatividade
//   4002 limite — mensagem grande demais, taxa acima do permitido ou cota reservada esgotada
//   1001 servidor encerrando (SIGTERM)
import type { Limits } from '../budget.js';
import type { Clock, TimerHandle } from '../clock.js';

export const CLOSE_EXPIRED = 4001;
export const CLOSE_LIMIT = 4002;
export const CLOSE_GOING_AWAY = 1001;

export interface Socketish {
  send(data: Buffer): void;
  close(code: number, reason: string): void;
}

export type WindowCheck = () => { open: boolean };

export class Conn {
  received = 0;
  private lastMsgAt: number;
  private tokens: number;
  private tokensAt: number;
  private timer: TimerHandle | null = null;
  closed = false;
  closeCode: number | null = null;

  constructor(
    readonly sessionId: string,
    readonly deadline: number,
    private reserved: number,
    private sock: Socketish,
    private clock: Clock,
    private limits: Limits,
    private window: WindowCheck,
    private onEnd: (c: Conn) => void,
    private respond: (c: Conn, data: Buffer) => void,
  ) {
    const now = clock.now();
    this.lastMsgAt = now;
    this.tokens = limits.maxRatePerSec;
    this.tokensAt = now;
    this.schedule();
  }

  // Timer da própria conexão: dispara no que vier primeiro (prazo ou inatividade).
  // A varredura de 1 s (sweep.ts) é a segunda trava, caso este timer atrase ou falhe.
  private schedule(): void {
    this.timer?.cancel();
    const next = Math.min(this.deadline, this.lastMsgAt + this.limits.idleMs);
    this.timer = this.clock.setTimeout(() => this.check(), Math.max(0, next - this.clock.now()));
  }

  disableOwnTimerForTests(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  // Confere prazo, inatividade e janela. Devolve false se fechou.
  check(): boolean {
    if (this.closed) return false;
    const now = this.clock.now();
    if (!this.window().open) return this.close(CLOSE_EXPIRED, 'janela encerrada'), false;
    if (now >= this.deadline) return this.close(CLOSE_EXPIRED, 'prazo da sessão'), false;
    if (now - this.lastMsgAt >= this.limits.idleMs) return this.close(CLOSE_EXPIRED, 'inatividade'), false;
    return true;
  }

  onMessage(data: Buffer): void {
    if (this.closed) return;
    // Prazo e janela conferidos ANTES de processar: nada é respondido depois do prazo.
    if (!this.check()) return;
    const now = this.clock.now();
    if (data.length > this.limits.maxMsgBytes) return this.close(CLOSE_LIMIT, 'mensagem grande demais');
    // Token bucket: até maxRatePerSec mensagens por segundo, com rajada do mesmo tamanho.
    this.tokens = Math.min(this.limits.maxRatePerSec, this.tokens + ((now - this.tokensAt) / 1000) * this.limits.maxRatePerSec);
    this.tokensAt = now;
    if (this.tokens < 1) return this.close(CLOSE_LIMIT, 'taxa acima do limite');
    this.tokens -= 1;
    this.received++;
    if (this.received > this.reserved) return this.close(CLOSE_LIMIT, 'cota da sessão esgotada');
    this.lastMsgAt = now;
    this.schedule();
    this.respond(this, data);
  }

  send(data: Buffer): void {
    if (!this.closed) this.sock.send(data);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.timer?.cancel();
    try {
      this.sock.close(code, reason);
    } finally {
      this.onEnd(this);
    }
  }

  // Fechamento iniciado pelo cliente ou pela rede.
  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.timer?.cancel();
    this.onEnd(this);
  }
}
