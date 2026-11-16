// Janela de rede (interruptor). Só o servidor lê; nenhum botão, painel ou parâmetro de URL abre.
// Arquivo JSON gravado pelo script ops/bt3probe-janela (via SSH, por quem opera a VM):
//   {"opened_at":"2026-11-20T21:00:00Z","open_until":"2026-11-20T23:00:00Z"}
// Fechado (fail-closed) se: arquivo ausente/ilegível/inválido; open_until anterior ou igual a opened_at;
// open_until no passado; janela (open_until − opened_at) maior que 12 h; opened_at mais de 60 s no futuro;
// ou **opened_at anterior ao início deste processo**.
// Esta última regra é a do reinício: um processo novo nunca reaproveita uma janela aberta antes dele,
// mesmo que ainda tenha tempo restante. É preciso rodar "abrir" de novo (nova autorização).
// Não há regra separada para o tempo restante: com opened_at ≤ agora + 60 s e janela ≤ 12 h, o tempo
// restante já fica limitado a 12 h + 60 s. A regra antiga ("restante ≤ 12 h") recusava janelas de 12 h
// exatas quando a leitura do relógio do servidor ficava atrás de opened_at (dentro da tolerância de 60 s).
import { readFileSync } from 'node:fs';
import type { Clock, TimerHandle } from './clock.js';

export const MAX_WINDOW_MS = 12 * 60 * 60 * 1000;
export const FUTURE_SKEW_MS = 60 * 1000;
export const RELOAD_MS = 5000;

export interface WindowState {
  open: boolean;
  until: number | null;
  reason: string;
}

const CLOSED = (reason: string): WindowState => ({ open: false, until: null, reason });

export function parseWindow(text: string | null, processStartedAt: number, now: number): WindowState {
  if (text === null) return CLOSED('arquivo da janela ausente ou ilegível');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return CLOSED('arquivo da janela inválido');
  }
  if (!raw || typeof raw !== 'object') return CLOSED('janela vazia');
  const { opened_at, open_until } = raw as Record<string, unknown>;
  if (typeof opened_at !== 'string' || typeof open_until !== 'string') return CLOSED('janela vazia');
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  if (!iso.test(opened_at) || !iso.test(open_until)) return CLOSED('datas fora do formato UTC');
  const opened = Date.parse(opened_at);
  const until = Date.parse(open_until);
  if (!Number.isFinite(opened) || !Number.isFinite(until)) return CLOSED('datas inválidas');
  if (until <= opened) return CLOSED('vencimento anterior ou igual à abertura');
  if (opened < processStartedAt) return CLOSED('janela aberta antes do último reinício: abrir de novo');
  if (opened > now + FUTURE_SKEW_MS) return CLOSED('abertura no futuro');
  if (until <= now) return CLOSED('janela vencida');
  if (until - opened > MAX_WINDOW_MS) return CLOSED('janela maior que 12 h');
  return { open: true, until, reason: 'aberta' };
}

export class WindowWatcher {
  private state: WindowState = CLOSED('ainda não lida');
  private timer: TimerHandle | null = null;
  constructor(
    private path: string,
    private clock: Clock,
    private processStartedAt: number,
    private read: (p: string) => string | null = (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  ) {}

  start(): void {
    this.reload();
    this.timer = this.clock.setInterval(() => this.reload(), RELOAD_MS);
  }
  stop(): void {
    this.timer?.cancel();
  }
  reload(): void {
    try {
      this.state = parseWindow(this.read(this.path), this.processStartedAt, this.clock.now());
    } catch {
      this.state = CLOSED('erro ao ler a janela');
    }
  }
  // O prazo é conferido também contra o relógio atual, para não depender do intervalo de releitura.
  current(): WindowState {
    const s = this.state;
    if (s.open && s.until !== null && this.clock.now() >= s.until) return CLOSED('janela vencida');
    return s;
  }
}
