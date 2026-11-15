import { describe, expect, it } from 'vitest';
import { KEYS_SINGLE, KeyTest, PadTest, padType, TouchTest, type PadSnapshot } from './tests/b-input';
import {
  AFTER_2GIB, AudioTest, basicPlan, FileBasicTest, FileLargeTest, FsTest, GIB2, markerText, typeCategory, type BlobLike,
} from './tests/b-media';

describe('A-KEY', () => {
  const pressAll = (k: KeyTest) => {
    for (const c of KEYS_SINGLE) {
      k.down(c);
      k.up(c);
    }
    for (const combo of [['KeyW', 'KeyD', 'Space'], ['KeyW', 'ShiftLeft', 'Space']]) {
      combo.forEach((c) => k.down(c));
      combo.forEach((c) => k.up(c));
    }
  };
  it('antes de começar: SKIP "ainda não feito"; teclas antes do início são ignoradas', () => {
    const k = new KeyTest();
    k.down('KeyW');
    expect(k.result()).toMatchObject({ status: 'SKIP', keys_received: [] });
  });
  it('todas as teclas, as 2 combinações e Esc → AP', () => {
    const k = new KeyTest();
    k.start();
    pressAll(k);
    k.finish();
    k.down('Escape');
    const r = k.result();
    expect(r.status).toBe('AP');
    expect(r.combos.every((c) => c.ok)).toBe(true);
    expect(r.max_held).toBe(3);
    expect(r.escape_received).toBe(true);
  });
  it('Esc não chegou → INV citando a Esc (não RP)', () => {
    const k = new KeyTest();
    k.start();
    pressAll(k);
    k.finish();
    k.escapeTimedOut();
    const r = k.result();
    expect(r.status).toBe('INV');
    expect(r.keys_missing).toEqual(['Escape']);
    expect(r.detail).toContain('Esc');
  });
  it('combinação não registrada → INV e sugere comparar fora do Discord', () => {
    const k = new KeyTest();
    k.start();
    for (const c of KEYS_SINGLE) {
      k.down(c);
      k.up(c);
    }
    k.finish();
    k.down('Escape');
    const r = k.result();
    expect(r.status).toBe('INV');
    expect(r.detail).toContain('W+D+Space');
    expect(r.detail).toContain('fora do Discord');
  });
  it('perder o foco solta as teclas: combinação "atravessando" o blur não conta', () => {
    const k = new KeyTest();
    k.start();
    k.down('KeyW');
    k.down('KeyD');
    k.blur();
    k.down('Space');
    expect(k.result().combos[0]!.ok).toBe(false);
    expect(k.result().focus_lost).toBe(1);
  });
  it('nenhuma tecla → RP; pular → SKIP', () => {
    const k = new KeyTest();
    k.start();
    k.finish();
    expect(k.result().status).toBe('RP');
    const s = new KeyTest();
    s.skip();
    expect(s.result()).toMatchObject({ status: 'SKIP', detail: 'Pulado pelo usuário.' });
  });
  it('privacidade: teclas fora do teste não são guardadas', () => {
    const k = new KeyTest();
    k.start();
    k.down('KeyQ');
    k.down('Digit1');
    expect(k.result().keys_received).toEqual([]);
  });
});

const pad = (over: Partial<PadSnapshot> = {}): PadSnapshot => ({
  id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  mapping: 'standard',
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  axes: [0, 0, 0, 0],
  ...over,
});
const press = (i: number, p = pad()) => ({ ...p, buttons: p.buttons.map((b, j) => (j === i ? { pressed: true, value: 1 } : b)) });

