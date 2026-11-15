// Relógio injetável. Em produção usa o relógio e os timers do Node; nos testes, um relógio manual
// que só anda quando o teste manda (prazo, inatividade e virada de dia sem esperar de verdade).

export interface TimerHandle { cancel(): void }

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  setInterval(fn: () => void, ms: number): TimerHandle;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  },
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    t.unref?.();
    return { cancel: () => clearInterval(t) };
  },
};

interface Pending { at: number; fn: () => void; every: number | null; cancelled: boolean }

export class ManualClock implements Clock {
  private t: number;
  private timers: Pending[] = [];
  constructor(start = Date.UTC(2026, 10, 15, 12, 0, 0)) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const p: Pending = { at: this.t + Math.max(0, ms), fn, every: null, cancelled: false };
    this.timers.push(p);
    return { cancel: () => (p.cancelled = true) };
  }
  setInterval(fn: () => void, ms: number): TimerHandle {
    const p: Pending = { at: this.t + ms, fn, every: ms, cancelled: false };
    this.timers.push(p);
    return { cancel: () => (p.cancelled = true) };
  }
  // Avança o relógio disparando, em ordem, os timers vencidos.
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((p) => !p.cancelled && p.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every) due.at += due.every;
      else due.cancelled = true;
      due.fn();
    }
    this.t = end;
    this.timers = this.timers.filter((p) => !p.cancelled);
  }
}
