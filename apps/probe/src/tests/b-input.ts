// F2b — teclado (A-KEY), controle (A-PAD) e toque (A-TOUCH). Só lógica: a interface (botões,
// eventos) fica em ui-interactive.ts, e estas classes recebem os dados já extraídos dos eventos,
// para poderem ser testadas sem navegador.
// Privacidade: guardamos só o "code" físico das teclas esperadas (nunca texto digitado), contagens
// e o tipo genérico do controle (nunca o nome nem os códigos de fabricante/produto).
import type { KeyResult, PadResult, PadType, TouchResult } from '../report/types';

const SKIPPED = 'Pulado pelo usuário.';
const NOT_DONE = 'Ainda não feito.';

// ---------- A-KEY ----------
export const KEYS_SINGLE = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter'];
export const KEY_COMBOS: string[][] = [
  ['KeyW', 'KeyD', 'Space'],
  ['KeyW', 'Shift', 'Space'],
];
const norm = (code: string) => (code === 'ShiftLeft' || code === 'ShiftRight' ? 'Shift' : code);

export class KeyTest {
  private received = new Set<string>();
  private held = new Set<string>();
  private combosOk = KEY_COMBOS.map(() => false);
  private maxHeld = 0;
  private escape: boolean | null = null;
  private focusLost = 0;
  private started = false;
  private skipped = false;
  private finished = false;

  start(): void {
    this.started = true;
  }
  skip(): void {
    this.skipped = true;
  }
  // Interessa só às teclas do teste: outras são ignoradas e não são guardadas.
  down(code: string): void {
    if (!this.started) return;
    const c = norm(code);
    if (c === 'Escape') {
      this.escape = true;
      return;
    }
    if (!KEYS_SINGLE.includes(c) && c !== 'Shift') return;
    this.received.add(c);
    this.held.add(c);
    this.maxHeld = Math.max(this.maxHeld, this.held.size);
    KEY_COMBOS.forEach((combo, i) => {
      if (combo.every((k) => this.held.has(k))) this.combosOk[i] = true;
    });
  }
  up(code: string): void {
    this.held.delete(norm(code));
  }
  blur(): void {
    if (this.started) this.focusLost++;
    this.held.clear();
  }
  // A Esc é testada por último: o Discord pode usá-la para sair da Activity.
  escapeTimedOut(): void {
    if (this.escape === null) this.escape = false;
  }
  finish(): void {
    this.finished = true;
  }

  result(): KeyResult {
    const missing = KEYS_SINGLE.filter((k) => !this.received.has(k));
    const base = {
      keys_expected: [...KEYS_SINGLE, 'Shift', 'Escape'],
      keys_received: [...this.received, ...(this.escape ? ['Escape'] : [])],
      keys_missing: [...missing, ...(this.escape === false ? ['Escape'] : [])],
      combos: KEY_COMBOS.map((keys, i) => ({ keys, ok: this.combosOk[i]! })),
      max_held: this.maxHeld,
      escape_received: this.escape,
      focus_lost: this.focusLost,
    };
    if (this.skipped) return { status: 'SKIP', detail: SKIPPED, ...base };
    if (!this.started || !this.finished) return { status: 'SKIP', detail: NOT_DONE, ...base };
    if (this.received.size === 0 && !this.escape) return { status: 'RP', detail: 'Nenhuma tecla chegou à Activity.', ...base };
    const allCombos = this.combosOk.every(Boolean);
    if (missing.length === 0 && allCombos && this.escape === true) {
      return { status: 'AP', detail: `Todas as teclas chegaram, inclusive Esc; as 2 combinações funcionaram (até ${this.maxHeld} teclas juntas).`, ...base };
    }
    const faltas = [
      ...(missing.length ? [`teclas que não chegaram: ${missing.join(', ')}`] : []),
      ...KEY_COMBOS.filter((_, i) => !this.combosOk[i]).map((c) => `combinação ${c.map((k) => k.replace(/^Key/, '')).join('+')} não registrada`),
      ...(this.escape !== true ? ['Esc não chegou (o Discord pode usá-la)'] : []),
    ];
    return {
      status: 'INV',
      detail: `${faltas.join('; ')}. Compare com o navegador fora do Discord: alguns teclados não registram certas combinações.`,
      ...base,
    };
  }
}

