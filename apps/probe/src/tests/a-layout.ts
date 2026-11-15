// A-LAYOUT (orientação, área visível, áreas seguras e mudanças ao girar) e A-VIS (quantas vezes a
// Activity foi escondida, minimizada ou perdeu o foco). Só registram; não aprovam nem reprovam.
// O impacto de esconder/minimizar no jogo fica para a F3.
import type { LayoutChange, LayoutResult, VisResult } from '../report/types';

const px = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export class LayoutWatcher {
  private changes: LayoutChange[] = [];
  private t0 = performance.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private probe: HTMLElement;
  constructor(private win: Window, private onChange: () => void) {
    // Elemento invisível que recebe as áreas seguras via CSS env().
    this.probe = win.document.createElement('div');
    this.probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    win.document.body.appendChild(this.probe);
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.record(), 150);
    };
    win.addEventListener('resize', schedule);
    win.addEventListener('orientationchange', schedule);
    win.screen.orientation?.addEventListener?.('change', schedule);
  }

  private orientation(): string | null {
    return this.win.screen.orientation?.type ?? null;
  }

  private record(): void {
    if (this.changes.length >= 30) return;
    this.changes.push({
      t_ms: Math.round(performance.now() - this.t0),
      width: this.win.innerWidth,
      height: this.win.innerHeight,
      orientation_type: this.orientation(),
    });
    this.onChange();
  }

  result(): LayoutResult {
    const vv = this.win.visualViewport;
    const cs = this.win.getComputedStyle(this.probe);
    const o = this.orientation();
    return {
      status: 'AP',
      detail: `${o ?? 'orientação desconhecida'}, ${this.win.innerWidth}×${this.win.innerHeight}; ${this.changes.length} mudança(s) de tamanho registradas.`,
      orientation_type: o,
      orientation_angle: this.win.screen.orientation?.angle ?? null,
      visual_viewport: vv ? { width: Math.round(vv.width), height: Math.round(vv.height), scale: vv.scale } : null,
      safe_area: { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) },
      changes: [...this.changes],
    };
  }
}

export class VisWatcher {
  private c = { hidden: 0, visible: 0, pagehide: 0, blur: 0, focus: 0 };
  constructor(win: Window, onChange: () => void) {
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'hidden') this.c.hidden++;
      else this.c.visible++;
      onChange();
    });
    win.addEventListener('pagehide', () => {
      this.c.pagehide++;
      onChange();
    });
    win.addEventListener('blur', () => {
      this.c.blur++;
      onChange();
    });
    win.addEventListener('focus', () => {
      this.c.focus++;
      onChange();
    });
  }
  result(): VisResult {
    const { hidden, visible, pagehide, blur, focus } = this.c;
    return {
      status: 'AP',
      detail: `Informativo: escondida ${hidden}×, voltou ${visible}×, perdeu o foco ${blur}×.`,
      hidden, visible, pagehide, blur, focus,
    };
  }
}
