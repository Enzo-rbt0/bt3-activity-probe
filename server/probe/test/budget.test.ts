// T4 concorrência, tetos diários e virada de dia UTC; T6 encerramento idempotente.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { Budget, DEFAULT_LIMITS, quotaFor } from '../src/budget.js';
import { openDb } from '../src/db.js';
import { admit, connect, harness, openSession, START, tick, waitFor, type Harness } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('T4 — concorrência', () => {
  it('50 admissões HTTP simultâneas → exatamente 4 aceitas (201) e 46 recusadas (429)', async () => {
    h = await harness();
    const rs = await Promise.all(Array.from({ length: 50 }, () => admit(h!.port)));
    const by = (s: number) => rs.filter((r) => r.status === s).length;
    expect(by(201)).toBe(4);
    expect(by(429)).toBe(46);
    expect(new Set(rs.filter((r) => r.status === 201).map((r) => r.body.bilhete)).size).toBe(4);
    const st = h.server.budget.stats(h.clock.now());
    expect(st).toMatchObject({ admissions: 4, active: 4, reserved_msgs: 4 * quotaFor(60_000, DEFAULT_LIMITS) });
  });

  it('8 threads × 10 admissões no MESMO arquivo SQLite (conexões separadas) → exatamente 4', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-w-'));
    const dbPath = join(dir, 'probe.db');
    openDb(dbPath).close(); // cria o esquema antes da largada
    const sab = new SharedArrayBuffer(8);
    const gate = new Int32Array(sab);
    const workers = Array.from(
      { length: 8 },
      () => new Worker(join(root, 'test/fixtures/admit-worker.mjs'), { workerData: { dist: join(root, 'dist'), dbPath, sab, n: 10, now: START } }),
    );
    const results = workers.map((w) => new Promise<string[]>((res, rej) => (w.once('message', res), w.once('error', rej))));
    await waitFor(() => Atomics.load(gate, 1) === 8, 10_000);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const all = (await Promise.all(results)).flat();
    expect(all.filter((x) => x.startsWith('erro')).length).toBe(0);
    expect(all.filter((x) => x === 'ok').length).toBe(4);
    expect(all.filter((x) => x === 'limite de sessões simultâneas').length).toBe(76);
    const db = openDb(dbPath);
    expect(db.raw.prepare('SELECT admissions FROM daily').get()).toEqual({ admissions: 4 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 4 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('5ª sessão é recusada enquanto 4 estão conectadas; ao fechar uma, a vaga volta', async () => {
    h = await harness();
    const ss = [];
    for (let i = 0; i < 4; i++) ss.push(await openSession(h.port));
    expect((await admit(h.port)).status).toBe(429);
    ss[0]!.ws.close();
    await ss[0]!.closed;
    await waitFor(() => h!.server.conns.size === 3);
    expect((await admit(h.port)).status).toBe(201);
    for (const s of ss.slice(1)) s.ws.close();
  });

  it('bilhete não usado vence em 30 s, libera a vaga e devolve a reserva', async () => {
    h = await harness();
    for (let i = 0; i < 4; i++) expect((await admit(h.port)).status).toBe(201);
    expect((await admit(h.port)).status).toBe(429);
    h.clock.advance(30_000);
    const r = await admit(h.port);
    expect(r.status).toBe(201);
    const st = h.server.budget.stats(h.clock.now());
    expect(st.active).toBe(1);
    expect(st.reserved_msgs).toBe(quotaFor(60_000, DEFAULT_LIMITS)); // as 4 reservas vencidas voltaram
    expect(st.admissions).toBe(5); // admissões não voltam
  });
});

describe('T4 — quotaFor: reserva sem erro de ponto flutuante', () => {
  it('60 s → 3960, 10 s → 660, 180 s → 11880, 1 s → 66', () => {
    expect([60_000, 10_000, 180_000, 1_000].map((d) => quotaFor(d, DEFAULT_LIMITS))).toEqual([3960, 660, 11880, 66]);
    expect(quotaFor(1_500, DEFAULT_LIMITS)).toBe(99);
    expect(quotaFor(1_001, DEFAULT_LIMITS)).toBe(67); // 66,066 → teto 67
  });
});

describe('T4 — tetos diários e virada de dia UTC', () => {
  it('31ª admissão do dia → 429; no dia UTC seguinte volta a aceitar', async () => {
    h = await harness({ limits: { maxConcurrent: 1000 } });
    for (let i = 0; i < 30; i++) expect((await admit(h.port, 1)).status).toBe(201);
    const r = await admit(h.port, 1);
    expect(r.status).toBe(429);
    expect(r.body.erro).toBe('limite de admissões do dia');
    h.clock.advance(12 * 3600_000); // 12:00 → 00:00 UTC do dia 16
    h.open();
    expect((await admit(h.port, 1)).status).toBe(201);
    expect(h.server.budget.stats(h.clock.now())).toMatchObject({ day: '2026-11-16', admissions: 1 });
  });

  it('orçamento de mensagens reservadas: recusa quando a reserva não cabe e devolve a sobra no fim', async () => {
    h = await harness({ limits: { maxReservedPerDay: 1000 } });
    const s = await openSession(h.port, 10); // 10 s × 60 × 1,1 = 660
    const r = await admit(h.port, 10);
    expect(r.status).toBe(429);
    expect(r.body.erro).toBe('orçamento de mensagens do dia');
    for (let i = 0; i < 5; i++) s.ws.send('x');
    await waitFor(() => s.messages.length === 5);
    s.ws.close();
    await s.closed;
    await waitFor(() => h!.server.conns.size === 0);
    expect(h.server.budget.stats(h.clock.now()).reserved_msgs).toBe(5); // sobra devolvida: 660 − 5
    expect((await admit(h.port, 10)).status).toBe(201);
  });
});

describe('T6 — encerramento idempotente', () => {
  it('end() devolve a sobra uma única vez, mesmo chamado várias vezes ou em paralelo', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-e-'));
    const db = openDb(join(dir, 'p.db'));
    const b = new Budget(db);
    const a = b.admit('echo', 60_000, START);
    if (!a.ok) throw new Error('admit');
    const s = b.redeem(a.ticket, START + 3600_000, START);
    expect(s).not.toBeNull();
    expect(b.end(a.sessionId, 100, START + 1000)).toBe(true);
    expect(b.end(a.sessionId, 0, START + 2000)).toBe(false);
    expect(b.end(a.sessionId, 0, START + 3000)).toBe(false);
    expect(b.stats(START + 4000).reserved_msgs).toBe(100);
    // used maior que a reserva é limitado (nunca devolve negativo)
    const a2 = b.admit('echo', 1000, START);
    if (!a2.ok) throw new Error('admit');
    b.end(a2.sessionId, 10_000, START);
    expect(b.stats(START).reserved_msgs).toBe(100 + a2.reserved);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fechamento pelo servidor + close do cliente + varredura: uma devolução só', async () => {
    h = await harness();
    const s = await openSession(h.port, 10);
    s.ws.send('a');
    await waitFor(() => s.messages.length === 1);
    h.clock.advance(10_000); // prazo → servidor fecha (4001), cliente responde close, varredura passa
    const c = await s.closed;
    expect(c.code).toBe(4001);
    h.clock.advance(3_000);
    await tick();
    const row = h.db.raw.prepare('SELECT used_msgs, ended_at FROM sessions').get() as { used_msgs: number; ended_at: number };
    expect(row.used_msgs).toBe(1);
    expect(h.server.budget.stats(h.clock.now()).reserved_msgs).toBe(1);
    expect(h.logs.filter((l) => l.includes('sessao_encerrada')).length).toBe(1);
  });

  it('upgrade com bilhete já resgatado é recusado mesmo depois do fim da sessão', async () => {
    h = await harness();
    const s = await openSession(h.port);
    s.ws.close();
    await s.closed;
    expect(await connect(h.port, s.ticket)).toEqual({ kind: 'http', status: 403 });
  });
});
