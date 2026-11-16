import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_LIMITS, type Limits } from '../src/budget.js';
import { ManualClock } from '../src/clock.js';
import { openDb, type Db } from '../src/db.js';
import { makeLogger } from '../src/log.js';
import { ProbeServer } from '../src/server.js';

export const ORIGIN = 'https://1571332639812493522.discordsays.com';
export const START = Date.UTC(2026, 10, 15, 12, 0, 0);

export const iso = (t: number) => new Date(t).toISOString();
export const windowJson = (openedAt: number, until: number) => JSON.stringify({ opened_at: iso(openedAt), open_until: iso(until) });

export interface Harness {
  server: ProbeServer;
  clock: ManualClock;
  db: Db;
  dbPath: string;
  dir: string;
  port: number;
  logs: string[];
  windowText: { value: string | null };
  /** Abre a janela "agora" (opened_at = agora, depois do início do processo) por `ms`. */
  open(ms?: number): void;
  close(): Promise<void>;
}

export async function harness(
  o: { limits?: Partial<Limits>; open?: boolean; dir?: string; clock?: ManualClock; processStartedAt?: number; windowText?: { value: string | null } } = {},
): Promise<Harness> {
  const dir = o.dir ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bt3probe-'));
  const dbPath = join(dir, 'probe.db');
  const clock = o.clock ?? new ManualClock(START);
  const db = openDb(dbPath);
  const logs: string[] = [];
  const windowText = o.windowText ?? { value: null };
  const processStartedAt = o.processStartedAt ?? clock.now();
  const server = new ProbeServer({
    db,
    clock,
    windowFile: '/nao/usado',
    processStartedAt,
    limits: { ...DEFAULT_LIMITS, ...o.limits },
    log: makeLogger((l) => logs.push(l)),
    readWindow: () => windowText.value,
  });
  const h: Harness = {
    server,
    clock,
    db,
    dbPath,
    dir,
    port: 0,
    logs,
    windowText,
    open(ms = 60 * 60 * 1000) {
      windowText.value = windowJson(clock.now(), clock.now() + ms);
      server.window.reload();
    },
    async close() {
      await server.stop();
      try {
        db.close();
      } catch {
        /* já fechado pelo teste */
      }
      if (!o.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  h.port = await server.start();
  if (o.open !== false) h.open();
  return h;
}

export interface Resp { status: number; body: any; headers: Record<string, unknown> }

export function http(port: number, method: string, path: string, body?: string, headers: Record<string, string> = { origin: ORIGIN }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* texto */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const admit = (port: number, duration_s?: number) =>
  http(port, 'POST', '/net/session', JSON.stringify(duration_s === undefined ? { kind: 'echo' } : { kind: 'echo', duration_s }));

/** Resultado de uma tentativa de WebSocket: recusa HTTP antes do upgrade OU conexão aberta. */
export type WsAttempt = { kind: 'http'; status: number } | { kind: 'open'; ws: WebSocket; closed: Promise<{ code: number; reason: string }>; messages: Buffer[] };

export function connect(port: number, ticket: string, origin = ORIGIN): Promise<WsAttempt> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/net/ws/echo?bilhete=${ticket}`, { origin });
    const messages: Buffer[] = [];
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('message', (d: Buffer) => messages.push(d));
    ws.on('unexpected-response', (_req, res) => {
      resolve({ kind: 'http', status: res.statusCode ?? 0 });
      res.resume();
      ws.terminate();
    });
    ws.on('open', () => resolve({ kind: 'open', ws, closed, messages }));
    ws.on('error', (e) => {
      if (ws.readyState === WebSocket.CONNECTING) reject(e);
    });
  });
}

export async function openSession(port: number, duration_s?: number) {
  const r = await admit(port, duration_s);
  if (r.status !== 201) throw new Error(`admissão falhou: ${r.status} ${JSON.stringify(r.body)}`);
  const a = await connect(port, r.body.bilhete);
  if (a.kind !== 'open') throw new Error(`upgrade falhou: ${a.status}`);
  return { ...a, ticket: r.body.bilhete as string };
}

/** Espera o servidor processar mensagens já enviadas (I/O real; o relógio é manual). */
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('tempo esgotado');
    await tick(10);
  }
}
