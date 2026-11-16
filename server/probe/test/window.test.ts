// T2 e T9 (parte unitária): interruptor controlado pelo servidor, desligado por padrão, e regra do reinício.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { MAX_WINDOW_MS, parseWindow, WindowWatcher } from '../src/config.js';
import { START, windowJson } from './helpers.js';

const H = 60 * 60 * 1000;
const proc = START; // processo iniciou em START
const script = join(dirname(fileURLToPath(import.meta.url)), '../ops/bt3probe-janela');

describe('T2 — janela (fail-closed)', () => {
  it('fecha sem arquivo, com arquivo inválido, vazio ou em formato errado', () => {
    expect(parseWindow(null, proc, START).open).toBe(false);
    expect(parseWindow('{', proc, START).open).toBe(false);
    expect(parseWindow('null', proc, START).open).toBe(false);
    expect(parseWindow('{}', proc, START).open).toBe(false);
    expect(parseWindow(JSON.stringify({ opened_at: '2026-11-15 12:00', open_until: '2026-11-15T13:00:00Z' }), proc, START).open).toBe(false);
    expect(parseWindow(JSON.stringify({ opened_at: '2026-11-15T12:00:00+03:00', open_until: '2026-11-15T13:00:00Z' }), proc, START).open).toBe(false);
  });

  it('abre só com opened_at depois do início do processo e prazo futuro', () => {
    const s = parseWindow(windowJson(START + 1000, START + H), proc, START + 2000);
    expect(s).toEqual({ open: true, until: START + H, reason: 'aberta' });
  });

  it('fecha com prazo vencido, janela > 12 h ou abertura no futuro', () => {
    expect(parseWindow(windowJson(START, START + 1000), proc, START + 1000).open).toBe(false);
    expect(parseWindow(windowJson(START, START + MAX_WINDOW_MS + 1), proc, START).open).toBe(false);
    expect(parseWindow(windowJson(START, START + MAX_WINDOW_MS), proc, START).open).toBe(true);
    // Aberta há 1 h com prazo 11 h + 1 ms à frente: faltam < 12 h, mas a janela inteira passa de 12 h.
    expect(parseWindow(windowJson(START + 1000, START + 1000 + MAX_WINDOW_MS + 1), proc, START + 3600_000).open).toBe(false);
    expect(parseWindow(windowJson(START + 1000, START + 1000 + MAX_WINDOW_MS), proc, START + 3600_000).open).toBe(true);
    expect(parseWindow(windowJson(START + 2 * 60_000, START + H), proc, START).open).toBe(false);
  });

  it('WindowWatcher começa fechado, relê a cada 5 s e fecha no prazo mesmo entre releituras', () => {
    const clock = new ManualClock(START);
    let text: string | null = null;
    const w = new WindowWatcher('/x', clock, START, () => text);
    expect(w.current().open).toBe(false); // antes de start(): fechado
    w.start();
    expect(w.current().open).toBe(false);
    text = windowJson(START + 1000, START + 7_000);
    clock.advance(4_000);
    expect(w.current().open).toBe(false); // ainda não releu
    clock.advance(1_000); // releitura em t = 5 000
    expect(w.current().open).toBe(true);
    clock.advance(1_999); // t = 6 999
    expect(w.current().open).toBe(true);
    clock.advance(1); // t = 7 000 = prazo, sem releitura (a próxima é em 10 000)
    expect(w.current()).toMatchObject({ open: false, reason: 'janela vencida' });
  });

  it('erro de leitura vira fechado', () => {
    const clock = new ManualClock(START);
    const w = new WindowWatcher('/x', clock, START, () => {
      throw new Error('EIO');
    });
    w.start();
    expect(w.current()).toMatchObject({ open: false, reason: 'erro ao ler a janela' });
  });
});

describe('T2 — script ops/bt3probe-janela', () => {
  it('"abrir" grava JSON que o servidor aceita; "fechar" remove; minutos fora de 1..720 recusados', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-j-'));
    const arq = join(dir, 'janela');
    const run = (...args: string[]) => spawnSync('sh', [script, ...args], { env: { PATH: process.env.PATH, BT3PROBE_WINDOW_FILE: arq }, encoding: 'utf8' });
    const inicio = Date.now(); // processo iniciou no mesmo instante: precisão de ms evita falso fechamento
    expect(run('abrir', '120').status).toBe(0);
    const s = parseWindow(readFileSync(arq, 'utf8'), inicio, Date.now());
    expect(s.open).toBe(true);
    expect(s.until! - Date.now()).toBeGreaterThan(119 * 60_000);
    expect(s.until! - Date.now()).toBeLessThanOrEqual(120 * 60_000);
    // Máximo permitido: exatamente 12 h, aceito pelo servidor (antes passava alguns ms e era recusado).
    for (let i = 0; i < 5; i++) {
      expect(run('abrir', '720').status).toBe(0);
      const j = JSON.parse(readFileSync(arq, 'utf8')) as { opened_at: string; open_until: string };
      expect(Date.parse(j.open_until) - Date.parse(j.opened_at)).toBe(MAX_WINDOW_MS);
      expect(parseWindow(JSON.stringify(j), inicio, Date.now())).toMatchObject({ open: true, until: Date.parse(j.open_until) });
    }
    expect(run('abrir', '721').status).toBe(2);
    expect(run('abrir', '0').status).toBe(2);
    expect(run('abrir', '-5').status).toBe(2);
    expect(run('abrir', '2h').status).toBe(2);
    expect(run('fechar').status).toBe(0);
    expect(existsSync(arq)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('T9 — reinício nunca reabre a rede sozinho', () => {
  it('janela ainda com 50 min restantes, aberta antes do reinício → FECHADA', () => {
    const openedAt = START;
    const until = START + H;
    const restartedAt = START + 10 * 60_000; // processo reiniciou 10 min depois de abrir
    const s = parseWindow(windowJson(openedAt, until), restartedAt, restartedAt + 1000);
    expect(until - (restartedAt + 1000)).toBeGreaterThan(49 * 60_000); // ainda havia tempo
    expect(s.open).toBe(false);
    expect(s.reason).toMatch(/antes do último reinício/);
  });

  it('nova autorização (opened_at depois do reinício) volta a abrir', () => {
    const restartedAt = START + 10 * 60_000;
    expect(parseWindow(windowJson(restartedAt + 5_000, START + H), restartedAt, restartedAt + 6_000).open).toBe(true);
  });

  it('opened_at 1 ms antes do início do processo já basta para fechar', () => {
    expect(parseWindow(windowJson(proc - 1, proc + H), proc, proc + 1000).open).toBe(false);
    expect(parseWindow(windowJson(proc, proc + H), proc, proc + 1000).open).toBe(true);
  });
});
