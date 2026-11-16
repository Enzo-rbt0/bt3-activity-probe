// T2 e T9 (parte unitária): interruptor controlado pelo servidor, desligado por padrão, e regra do reinício.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { FUTURE_SKEW_MS, MAX_WINDOW_MS, parseWindow, WindowWatcher } from '../src/config.js';
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

describe('T2 — limites da janela (PR #6, determinísticos: relógio passado como parâmetro)', () => {
  // processo iniciou em P; "agora" = N. Nada aqui lê o relógio real.
  const P = START;
  const N = START + 10_000;
  const at = (openedOffset: number, lengthMs: number, now = N, proc0 = P) =>
    parseWindow(windowJson(N + openedOffset, N + openedOffset + lengthMs), proc0, now);

  it('1. janela de exatamente 12 h → aceita', () => {
    expect(at(0, MAX_WINDOW_MS)).toEqual({ open: true, until: N + MAX_WINDOW_MS, reason: 'aberta' });
  });

  it('2. abertura 30 s no futuro (dentro da tolerância), com 12 h exatas → aceita', () => {
    expect(at(30_000, MAX_WINDOW_MS)).toEqual({ open: true, until: N + 30_000 + MAX_WINDOW_MS, reason: 'aberta' });
    // limite da tolerância: exatamente 60 s no futuro ainda é aceito
    expect(at(FUTURE_SKEW_MS, MAX_WINDOW_MS).open).toBe(true);
  });

  it('3. abertura 61 s no futuro → recusada', () => {
    expect(at(61_000, 3600_000)).toMatchObject({ open: false, reason: 'abertura no futuro' });
    expect(at(FUTURE_SKEW_MS + 1, 3600_000)).toMatchObject({ open: false, reason: 'abertura no futuro' });
  });

  it('4. janela de 12 h + 1 ms → recusada (no presente e com abertura no futuro tolerado)', () => {
    expect(at(0, MAX_WINDOW_MS + 1)).toMatchObject({ open: false, reason: 'janela maior que 12 h' });
    expect(at(30_000, MAX_WINDOW_MS + 1)).toMatchObject({ open: false, reason: 'janela maior que 12 h' });
    // aberta há 1 h: faltam menos de 12 h, mas a janela inteira passa de 12 h
    expect(at(-3600_000, MAX_WINDOW_MS + 1, N, N - 3600_000)).toMatchObject({ open: false, reason: 'janela maior que 12 h' });
  });

  it('5. vencimento anterior ou igual à abertura → recusado (inclusive com abertura no futuro tolerado)', () => {
    expect(at(30_000, 0)).toMatchObject({ open: false, reason: 'vencimento anterior ou igual à abertura' });
    expect(at(30_000, -20_000)).toMatchObject({ open: false, reason: 'vencimento anterior ou igual à abertura' });
    expect(at(0, -1)).toMatchObject({ open: false, reason: 'vencimento anterior ou igual à abertura' });
    expect(at(30_000, 1).open).toBe(true); // 1 ms depois da abertura: válido
  });

  it('6. reinício com janela ainda válida (12 h, 11 h restantes) → permanece fechada', () => {
    const restart = N + 3600_000; // processo reiniciou 1 h depois da abertura
    expect(at(0, MAX_WINDOW_MS, restart + 1000, restart)).toMatchObject({ open: false, reason: 'janela aberta antes do último reinício: abrir de novo' });
    // nova abertura depois do reinício volta a valer
    expect(parseWindow(windowJson(restart + 500, restart + 500 + MAX_WINDOW_MS), restart, restart + 1000).open).toBe(true);
  });

  it('a regra removida ("restante ≤ 12 h") não volta: relógio do servidor 1 ms atrás da abertura, 12 h exatas → aceita', () => {
    expect(at(1, MAX_WINDOW_MS).open).toBe(true);
  });
});

describe('T2 — script ops/bt3probe-janela (processo real, sem depender de diferenças entre leituras do relógio)', () => {
  it('"abrir" grava JSON aceito pelo servidor; "fechar" remove; minutos fora de 1..720 recusados', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-j-'));
    const arq = join(dir, 'janela');
    const run = (...args: string[]) => spawnSync('sh', [script, ...args], { env: { PATH: process.env.PATH, BT3PROBE_WINDOW_FILE: arq }, encoding: 'utf8' });
    const ler = () => {
      const text = readFileSync(arq, 'utf8');
      const j = JSON.parse(text) as { opened_at: string; open_until: string };
      expect(j.opened_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(j.open_until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      return { text, opened: Date.parse(j.opened_at), until: Date.parse(j.open_until) };
    };
    const milissegundos: number[] = [];

    expect(run('abrir', '120').status).toBe(0);
    const a = ler();
    expect(a.until - a.opened).toBe(120 * 60_000); // vem só do arquivo
    // Avaliado no próprio instante de abertura: o resultado não depende do relógio da máquina de teste.
    expect(parseWindow(a.text, a.opened, a.opened)).toEqual({ open: true, until: a.until, reason: 'aberta' });
    // Sanidade folgada (1 min) de que o script usa o relógio atual; não compara milissegundos.
    expect(Math.abs(a.opened - Date.now())).toBeLessThan(60_000);
    milissegundos.push(a.opened % 1000);

    // Máximo permitido: exatamente 12 h (antes, duas leituras de "date" passavam alguns ms).
    for (let i = 0; i < 5; i++) {
      expect(run('abrir', '720').status).toBe(0);
      const b = ler();
      expect(b.until - b.opened).toBe(MAX_WINDOW_MS);
      expect(parseWindow(b.text, b.opened, b.opened)).toEqual({ open: true, until: b.until, reason: 'aberta' });
      // Mesmo arquivo com o relógio do servidor 30 s atrás da abertura (dentro da tolerância): aceito.
      expect(parseWindow(b.text, b.opened - 30_000, b.opened - 30_000).open).toBe(true);
      // E um processo iniciado 1 ms depois da abertura (reinício) o ignora.
      expect(parseWindow(b.text, b.opened + 1, b.opened + 1).open).toBe(false);
      milissegundos.push(b.opened % 1000);
    }
    // opened_at tem milissegundos de verdade (não arredondado ao segundo): em 6 aberturas, ao menos uma
    // tem parte de ms diferente de zero (a chance de todas serem .000 por acaso é ~10^-18).
    expect(milissegundos.some((ms) => ms !== 0)).toBe(true);

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
