// Cartões dos testes interativos da F2b. Cada cartão tem instruções, botões, um resumo ao vivo e
// "Pular" (vira SKIP). A lógica e os critérios ficam em tests/b-input.ts e tests/b-media.ts.
import type { Tests } from './report/types';
import { KEYS_SINGLE, KeyTest, PadTest, TouchTest, type PadSnapshot } from './tests/b-input';
import { AudioTest, FileBasicTest, FileLargeTest, FsTest } from './tests/b-media';

type InteractiveKeys = 'A-KEY' | 'A-PAD' | 'A-TOUCH' | 'A-FS' | 'A-AUDIO' | 'A-FILE-BASIC' | 'A-FILE-LARGE';
export type InteractiveResults = Pick<Tests, InteractiveKeys>;

const SCRIPT_URL = 'https://github.com/Enzo-rbt0/bt3-activity-probe/blob/main/scripts/criar-arquivo-teste.ps1';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function card(root: HTMLElement, id: string, title: string, steps: string[]) {
  const c = el('div', { class: 'icard', id: `card-${id}` });
  const head = el('div', { class: 'icard-head' });
  head.append(el('h3', {}, title), el('span', { class: 'chip', id: `chip-${id}` }, '—'));
  const ol = el('ol', { class: 'steps' });
  for (const s of steps) ol.append(el('li', {}, s));
  const live = el('p', { class: 'live', id: `live-${id}` });
  const buttons = el('div', { class: 'buttons' });
  c.append(head, ol, live, buttons);
  root.append(c);
  const btn = (label: string, cls = '', bid = '') => {
    const b = el('button', { type: 'button', class: cls, ...(bid ? { id: bid } : {}) }, label);
    buttons.append(b);
    return b;
  };
  return { c, live, btn, buttons };
}