// ---------- A-PAD ----------
export interface PadSnapshot {
  id: string;
  mapping: string;
  buttons: { pressed: boolean; value: number }[];
  axes: number[];
}

export function padType(id: string): PadType {
  if (/xbox|xinput|045e/i.test(id)) return 'xbox';
  if (/playstation|dualsense|dualshock|054c|sony/i.test(id)) return 'playstation';
  return 'outro';
}

const TRIGGERS = [6, 7]; // gatilhos no mapeamento "standard"
const AXIS_ON = 0.5;

export class PadTest {
  private apiPresent: boolean;
  private blocked = false;
  private error: string | null = null;
  private detected = false;
  private type: PadType | null = null;
  private mapping: string | null = null;
  private buttonsCount: number | null = null;
  private axesCount: number | null = null;
  private buttons = new Set<number>();
  private triggers = new Set<number>();
  private left = false;
  private right = false;
  private focusLostOnce = false;
  private focusRegained = false;
  private inputAfterRefocus: boolean | null = null;
  private skipped = false;
  private finished = false;

  constructor(apiPresent: boolean) {
    this.apiPresent = apiPresent;
  }
  // navigator.getGamepads() lançou erro: SecurityError = bloqueado pela política do iframe.
  apiError(e: unknown): void {
    const name = e instanceof Error ? e.name : '';
    this.blocked = name === 'SecurityError' || name === 'NotAllowedError';
    this.error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
  }
  skip(): void {
    this.skipped = true;
  }
  blur(): void {
    this.focusLostOnce = true;
  }
  focus(): void {
    if (this.focusLostOnce) {
      this.focusRegained = true;
      if (this.inputAfterRefocus === null) this.inputAfterRefocus = false;
    }
  }
  observe(pads: (PadSnapshot | null)[]): void {
    for (const p of pads) {
      if (!p) continue;
      this.detected = true;
      this.type = padType(p.id);
      this.mapping = p.mapping.slice(0, 20) || null;
      this.buttonsCount = p.buttons.length;
      this.axesCount = p.axes.length;
      let any = false;
      p.buttons.forEach((b, i) => {
        if (b.pressed || b.value > 0.5) {
          any = true;
          if (p.mapping === 'standard' && TRIGGERS.includes(i)) this.triggers.add(i);
          else this.buttons.add(i);
        }
      });
      const ax = (i: number) => Math.abs(p.axes[i] ?? 0) > AXIS_ON;
      if (ax(0) || ax(1)) {
        this.left = true;
        any = true;
      }
      if (ax(2) || ax(3)) {
        this.right = true;
        any = true;
      }
      if (any && this.focusRegained) this.inputAfterRefocus = true;
    }
  }
  finish(): void {
    this.finished = true;
  }

