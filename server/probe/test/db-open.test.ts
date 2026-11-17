// Regressão da falha intermitente da CI de 17/11/2026 ("database is locked" ao abrir o banco).
// Causa confirmada por teste de estresse: com o WAL ligado ANTES do busy_timeout, cerca de 4,6% das
// aberturas simultâneas falhavam na hora (44 de 960); com o busy_timeout primeiro, 0 de 960.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { waitFor } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('db — abertura simultânea do mesmo arquivo', () => {
  it('10 rodadas × 16 aberturas ao mesmo tempo: nenhuma falha com "database is locked"', async () => {
    const erros: string[] = [];
    for (let rodada = 0; rodada < 10; rodada++) {
      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-o-'));
      const dbPath = join(dir, 'probe.db');
      openDb(dbPath).close(); // arquivo já em WAL, como depois de um uso real
      const sab = new SharedArrayBuffer(8);
      const gate = new Int32Array(sab);
      const ws = Array.from({ length: 16 }, () => new Worker(join(root, 'test/fixtures/open-worker.mjs'), { workerData: { dist: join(root, 'dist'), dbPath, sab } }));
      const rs = ws.map((w) => new Promise<string>((res, rej) => (w.once('message', res), w.once('error', rej))));
      await waitFor(() => Atomics.load(gate, 1) === 16, 10_000);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      erros.push(...(await Promise.all(rs)).filter((r) => r !== 'ok'));
      rmSync(dir, { recursive: true, force: true });
    }
    expect(erros).toEqual([]);
  });
});