describe('A-PAD', () => {
  it('API ausente → RP; SecurityError (política do iframe) → RP bloqueado', () => {
    expect(new PadTest(false).result()).toMatchObject({ status: 'RP', api_present: false });
    const t = new PadTest(true);
    const e = new Error('bloqueado');
    e.name = 'SecurityError';
    t.apiError(e);
    expect(t.result()).toMatchObject({ status: 'RP', blocked: true });
  });
  it('API existe, controle não apareceu → INV (não RP)', () => {
    const t = new PadTest(true);
    t.finish();
    expect(t.result()).toMatchObject({ status: 'INV', pad_detected: false, blocked: false });
  });
  const full = (t: PadTest, p = pad()) => {
    t.observe([press(0, p)]);
    t.observe([press(6, p)]);
    t.observe([press(7, p)]);
    t.observe([{ ...p, axes: [0.9, 0, 0, 0] }]);
    t.observe([{ ...p, axes: [0, 0, 0, -0.8] }]);
  };
  it('validação completa (botão, 2 analógicos, 2 gatilhos, foco recuperado) → AP', () => {
    const t = new PadTest(true);
    full(t);
    t.blur();
    t.focus();
    t.observe([press(1)]);
    t.finish();
    const r = t.result();
    expect(r).toMatchObject({
      status: 'AP', pad_type: 'xbox', buttons_tested: [0, 1], triggers_tested: [6, 7], left_stick: true, right_stick: true,
      focus_regained: true, input_after_refocus: true, triggers_verifiable: true,
    });
    expect(r.detail).toContain('Só isso foi verificado');
  });
  it('botão + 2 analógicos, mas sem gatilhos nem teste de foco → INV (não AP)', () => {
    const t = new PadTest(true);
    t.observe([press(0)]);
    t.observe([pad({ axes: [0.9, 0, 0, 0] })]);
    t.observe([pad({ axes: [0, 0, 0, -0.8] })]);
    t.finish();
    const r = t.result();
    expect(r.status).toBe('INV');
    expect(r.detail).toContain('os dois gatilhos');
    expect(r.detail).toContain('recuperação de foco (não testada)');
  });
  it('perdeu o foco e nenhum comando chegou depois → INV, nunca AP', () => {
    const t = new PadTest(true);
    full(t);
    t.blur();
    t.focus();
    t.finish();
    expect(t.result()).toMatchObject({ status: 'INV', focus_regained: true, input_after_refocus: false });
  });
  it('só um gatilho → INV', () => {
    const t = new PadTest(true);
    t.observe([press(0)]);
    t.observe([press(6)]);
    t.observe([pad({ axes: [0.9, 0, 0, -0.9] })]);
    t.blur();
    t.focus();
    t.observe([press(1)]);
    t.finish();
    expect(t.result().status).toBe('INV');
  });
  it('mapeamento não padrão: gatilhos não verificáveis → INV com a limitação registrada', () => {
    const t = new PadTest(true);
    const ns = pad({ mapping: '' });
    full(t, ns);
    t.blur();
    t.focus();
    t.observe([press(1, ns)]);
    t.finish();
    const r = t.result();
    expect(r).toMatchObject({ status: 'INV', triggers_verifiable: false, mapping: null });
    expect(r.detail).toContain('Mapeamento não padrão');
  });
  it('depois de perder e recuperar o foco: registra se ainda chegou comando', () => {
    const t = new PadTest(true);
    t.observe([press(0)]);
    t.blur();
    t.focus();
    expect(t.result().input_after_refocus).toBe(false);
    t.observe([press(2)]);
    expect(t.result()).toMatchObject({ focus_regained: true, input_after_refocus: true });
  });
  it('tipo genérico do controle; o nome nunca vai para o relatório', () => {
    expect(padType('DualSense Wireless Controller (Vendor: 054c Product: 0ce6)')).toBe('playstation');
    expect(padType('8BitDo Pro 2')).toBe('outro');
    const t = new PadTest(true);
    t.observe([press(0)]);
    expect(JSON.stringify(t.result())).not.toMatch(/Wireless|045e|0b13/);
  });
});

