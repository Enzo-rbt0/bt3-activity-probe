// T3 health e T11 privacidade/Origin/limites do corpo; recusas antes do upgrade são HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget.js';
import { makeLogger } from '../src/log.js';
import { parseSessionRequest } from '../src/server.js';
import { admit, connect, harness, http, openSession, ORIGIN, tick, type Harness } from './helpers.js';

// JSON válido mas fora do contrato (e inválido): todos têm de dar 400 sem gastar nada.
const BAD_BODIES = [
  'null', '[]', '[{"kind":"echo"}]', '"echo"', '42', 'true', 'false', '{}',
  '{"kind":null}', '{"kind":["echo"]}', '{"kind":{"k":"echo"}}', '{"kind":"ECHO"}', '{"kind":"Relay"}',
  '{"kind":"echo","duration_s":"60"}', '{"kind":"echo","duration_s":null}', '{"kind":"echo","duration_s":0}',
  '{"kind":"echo","duration_s":-1}', '{"kind":"echo","duration_s":[60]}', '{"kind":"echo","duration_s":1e400}',
  '{"kind":"echo","extra":1}', '{"__proto__":{"kind":"echo"}}', '{"kind":"echo","__proto__":{}}', '{nope', '\u0000',
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('T3 — health', () => {
  it('fechado por padrão: janela ausente', async () => {
    h = await harness({ open: false });
    const r = await http(h.port, 'GET', '/net/health', undefined, {});
    expect(r.status).toBe(200);
    expect(r.body.aberto).toBe(false);
    expect(r.body.fecha_em).toBeNull();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('aberto: mostra prazo, tetos e uso do dia, sem bilhetes nem IDs', async () => {
    h = await harness();
    const a = await admit(h.port);
    const r = await http(h.port, 'GET', '/net/health');
    expect(r.body.aberto).toBe(true);
    expect(r.body.fecha_em).toBe(new Date(h.clock.now() + 3600_000).toISOString());
    expect(r.body.tetos).toEqual({
      sessoes_simultaneas: 4,
      admissoes_por_dia: 30,
      mensagens_reservadas_por_dia: 60000,
      bytes_por_mensagem: 64,
      mensagens_por_segundo: 120,
      rajada_mensagens: 360,
      duracao_maxima_s: 180,
      inatividade_s: 60,
    });
    expect(r.body.uso_do_dia).toEqual({ admissoes: 1, mensagens_reservadas: 3960, sessoes_ativas: 1 });
    expect(JSON.stringify(r.body)).not.toContain(a.body.bilhete);
  });
});

describe('T11 — Origin, corpo e privacidade', () => {
  it('POST sem Origin ou com Origin estranha → 403', async () => {
    h = await harness();
    expect((await http(h.port, 'POST', '/net/session', '{"kind":"echo"}', {})).status).toBe(403);
    expect((await http(h.port, 'POST', '/net/session', '{"kind":"echo"}', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await http(h.port, 'POST', '/net/session', '{"kind":"echo"}', { origin: ORIGIN + '.evil.example' })).status).toBe(403);
  });

  it('preflight: 204 com CORS só para Origin permitida', async () => {
    h = await harness();
    const ok = await http(h.port, 'OPTIONS', '/net/session');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    const bad = await http(h.port, 'OPTIONS', '/net/session', undefined, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('corpo > 256 bytes → 413; JSON inválido, tipo ou duração inválidos → 400; rota → 404', async () => {
    h = await harness();
    expect((await http(h.port, 'POST', '/net/session', JSON.stringify({ kind: 'echo', pad: 'x'.repeat(300) }))).status).toBe(413);
    expect((await http(h.port, 'POST', '/net/session', '{nope')).status).toBe(400);
    expect((await http(h.port, 'POST', '/net/session', '{"kind":"relay2"}')).status).toBe(400);
    expect((await http(h.port, 'POST', '/net/session', '{"kind":"echo","duration_s":-1}')).status).toBe(400);
    expect((await http(h.port, 'POST', '/net/session', '{"kind":"echo","duration_s":"abc"}')).status).toBe(400);
    expect((await http(h.port, 'GET', '/net/outra')).status).toBe(404);
    // Nada disso consumiu orçamento.
    expect(h.server.budget.stats(h.clock.now()).admissions).toBe(0);
  });

  it('parseSessionRequest: só objeto com kind conhecido e duration_s numérico positivo', () => {
    for (const b of BAD_BODIES) expect(parseSessionRequest(b, DEFAULT_LIMITS).ok, b).toBe(false);
    expect(parseSessionRequest('', DEFAULT_LIMITS).ok).toBe(false); // corpo vazio = {} = sem kind
    expect(parseSessionRequest('{"kind":"echo"}', DEFAULT_LIMITS)).toEqual({ ok: true, kind: 'echo', durationMs: 60_000 });
    expect(parseSessionRequest('{"kind":"echo","duration_s":1.5}', DEFAULT_LIMITS)).toEqual({ ok: true, kind: 'echo', durationMs: 1500 });
    expect(parseSessionRequest('null', DEFAULT_LIMITS)).toEqual({ ok: false, erro: 'o corpo precisa ser um objeto JSON' });
    expect(parseSessionRequest('{"kind":"relay","duration_s":180}', DEFAULT_LIMITS)).toEqual({ ok: true, kind: 'relay', durationMs: 180_000 });
  });

  it(`${BAD_BODIES.length} corpos fora do contrato → 400 cada, servidor segue vivo e nada é reservado`, async () => {
    h = await harness();
    for (const b of BAD_BODIES) expect((await http(h.port, 'POST', '/net/session', b)).status, b).toBe(400);
    expect(h.server.budget.stats(h.clock.now())).toMatchObject({ admissions: 0, reserved_msgs: 0, active: 0 });
    expect((await admit(h.port)).status).toBe(201);
  });

  it('GET /net/health é somente leitura: não cria linha no banco nem abre transação', async () => {
    h = await harness();
    const before = h.db.accesses;
    for (let i = 0; i < 3; i++) expect((await http(h.port, 'GET', '/net/health')).status).toBe(200);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM daily').get()).toEqual({ n: 0 });
    expect(h.db.accesses).toBe(before);
  });

  it('duração acima do máximo é limitada a 180 s', async () => {
    h = await harness();
    const r = await admit(h.port, 9999);
    expect(r.status).toBe(201);
    expect(r.body.duracao_s).toBe(180);
    expect(r.body.mensagens_reservadas).toBe(11880);
  });

  it('janela fechada → POST 503 e upgrade 503 (HTTP, sem código de fechamento)', async () => {
    h = await harness();
    const a = await admit(h.port);
    h.windowText.value = null;
    h.server.window.reload();
    expect((await admit(h.port)).status).toBe(503);
    expect(await connect(h.port, a.body.bilhete)).toEqual({ kind: 'http', status: 503 });
  });

  it('logger descarta qualquer campo fora da lista fechada', () => {
    const out: string[] = [];
    const log = makeLogger((l) => out.push(l));
    log('x', { kind: 'echo', ip: '203.0.113.9', url: '/net/ws/echo?bilhete=abc', origin: 'https://a', ua: 'Mozilla' } as never);
    expect(JSON.parse(out[0]!)).toEqual({ event: 'x', kind: 'echo' });
  });

  it('log não contém bilhete, ID de sessão, IP nem Origin', async () => {
    h = await harness();
    const s = await openSession(h.port);
    s.ws.send('oi');
    await tick();
    s.ws.close();
    await s.closed;
    await tick();
    await connect(h.port, 'f'.repeat(32), 'https://evil.example');
    const all = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(2);
    expect(all).not.toContain(s.ticket);
    expect(all).not.toContain('127.0.0.1');
    expect(all).not.toContain('discordsays');
    expect(all).not.toContain('evil');
    const ids = h.db.raw.prepare('SELECT id FROM sessions').all() as { id: string }[];
    for (const { id } of ids) expect(all).not.toContain(id);
    for (const line of h.logs) for (const k of Object.keys(JSON.parse(line))) expect(['event', 'kind', 'code', 'reason', 'status', 'received', 'closed', 'port']).toContain(k);
  });
});