export function mountInteractive(root: HTMLElement, onChange: () => void): () => InteractiveResults {
  // ---------- Teclado ----------
  const key = new KeyTest();
  {
    const k = card(root, 'A-KEY', 'Teclado (A-KEY)', [
      'Toque em "Começar" e aperte, uma de cada vez: W, A, S, D, as 4 setas, Espaço e Enter.',
      'Segure W + D + Espaço juntas. Depois segure W + Shift + Espaço juntas.',
      'Toque em "Concluir teclas". A Esc é a última: ela pode fechar a Activity, então baixe ou copie o JSON antes.',
    ]);
    let active = false;
    const show = () => {
      const r = key.result();
      k.live.textContent = active || r.keys_received.length
        ? `Recebidas: ${r.keys_received.join(' ') || 'nenhuma'} · combinações: ${r.combos.map((c) => (c.ok ? '✓' : '✗')).join(' ')} · máx. juntas: ${r.max_held}`
        : '';
      onChange();
    };
    const relevant = new Set([...KEYS_SINGLE, 'ShiftLeft', 'ShiftRight', 'Escape']);
    window.addEventListener('keydown', (e) => {
      if (!active || !relevant.has(e.code)) return;
      if (e.code !== 'Escape') e.preventDefault(); // evita rolar a página com Espaço/setas
      key.down(e.code);
      show();
    }, true);
    window.addEventListener('keyup', (e) => {
      if (active) key.up(e.code);
    }, true);
    window.addEventListener('blur', () => {
      if (active) {
        key.blur();
        show();
      }
    });
    const start = k.btn('Começar');
    const done = k.btn('Concluir teclas', 'secondary');
    const esc = k.btn('Testar Esc (5 s)', 'secondary');
    const skip = k.btn('Pular', 'secondary');
    done.disabled = esc.disabled = true;
    start.addEventListener('click', () => {
      active = true;
      key.start();
      k.c.tabIndex = 0;
      k.c.focus();
      start.disabled = true;
      done.disabled = false;
      show();
    });
    done.addEventListener('click', () => {
      done.disabled = true;
      esc.disabled = false;
      k.live.textContent += ' · Agora o teste da Esc (opcional, por último).';
      key.finish();
      show();
    });
    esc.addEventListener('click', () => {
      esc.disabled = true;
      k.c.focus();
      k.live.textContent = 'Aperte Esc agora (5 s)…';
      setTimeout(() => {
        key.escapeTimedOut();
        show();
      }, 5000);
    });
    skip.addEventListener('click', () => {
      active = false;
      key.skip();
      show();
    });
  }

  // ---------- Controle ----------
  const apiPresent = typeof navigator.getGamepads === 'function';
  const pad = new PadTest(apiPresent);
  {
    const p = card(root, 'A-PAD', 'Controle (A-PAD)', [
      'Ligue o controle antes (cabo ou Bluetooth). Toque em "Começar" e aperte um botão para ele aparecer.',
      'Aperte alguns botões, os dois gatilhos e mexa os DOIS analógicos.',
      'Troque de janela ou de app, volte e aperte um botão de novo. Depois, "Concluir".',
    ]);
    let running = false;
    const snap = (g: Gamepad): PadSnapshot => ({
      id: g.id, mapping: g.mapping,
      buttons: Array.from(g.buttons, (b) => ({ pressed: b.pressed, value: b.value })), axes: Array.from(g.axes),
    });
    let last = '';
    const loop = () => {
      if (!running) return;
      try {
        pad.observe(Array.from(navigator.getGamepads(), (g) => (g ? snap(g) : null)));
      } catch (e) {
        pad.apiError(e);
        running = false;
      }
      const r = pad.result();
      const txt = r.pad_detected
        ? `Controle: ${r.pad_type} · botões: ${r.buttons_tested.join(',') || '—'} · gatilhos: ${r.triggers_tested.join(',') || '—'} · analógicos: ${r.left_stick ? 'E✓' : 'E✗'} ${r.right_stick ? 'D✓' : 'D✗'}${r.focus_regained ? ` · depois de voltar: ${r.input_after_refocus ? '✓' : 'aperte um botão'}` : ''}`
        : r.blocked ? 'API bloqueada.' : 'Nenhum controle ainda: aperte um botão.';
      if (txt !== last) {
        last = txt;
        p.live.textContent = txt;
        onChange();
      }
      requestAnimationFrame(loop);
    };
    window.addEventListener('blur', () => running && pad.blur());
    window.addEventListener('focus', () => running && pad.focus());
    document.addEventListener('visibilitychange', () => {
      if (!running) return;
      if (document.visibilityState === 'hidden') pad.blur();
      else pad.focus();
    });
    const start = p.btn('Começar');
    const done = p.btn('Concluir', 'secondary');
    const skip = p.btn('Pular', 'secondary');
    done.disabled = true;
    if (!apiPresent) {
      start.disabled = true;
      p.live.textContent = 'A API de controle não existe neste ambiente.';
    }
    start.addEventListener('click', () => {
      start.disabled = true;
      done.disabled = false;
      running = true;
      try {
        navigator.getGamepads();
      } catch (e) {
        pad.apiError(e);
      }
      requestAnimationFrame(loop);
      onChange();
    });
    done.addEventListener('click', () => {
      running = false;
      done.disabled = true;
      pad.finish();
      onChange();
    });
    skip.addEventListener('click', () => {
      running = false;
      pad.skip();
      onChange();
    });
  }

  // ---------- Toque ----------
  const touch = new TouchTest(typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : null);
  {
    const t = card(root, 'A-TOUCH', 'Toque (A-TOUCH)', [
      'Toque na área cinza com 1, depois 2, depois 3 dedos ao mesmo tempo.',
      'Arraste um dedo de um lado ao outro da área. Depois, "Concluir".',
    ]);
    const area = el('div', { class: 'touch-area', id: 'touch-area' }, 'Área de toque');
    t.c.insertBefore(area, t.live);
    const show = () => {
      const r = touch.result();
      t.live.textContent = `Máx. toques juntos: ${r.max_simultaneous} · arrasto: ${r.drag_ok ? '✓' : '—'} · cancelamentos: ${r.cancels}`;
      onChange();
    };
    area.addEventListener('pointerdown', (e) => {
      touch.pointerDown(e.pointerId, e.pointerType, e.clientX, e.clientY);
      show();
    });
    area.addEventListener('pointermove', (e) => touch.pointerMove(e.pointerId, e.clientX, e.clientY));
    area.addEventListener('pointerup', (e) => {
      touch.pointerUp(e.pointerId);
      show();
    });
    area.addEventListener('pointercancel', (e) => {
      touch.pointerCancel(e.pointerId);
      show();
    });
    const done = t.btn('Concluir', 'secondary');
    const skip = t.btn('Pular', 'secondary');
    if (!touch.capable) {
      done.disabled = true;
      t.live.textContent = 'Este aparelho não informa tela de toque (SKIP automático).';
    }
    done.addEventListener('click', () => {
      touch.finish();
      show();
    });
    skip.addEventListener('click', () => {
      touch.skip();
      show();
    });
  }

  // ---------- Tela cheia ----------
  const fs = new FsTest(typeof document.fullscreenEnabled === 'boolean' ? document.fullscreenEnabled : null);
  {
    const f = card(root, 'A-FS', 'Tela cheia (A-FS)', ['Toque em "Tela cheia". Se abrir, ela sai sozinha depois de 2 segundos.']);
    const go = f.btn('Tela cheia');
    const skip = f.btn('Pular', 'secondary');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await document.documentElement.requestFullscreen();
        await new Promise((r) => setTimeout(r, 300));
        fs.enteredOk({ width: window.innerWidth, height: window.innerHeight });
        f.live.textContent = `Em tela cheia: ${window.innerWidth}×${window.innerHeight}. Saindo…`;
        onChange();
        setTimeout(async () => {
          try {
            if (document.fullscreenElement) await document.exitFullscreen();
            fs.exitedOk();
          } catch {
            // Sair falhou: o usuário sai pelo próprio app.
          }
          f.live.textContent = fs.result().detail;
          onChange();
        }, 2000);
      } catch (e) {
        fs.failed(e);
        f.live.textContent = fs.result().detail;
        onChange();
      }
    });
    skip.addEventListener('click', () => {
      fs.skip();
      onChange();
    });
  }

  // ---------- Áudio ----------
  const audio = new AudioTest();
  {
    const a = card(root, 'A-AUDIO', 'Áudio (A-AUDIO)', [
      'Toque em "Tocar som": um bipe curto, em volume baixo.',
      'Responda se ouviu.',
      'Opcional (Android): numa chamada de voz, toque em "Tocar durante a chamada" e responda as duas perguntas.',
    ]);
    type AC = typeof AudioContext;
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext) as AC | undefined;
    let ctx: AudioContext | null = null;
    try {
      if (Ctor) {
        ctx = new Ctor();
        audio.setBefore(ctx.state, ctx.sampleRate);
      } else {
        audio.failed(new Error('Web Audio não existe neste ambiente'));
      }
    } catch (e) {
      audio.failed(e);
    }
    const beep = async () => {
      if (!ctx) return;
      try {
        await ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
        const ol = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
        audio.setAfter(ctx.state, typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null, typeof ol === 'number' ? ol : null);
      } catch (e) {
        audio.failed(e);
      }
      onChange();
    };
    const play = a.btn('Tocar som');
    const yes = a.btn('Ouvi', 'secondary', 'audio-yes');
    const no = a.btn('Não ouvi', 'secondary', 'audio-no');
    const skip = a.btn('Pular', 'secondary');
    yes.disabled = no.disabled = true;
    play.addEventListener('click', async () => {
      await beep();
      yes.disabled = no.disabled = false;
      a.live.textContent = `Estado do áudio: ${audio.result().state_after_gesture ?? '?'}. Ouviu o bipe?`;
    });
    yes.addEventListener('click', () => {
      audio.answer(true);
      a.live.textContent = audio.result().detail;
      onChange();
    });
    no.addEventListener('click', () => {
      audio.answer(false);
      a.live.textContent = audio.result().detail;
      onChange();
    });
    skip.addEventListener('click', () => {
      audio.skip();
      onChange();
    });
    const call = el('div', { class: 'buttons call' });
    const callPlay = el('button', { type: 'button', class: 'secondary' }, 'Tocar durante a chamada');
    const q = (label: string, f: (v: boolean) => void) => {
      const wrap = el('span', { class: 'q' }, label);
      const s = el('button', { type: 'button', class: 'secondary small' }, 'Sim');
      const n = el('button', { type: 'button', class: 'secondary small' }, 'Não');
      s.addEventListener('click', () => f(true));
      n.addEventListener('click', () => f(false));
      wrap.append(s, n);
      return wrap;
    };
    callPlay.addEventListener('click', () => beep());
    call.append(
      callPlay,
      q('Ouviu o bipe do jogo?', (v) => {
        audio.answerCall(v, null);
        onChange();
      }),
      q('A voz da chamada continuou boa?', (v) => {
        audio.answerCall(null, v);
        onChange();
      }),
    );
    a.c.append(call);
  }

  // ---------- Arquivos ----------
  const fileBasic = new FileBasicTest();
  const fileLarge = new FileLargeTest();
  const filePicker = (parent: ReturnType<typeof card>, id: string, onFile: (f: File) => Promise<unknown>, onCancel: () => void) => {
    const input = el('input', { type: 'file', id });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return onCancel();
      parent.live.textContent = 'Lendo 3 pedaços de 2 KiB…';
      await onFile(f);
      input.value = '';
    });
    input.addEventListener('cancel', () => {
      onCancel();
      onChange();
    });
    parent.c.insertBefore(input, parent.live);
  };
  {
    const b = card(root, 'A-FILE-BASIC', 'Arquivo comum (A-FILE-BASIC)', [
      'Escolha qualquer foto ou vídeo do aparelho. Nunca um arquivo do BT3.',
      'A sonda lê só 3 pedaços de 2 KiB e não guarda nome nem conteúdo.',
    ]);
    filePicker(b, 'file-basic', async (f) => {
      const r = await fileBasic.run(f);
      b.live.textContent = r.detail;
      onChange();
    }, () => {
      fileBasic.cancelled();
      b.live.textContent = fileBasic.result().detail;
    });
    b.btn('Pular', 'secondary').addEventListener('click', () => {
      fileBasic.skip();
      onChange();
    });
  }
  {
    const l = card(root, 'A-FILE-LARGE', 'Arquivo maior que 2 GiB (A-FILE-LARGE)', [
      'No PC: crie o arquivo de teste com o script criar-arquivo-teste.ps1 (não precisa de administrador).',
      'Escolha o arquivo "teste.bt3probe-large.bin". No Android é opcional: pode pular (fica pendente).',
    ]);
    const link = el('a', { href: SCRIPT_URL, target: '_blank', rel: 'noopener' }, 'Ver o script no GitHub');
    l.c.insertBefore(link, l.live);
    filePicker(l, 'file-large', async (f) => {
      const r = await fileLarge.run(f);
      l.live.textContent = r.detail;
      onChange();
    }, () => {
      fileLarge.cancelled();
      l.live.textContent = fileLarge.result().detail;
    });
    l.btn('Pular', 'secondary').addEventListener('click', () => {
      fileLarge.skip();
      onChange();
    });
  }

  const results = (): InteractiveResults => {
    const r: InteractiveResults = {
      'A-KEY': key.result(), 'A-PAD': pad.result(), 'A-TOUCH': touch.result(), 'A-FS': fs.result(),
      'A-AUDIO': audio.result(), 'A-FILE-BASIC': fileBasic.result(), 'A-FILE-LARGE': fileLarge.result(),
    };
    for (const [k, v] of Object.entries(r)) {
      const chip = document.getElementById(`chip-${k}`);
      if (chip) {
        chip.textContent = v.status;
        chip.className = `chip st-${v.status}`;
      }
    }
    return r;
  };
  return results;
}