describe('A-TOUCH', () => {
  it('sem tela de toque → SKIP automático', () => {
    expect(new TouchTest(0).result()).toMatchObject({ status: 'SKIP', touch_capable: false });
  });
  it('2 toques + arrasto sem cancelamento → AP; mouse é ignorado', () => {
    const t = new TouchTest(10);
    t.pointerDown(9, 'mouse', 0, 0);
    t.pointerDown(1, 'touch', 0, 0);
    t.pointerDown(2, 'touch', 50, 0);
    t.pointerUp(2);
    t.pointerMove(1, 120, 0);
    t.pointerUp(1);
    t.finish();
    expect(t.result()).toMatchObject({ status: 'AP', max_simultaneous: 2, drag_ok: true, cancels: 0 });
  });
  it('cancelamento → INV sem culpar o Discord', () => {
    const t = new TouchTest(10);
    t.pointerDown(1, 'touch', 0, 0);
    t.pointerDown(2, 'touch', 10, 0);
    t.pointerCancel(1);
    t.finish();
    const r = t.result();
    expect(r.status).toBe('INV');
    expect(r.detail).toContain('causa não identificada');
    expect(r.detail).not.toMatch(/Discord (roubou|cancelou)/);
  });
  it('mesmo com 2 toques e arrasto, um cancelamento impede o AP', () => {
    const t = new TouchTest(10);
    t.pointerDown(1, 'touch', 0, 0);
    t.pointerDown(2, 'touch', 10, 0);
    t.pointerMove(1, 200, 0);
    t.pointerUp(1);
    t.pointerCancel(2);
    t.finish();
    expect(t.result()).toMatchObject({ status: 'INV', drag_ok: true, cancels: 1, max_simultaneous: 2 });
  });
});

describe('A-FS', () => {
  it('entrou → AP; erro → RP como limitação documentada', () => {
    const a = new FsTest(true);
    a.enteredOk({ width: 1920, height: 1080 });
    a.exitedOk();
    expect(a.result()).toMatchObject({ status: 'AP', entered: true, exited: true });
    const b = new FsTest(false);
    const e = new Error('Permissions check failed');
    e.name = 'TypeError';
    b.failed(e);
    expect(b.result().status).toBe('RP');
    expect(b.result().detail).toContain('Limitação documentada');
  });
});

describe('A-AUDIO', () => {
  it('suspenso antes do clique é o esperado; tocou e ouviu → AP', () => {
    const a = new AudioTest();
    a.setBefore('suspended', 48000);
    a.setAfter('running', 0.01, 0.0425);
    a.answer(true);
    const r = a.result();
    expect(r).toMatchObject({ status: 'AP', state_before_gesture: 'suspended', base_latency_ms: 10, output_latency_ms: 42.5 });
    expect(r.detail).toContain('comportamento esperado');
  });
  it('não ouviu ou não iniciou → RP; erro ao criar → RP; sem resposta → SKIP', () => {
    const a = new AudioTest();
    a.setBefore('suspended', 48000);
    a.setAfter('running', null, null);
    a.answer(false);
    expect(a.result().status).toBe('RP');
    const b = new AudioTest();
    b.setAfter('suspended', null, null);
    b.answer(true);
    expect(b.result().status).toBe('RP');
    const c = new AudioTest();
    c.failed(new Error('sem Web Audio'));
    expect(c.result().status).toBe('RP');
    expect(new AudioTest().result().status).toBe('SKIP');
  });
  it('teste opcional durante chamada fica registrado', () => {
    const a = new AudioTest();
    a.setAfter('running', null, null);
    a.answer(true);
    a.answerCall(true, null);
    a.answerCall(null, false);
    expect(a.result().during_call).toEqual({ heard: true, call_voice_ok: false });
    expect(a.result().detail).toContain('voz prejudicada');
  });
});

