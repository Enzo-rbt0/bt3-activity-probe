// T9 (servidor), T10 falhas (banco indisponível, SIGTERM no processo real) e T1 (sem segredos, bind local).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Budget, DEFAULT_LIMITS, quotaFor } from '../src/budget.js';
import { ManualClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { admit, connect, harness, http, openSession, START, tick, waitFor, windowJson, type Harness } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-r-'));
let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('T9 — reinício durante uma janela que ainda tem tempo restante', () => {
  it('processo novo começa FECHADO, recusa tudo, gasta as reservas abertas e só reabre com nova autorização', async () => {
    const dir = tmp();
    const dbPath = join(dir, 'probe.db');
    const windowText = { value: windowJson(START, START + 3600_000) }; // aberta às 12:00 até 13:00
    // Processo 1 "cai" às 12:10 com uma sessão conectada e um bilhete emitido e não usado.
    const db1 = openDb(dbPath);
    const b1 = new Budget(db1);
    const conectada = b1.admit('echo', 180_000, START + 600_000);
    const pendente = b1.admit('echo', 60_000, START + 600_000);
    if (!conectada.ok || !pendente.ok) throw new Error('admit');
    expect(b1.redeem(conectada.ticket, START + 3600_000, START + 600_000)).not.toBeNull();
    db1.close(); // sem end(): queda

    // Processo 2 inicia às 12:11 (49 min de janela ainda restantes).
    const clock = new ManualClock(START + 660_000);
    h = await harness({ dir, clock, windowText, open: false });
    const health = await http(h.port, 'GET', '/net/health');
    expect(health.body.aberto).toBe(false);
    expect(health.body.motivo).toMatch(/antes do último reinício/);
    expect((await admit(h.port)).status).toBe(503);
    expect(await connect(h.port, pendente.ticket)).toEqual({ kind: 'http', status: 503 });
    // Releituras periódicas não mudam nada: o arquivo é o mesmo.
    h.clock.advance(15_000);
    expect((await http(h.port, 'GET', '/net/health')).body.aberto).toBe(false);
    // Reservas de antes da queda ficam gastas por inteiro (conservador).
    const st = h.server.budget.stats(h.clock.now());
    expect(st.active).toBe(0);
    expect(st.reserved_msgs).toBe(quotaFor(180_000, DEFAULT_LIMITS) + quotaFor(60_000, DEFAULT_LIMITS));

    // Nova autorização operacional (opened_at depois do reinício) reabre.
    h.open();
    expect((await http(h.port, 'GET', '/net/health')).body.aberto).toBe(true);
    // Mas nenhum bilhete de antes do reinício vale.
    expect(await connect(h.port, pendente.ticket)).toEqual({ kind: 'http', status: 403 });
    expect((await admit(h.port)).status).toBe(201);
    await h.close();
    h = null;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('T10 — falhas', () => {
  it('banco indisponível → admissão 503 e upgrade 503 (fail-closed); health continua respondendo', async () => {
    h = await harness();
    const r = await admit(h.port);
    h.db.close();
    expect((await admit(h.port)).status).toBe(503);
    expect(await connect(h.port, r.body.bilhete)).toEqual({ kind: 'http', status: 503 });
    const health = await http(h.port, 'GET', '/net/health');
    expect(health.status).toBe(200);
    expect(health.body.uso_do_dia).toBe('indisponível');
  });

  it('stop() (o que o SIGTERM chama): fecha sessões com 1001, devolve a sobra e recusa novas', async () => {
    h = await harness();
    const s = await openSession(h.port, 180);
    s.ws.send('a');
    await waitFor(() => s.messages.length === 1);
    const port = h.port;
    const stopping = h.server.stop();
    expect((await s.closed).code).toBe(1001);
    await stopping;
    const row = h.db.raw.prepare('SELECT used_msgs, ended_at FROM sessions').get() as { used_msgs: number; ended_at: number | null };
    expect(row.ended_at).not.toBeNull();
    expect(row.used_msgs).toBe(1);
    await expect(admit(port)).rejects.toThrow(); // porta fechada
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    h = null;
  });

  it('processo real: janela de antes do início → fechado; nova janela → abre; SIGTERM → 1001 e saída 0', async () => {
    const dir = tmp();
    const dbPath = join(dir, 'probe.db');
    const winPath = join(dir, 'janela');
    writeFileSync(winPath, windowJson(Date.now() - 60_000, Date.now() + 3600_000)); // aberta "antes do reinício"
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'dist/main.js')], {
      env: { PATH: process.env.PATH, BT3PROBE_PORT: '0', BT3PROBE_DB: dbPath, BT3PROBE_WINDOW_FILE: winPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => lines.push(...d.toString().trim().split('\n')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    try {
      await waitFor(() => lines.some((l) => l.includes('"start"')), 10_000);
      const port = JSON.parse(lines.find((l) => l.includes('"start"'))!).port as number;
      const hl = await http(port, 'GET', '/net/health');
      expect(hl.body.aberto).toBe(false);
      expect((await admit(port)).status).toBe(503);
      writeFileSync(winPath, windowJson(Date.now(), Date.now() + 3600_000)); // nova autorização
      const end = Date.now() + 8000;
      let open = false;
      while (!open && Date.now() < end) {
        open = (await http(port, 'GET', '/net/health')).body.aberto === true;
        if (!open) await tick(250);
      }
      expect(open).toBe(true);
      const s = await openSession(port, 60);
      s.ws.send('oi');
      await waitFor(() => s.messages.length === 1);
      child.kill('SIGTERM');
      expect((await s.closed).code).toBe(1001);
      expect(await exited).toBe(0);
      expect(stderr).toBe('');
      const db = openDb(dbPath);
      expect(db.raw.prepare('SELECT used_msgs, ended_at IS NOT NULL AS ended FROM sessions').get()).toEqual({ used_msgs: 1, ended: 1 });
      db.close();
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('processo real: JSON "null" e outros corpos fora do contrato → 400, processo segue vivo, nada reservado', async () => {
    const dir = tmp();
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'dist/main.js')], {
      env: { PATH: process.env.PATH, BT3PROBE_PORT: '0', BT3PROBE_DB: join(dir, 'p.db'), BT3PROBE_WINDOW_FILE: join(dir, 'janela') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => lines.push(...d.toString().trim().split('\n')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    try {
      await waitFor(() => lines.some((l) => l.includes('"start"')), 10_000);
      const port = JSON.parse(lines.find((l) => l.includes('"start"'))!).port as number;
      const bodies = ['null', '[]', '"echo"', '1', 'true', '{"kind":null}', '{"kind":"echo","duration_s":"60"}', '{"__proto__":{"kind":"echo"}}'];
      for (let round = 0; round < 2; round++) {
        // 1ª rodada com a janela fechada (o corpo é validado antes da janela), 2ª com a janela aberta.
        if (round === 1) {
          writeFileSync(join(dir, 'janela'), windowJson(Date.now(), Date.now() + 3600_000));
          const end = Date.now() + 8000;
          while ((await http(port, 'GET', '/net/health')).body.aberto !== true && Date.now() < end) await tick(250);
        }
        for (const b of bodies) expect((await http(port, 'POST', '/net/session', b)).status, b).toBe(400);
      }
      await tick(100);
      expect(child.exitCode).toBeNull(); // processo vivo
      expect(stderr).toBe('');
      const health = await http(port, 'GET', '/net/health');
      expect(health.body.aberto).toBe(true);
      expect(health.body.uso_do_dia).toEqual({ admissoes: 0, mensagens_reservadas: 0, sessoes_ativas: 0 });
      expect((await admit(port)).status).toBe(201); // continua atendendo
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('main recusa escutar fora de 127.0.0.1 sem confirmação explícita', async () => {
    const child = spawn(process.execPath, [join(root, 'dist/main.js')], {
      env: { PATH: process.env.PATH, BT3PROBE_HOST: '0.0.0.0', BT3PROBE_PORT: '0', BT3PROBE_DB: ':memory:' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(2);
  });
});

describe('T1 — sem segredos no código do servidor', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'dist') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);

  it('nenhum arquivo .env, chave privada, token do Discord/GitHub/AWS ou OCID de tenancy/usuário', () => {
    expect(files.length).toBeGreaterThan(10);
    const bad = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
      /\b[MN][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,}\b/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bocid1\.(tenancy|user|apikey)\.[a-z0-9.]+/,
    ];
    for (const f of files) {
      expect(f.split('/').pop()).not.toMatch(/^\.env/);
      const text = readFileSync(f, 'utf8');
      for (const re of bad) expect(re.test(text), `${f} casa ${re}`).toBe(false);
    }
  });
});