  result(): PadResult {
    const base = {
      api_present: this.apiPresent, blocked: this.blocked, error: this.error, pad_detected: this.detected,
      pad_type: this.type, mapping: this.mapping, buttons_count: this.buttonsCount, axes_count: this.axesCount,
      buttons_tested: [...this.buttons].sort((a, b) => a - b), left_stick: this.left, right_stick: this.right,
      triggers_tested: [...this.triggers].sort((a, b) => a - b), focus_regained: this.focusRegained,
      input_after_refocus: this.inputAfterRefocus,
      triggers_verifiable: this.detected ? this.mapping === 'standard' : null,
    };
    if (!this.apiPresent) return { status: 'RP', detail: 'A API de controle (Gamepad) não existe neste ambiente.', ...base };
    if (this.blocked) return { status: 'RP', detail: 'A API de controle está bloqueada pela política do iframe (SecurityError).', ...base };
    if (this.skipped) return { status: 'SKIP', detail: SKIPPED, ...base };
    if (!this.finished) return { status: 'SKIP', detail: NOT_DONE, ...base };
    if (!this.detected) {
      return { status: 'INV', detail: 'A API existe, mas nenhum controle apareceu (ele só aparece depois de apertar um botão com a Activity em foco).', ...base };
    }
    // AP só com a validação completa do plano (revisão do PR #4): botão, os dois analógicos, os dois
    // gatilhos (só verificáveis no mapeamento "standard") e comando depois de perder e recuperar o foco.
    const standard = this.mapping === 'standard';
    const checks: [string, boolean][] = [
      ['botão', this.buttons.size > 0],
      ['analógico esquerdo', this.left],
      ['analógico direito', this.right],
      ['os dois gatilhos', standard && TRIGGERS.every((i) => this.triggers.has(i))],
      ['comando depois de perder e recuperar o foco', this.focusRegained && this.inputAfterRefocus === true],
    ];
    const ok = checks.filter(([, v]) => v).map(([k]) => k);
    const missing = checks.filter(([, v]) => !v).map(([k]) => k);
    if (missing.length === 0) {
      return { status: 'AP', detail: `Validação completa: ${ok.join(', ')}. Só isso foi verificado.`, ...base };
    }
    const limit = standard
      ? ''
      : ' Mapeamento não padrão: a posição dos gatilhos não é conhecida, então eles não podem ser confirmados (limitação registrada).';
    const why = missing.map((m) => (m === 'comando depois de perder e recuperar o foco' && !this.focusRegained ? 'recuperação de foco (não testada)' : m));
    return {
      status: 'INV',
      detail: `Controle funciona em parte. Verificado: ${ok.join(', ') || 'nada'}. Não comprovado: ${why.join(', ')}.${limit}`,
      ...base,
    };
  }
}

// ---------- A-TOUCH ----------
export class TouchTest {
  private active = new Map<number, { x0: number; y0: number; moved: number }>();
  private maxSim = 0;
  private dragOk = false;
  private cancels = 0;
  private interacted = false;
  private skipped = false;
  private finished = false;

  constructor(private maxTouchPoints: number | null) {}

  get capable(): boolean {
    return (this.maxTouchPoints ?? 0) > 0;
  }
  skip(): void {
    this.skipped = true;
  }
  pointerDown(id: number, type: string, x: number, y: number): void {
    if (type !== 'touch') return;
    this.interacted = true;
    this.active.set(id, { x0: x, y0: y, moved: 0 });
    this.maxSim = Math.max(this.maxSim, this.active.size);
  }
  pointerMove(id: number, x: number, y: number): void {
    const p = this.active.get(id);
    if (p) p.moved = Math.max(p.moved, Math.hypot(x - p.x0, y - p.y0));
  }
  pointerUp(id: number): void {
    const p = this.active.get(id);
    if (p && p.moved >= 50) this.dragOk = true;
    this.active.delete(id);
  }
  // Pode ser o navegador assumindo rolagem/zoom ou o app por fora: não afirmamos a causa.
  pointerCancel(id: number): void {
    this.cancels++;
    this.active.delete(id);
  }
  finish(): void {
    this.finished = true;
  }

  result(): TouchResult {
    const base = { touch_capable: this.capable, max_touch_points: this.maxTouchPoints, max_simultaneous: this.maxSim, drag_ok: this.dragOk, cancels: this.cancels };
    if (!this.capable) return { status: 'SKIP', detail: 'Este aparelho não informa tela de toque.', ...base };
    if (this.skipped) return { status: 'SKIP', detail: SKIPPED, ...base };
    if (!this.finished || !this.interacted) return { status: 'SKIP', detail: NOT_DONE, ...base };
    if (this.maxSim >= 2 && this.dragOk && this.cancels === 0) {
      return { status: 'AP', detail: `Até ${this.maxSim} toques ao mesmo tempo e arrasto completo, sem cancelamentos.`, ...base };
    }
    const why = [
      this.maxSim < 2 ? `só ${this.maxSim} toque(s) simultâneo(s)` : null,
      !this.dragOk ? 'arrasto não completou' : null,
      this.cancels ? `${this.cancels} cancelamento(s) de toque (causa não identificada: navegador ou app)` : null,
    ].filter(Boolean).join('; ');
    return { status: 'INV', detail: `${why}. Compare com o navegador fora do Discord.`, ...base };
  }
}
