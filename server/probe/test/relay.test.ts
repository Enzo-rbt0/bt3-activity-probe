// T16 — F3c: salas de relay entre dois aparelhos (servidor real em 127.0.0.1, relógio manual).
import { afterEach, describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LEN, MAX_JOIN_TRIES, normalizeCode, ROOM_WAIT_MS } from '../src/relay.js';
import { admit, connect, harness, openRelay, tick, waitFor, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function pair(hh: Harness) {
  const a = await openRelay(hh.port);
  const b = await openRelay(hh.port);
  a.say({ t: 'criar' });
  const code = (await a.next('sala')).codigo as string;
  b.say({ t: 'entrar', codigo: `${code.slice(0, 3).toLowerCase()}-${code.slice(3)}` }); // aceita minúsculas e hífen
  await a.next('par');
  await b.next('par');
  return { a, b, code };
}

describe('T16 — salas (criar, entrar, largada)', () => {
  it('criar devolve código de 6 símbolos do alfabeto; entrar junta os dois e avisa ambos', async () => {
    h = await harness();
    const { code } = await pair(h);
    expect(code).toHaveLength(CODE_LEN);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    expect(h.server.rooms.active).toBe(1);
  });

  it('ping → pong com o mesmo número (mede RTT e mantém a conexão viva)', async () => {
    h = await harness();
    const a = await openRelay(h.port);
    a.say({ t: 'ping', n: 7 });
    expect(await a.next('pong')).toEqual({ t: 'pong', n: 7 });
    a.say({ t: 'ping', n: -1 });
    expect(await a.next('erro')).toEqual({ t: 'erro', motivo: 'ping inválido' });
  });

  it('largada só com os dois prontos; cada um recebe o RTT do outro; antes disso nada binário passa', async () => {
    h = await harness();
    const { a, b } = await pair(h);
    a.ws.send(Buffer.from('cedo'));
    a.say({ t: 'pronto', rtt: 185.4 });
    await tick(50);
    expect(a.ctl.some((m) => m.t === 'comecar')).toBe(false);
    b.say({ t: 'pronto', rtt: 199 });
    expect(await a.next('comecar')).toEqual({ t: 'comecar', rtt_outro: 199 });
    expect(await b.next('comecar')).toEqual({ t: 'comecar', rtt_outro: 185 });
    expect(b.bins).toHaveLength(0); // o "cedo" não foi repassado
  });

  it('depois da largada: o binário de A chega igual a B (e não volta para A), e vice-versa, sem SQLite por mensagem', async () => {
    h = await harness();
    const { a, b } = await pair(h);
    a.say({ t: 'pronto', rtt: 1 });
    b.say({ t: 'pronto', rtt: 1 });
    await a.next('comecar');
    await b.next('comecar');
    const before = h.db.accesses;
    for (let i = 0; i < 50; i++) a.ws.send(Buffer.from([i, 1, 2, 3]));
    for (let i = 0; i < 30; i++) b.ws.send(Buffer.from([i, 9]));
    await waitFor(() => b.bins.length === 50 && a.bins.length === 30);
    expect([...b.bins[42]!]).toEqual([42, 1, 2, 3]);
    expect([...a.bins[7]!]).toEqual([7, 9]);
    expect(h.db.accesses).toBe(before);
  });
});

describe('T16 — recusas e limites', () => {
  it('código errado → erro; terceiro aparelho → "sala cheia"; já numa sala → erro', async () => {
    h = await harness({ limits: { maxConcurrent: 4 } });
    const { a, code } = await pair(h);
    const c = await openRelay(h.port);
    c.say({ t: 'entrar', codigo: 'ZZZZZZ' });
    expect(await c.next('erro')).toEqual({ t: 'erro', motivo: 'código inválido ou vencido' });
    c.ctl.length = 0;
    c.say({ t: 'entrar', codigo: code });
    expect(await c.next('erro')).toEqual({ t: 'erro', motivo: 'sala cheia' });
    a.say({ t: 'criar' });
    expect(await a.next('erro')).toEqual({ t: 'erro', motivo: 'já está numa sala' });
  });

  it(`mais de ${MAX_JOIN_TRIES} tentativas de código na mesma conexão → 4002`, async () => {
    h = await harness();
    const c = await openRelay(h.port);
    for (let i = 0; i <= MAX_JOIN_TRIES; i++) c.say({ t: 'entrar', codigo: 'ZZZZZZ' });
    expect(await c.closed).toEqual({ code: 4002, reason: 'tentativas demais' });
  });

  it('sala sem segundo aparelho vence em 2 min (criador avisado); o código deixa de valer', async () => {
    h = await harness();
    const a = await openRelay(h.port);
    a.say({ t: 'criar' });
    const code = (await a.next('sala')).codigo as string;
    for (let t = 0; t < ROOM_WAIT_MS; t += 10_000) {
      h.clock.advance(10_000);
      a.say({ t: 'ping', n: t }); // mantém viva (inatividade de 60 s)
      await tick(5);
    }
    expect(await a.next('erro')).toEqual({ t: 'erro', motivo: 'sala venceu sem o segundo aparelho' });
    expect(h.server.rooms.active).toBe(0);
    const b = await openRelay(h.port);
    b.say({ t: 'entrar', codigo: code });
    expect(await b.next('erro')).toEqual({ t: 'erro', motivo: 'código inválido ou vencido' });
  });

  it('quando um sai, o outro recebe "saiu", a sala acaba e ele pode criar outra', async () => {
    h = await harness();
    const { a, b } = await pair(h);
    a.ws.close();
    await a.closed;
    expect(await b.next('saiu')).toEqual({ t: 'saiu' });
    expect(h.server.rooms.active).toBe(0);
    b.say({ t: 'criar' });
    expect((await b.next('sala')).codigo).toHaveLength(CODE_LEN);
  });

  it('limites valem por aparelho: A manda 65 bytes → só A cai com 4002; B é avisado', async () => {
    h = await harness();
    const { a, b } = await pair(h);
    a.ws.send(Buffer.alloc(65));
    expect(await a.closed).toEqual({ code: 4002, reason: 'mensagem grande demais' });
    expect(await b.next('saiu')).toEqual({ t: 'saiu' });
    expect(b.ws.readyState).toBe(1);
  });

  it('texto inválido → erro, conexão continua', async () => {
    h = await harness();
    const a = await openRelay(h.port);
    a.ws.send('{oops');
    expect(await a.next('erro')).toEqual({ t: 'erro', motivo: 'mensagem inválida' });
    a.ws.send('{"t":"voar"}');
    await waitFor(() => a.ctl.length === 2);
    expect(a.ws.readyState).toBe(1);
  });

  it('bilhete de relay na rota de eco (e vice-versa) → 403, e o bilhete NÃO é gasto', async () => {
    h = await harness();
    const r = await admit(h.port, 60, 'relay');
    expect((await connect(h.port, r.body.bilhete, undefined, '/net/ws/echo')).kind).toBe('http');
    const ok = await connect(h.port, r.body.bilhete, undefined, '/net/ws/relay');
    expect(ok.kind).toBe('open');
    const e = await admit(h.port, 60, 'echo');
    const bad = await connect(h.port, e.body.bilhete, undefined, '/net/ws/relay');
    expect(bad).toEqual({ kind: 'http', status: 403 });
  });

  it('o código da sala nunca vai para o log nem para o health', async () => {
    h = await harness();
    const { a, b, code } = await pair(h);
    a.say({ t: 'pronto', rtt: 1 });
    b.say({ t: 'pronto', rtt: 1 });
    await a.next('comecar');
    a.ws.close();
    await b.next('saiu');
    const all = h.logs.join('\n');
    expect(all).not.toContain(code);
    for (const ev of ['sala_criada', 'sala_completa', 'sala_largada', 'sala_encerrada']) expect(all).toContain(ev);
    const health = await (await fetch(`http://127.0.0.1:${h.port}/net/health`)).text();
    expect(health).not.toContain(code);
  });

  it('normalizeCode: maiúsculas, sem hífen/espaço; recusa símbolos fora do alfabeto e tamanho errado', () => {
    expect(normalizeCode('k7q-4md')).toBe('K7Q4MD');
    expect(normalizeCode(' K7Q 4MD ')).toBe('K7Q4MD');
    expect(normalizeCode('K7Q4M0')).toBeNull(); // 0 não existe no alfabeto
    expect(normalizeCode('K7Q4M')).toBeNull();
    expect(normalizeCode(123456)).toBeNull();
  });
});