describe('A-FILE-BASIC', () => {
  it('posições sem sobreposição, inclusive em arquivo pequeno', () => {
    expect(basicPlan(10_000).map((p) => [p.offset, p.len])).toEqual([[0, 2048], [3976, 2048], [7952, 2048]]);
    const small = basicPlan(7);
    expect(small.map((p) => p.len)).toEqual([2, 2, 2]);
    expect(small[0]!.offset + 2).toBeLessThanOrEqual(small[1]!.offset);
    expect(basicPlan(2)).toEqual([]);
  });
  it('arquivo comum → AP com 3 leituras; não guarda o nome', async () => {
    const f = new File([new Uint8Array(10_000)], 'ferias-na-praia.jpg', { type: 'image/jpeg' });
    const r = await new FileBasicTest().run(f);
    expect(r).toMatchObject({ status: 'AP', size: 10_000, type_category: 'imagem' });
    expect(r.reads.map((x) => x.where)).toEqual(['inicio', 'meio', 'fim']);
    expect(JSON.stringify(r)).not.toContain('ferias');
  });
  it('arquivo pequeno demais pede outro (SKIP), não reprova', async () => {
    expect((await new FileBasicTest().run(new File(['ab'], 'a.txt'))).status).toBe('SKIP');
  });
  it('cancelar o seletor → SKIP; leitura que falha → RP', async () => {
    const t = new FileBasicTest();
    t.cancelled();
    expect(t.result()).toMatchObject({ status: 'SKIP', cancelled: true });
    const broken: BlobLike = { size: 9000, type: 'video/mp4', slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) };
    expect((await new FileBasicTest().run(broken)).status).toBe('RP');
  });
  it('tipo genérico', () => {
    expect(typeCategory('video/mp4')).toBe('video');
    expect(typeCategory('audio/ogg')).toBe('audio');
    expect(typeCategory('')).toBe('outro');
  });
});

// Arquivo "virtual" de 3 GiB: só as posições pedidas existem, como no arquivo esparso real.
function fakeLarge(size: number, marks: Record<number, string>): BlobLike {
  return {
    size,
    type: '',
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => {
        const out = new Uint8Array(Math.max(0, Math.min(end, size) - start));
        const m = marks[start];
        if (m) out.set(new TextEncoder().encode(m).subarray(0, out.length));
        return out.buffer;
      },
    }),
  };
}
const SIZE3 = 3 * 2 ** 30;
const goodMarks = { 0: markerText(0), [AFTER_2GIB]: markerText(AFTER_2GIB), [SIZE3 - 4096]: markerText(SIZE3 - 4096) };

describe('A-FILE-LARGE', () => {
  it('estado inicial: SKIP dizendo que não aprova só porque o comum passou', () => {
    const r = new FileLargeTest().result();
    expect(r.status).toBe('SKIP');
    expect(r.detail).toContain('não aprova');
  });
  it('arquivo de teste com os 3 marcadores → AP (leitura depois de 2³¹)', async () => {
    expect(AFTER_2GIB).toBeGreaterThan(GIB2);
    const r = await new FileLargeTest().run(fakeLarge(SIZE3, goodMarks));
    expect(r).toMatchObject({ status: 'AP', over_2gib: true });
    expect(r.markers.map((m) => m.ok)).toEqual([true, true, true]);
  });
  it('marcador depois de 2 GiB errado → RP (a leitura em posição alta falhou)', async () => {
    const r = await new FileLargeTest().run(fakeLarge(SIZE3, { ...goodMarks, [AFTER_2GIB]: markerText(0) }));
    expect(r.status).toBe('RP');
    expect(r.detail).toContain('apos_2gib');
  });
  it('arquivo grande sem marcadores → INV; arquivo até 2 GiB → INV', async () => {
    expect((await new FileLargeTest().run(fakeLarge(SIZE3, {}))).status).toBe('INV');
    expect((await new FileLargeTest().run(fakeLarge(GIB2, goodMarks))).status).toBe('INV');
  });
  it('pular ou cancelar → SKIP (pendente)', () => {
    const t = new FileLargeTest();
    t.skip();
    expect(t.result().detail).toContain('pendente');
    const c = new FileLargeTest();
    c.cancelled();
    expect(c.result()).toMatchObject({ status: 'SKIP', cancelled: true });
  });
});
