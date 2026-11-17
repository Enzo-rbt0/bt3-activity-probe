// T5 bilhete (recusas HTTP antes do upgrade), T7 limites do eco (4002 só depois do upgrade),
// T8 prazo, inatividade, janela e varredura (4001 só depois do upgrade).
import { afterEach, describe, expect, it } from 'vitest';
import { admit, connect, harness, openSession, tick, waitFor, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('T5 — bilhete: recusa é HTTP antes do upgrade', () => {
  it('bilhete válido abre; reutilizado → HTTP 403 (não há WebSocket, logo não há 4001/4002)', async () => {
    h = await harness();
    const s = await openSession(h.port);
    expect(s.ws.readyState).toBe(1);
    expect(await connect(h.port, s.ticket)).toEqual({ kind: 'http', status: 403 });
    s.ws.close();
  });

  it('dois upgrades simultâneos com o mesmo bilhete → um abre, o outro recebe HTTP 403', async () => {
    h = await harness();
    const r = await admit(h.port);
    const [a, b] = await Promise.all([connect(h.port, r.body.bilhete), connect(h.port, r.body.bilhete)]);
    const kinds = [a, b].map((x) => (x.kind === 'open' ? 'open' : x.status)).sort();
    expect(kinds).toEqual([403, 'open']);
    for (const x of [a, b]) if (x.kind === 'open') x.ws.close();
  });

  it('bilhete vencido (30 s), inexistente ou malformado → HTTP 403', async () => {
    h = await harness();
    const r = await admit(h.port);
    h.clock.advance(30_000);
    expect(await connect(h.port, r.body.bilhete)).toEqual({ kind: 'http', status: 403 });
    expect(await connect(h.port, '0'.repeat(32))).toEqual({ kind: 'http', status: 403 });
    expect(await connect(h.port, 'nao-hex')).toEqual({ kind: 'http', status: 403 });
    expect(await connect(h.port, '')).toEqual({ kind: 'http', status: 403 });
  });

  it('Origin fora da lista no upgrade → HTTP 403, e o bilhete continua sem uso', async () => {
    h = await harness();
    const r = await admit(h.port);
    expect(await connect(h.port, r.body.bilhete, 'https://evil.example')).toEqual({ kind: 'http', status: 403 });
    const ok = await connect(h.port, r.body.bilhete);
    expect(ok.kind).toBe('open');
    if (ok.kind === 'open') ok.ws.close();
  });

  it('janela fechada no upgrade → HTTP 503', async () => {
    h = await harness();
    const r = await admit(h.port);
    h.windowText.value = null;
    h.server.window.reload();
    expect(await connect(h.port, r.body.bilhete)).toEqual({ kind: 'http', status: 503 });
  });

  it('prazo da sessão nunca passa do fim da janela', async () => {
    h = await harness({ open: false });
    h.open(20_000); // janela de 20 s
    const s = await openSession(h.port, 180);
    const row = h.db.raw.prepare('SELECT deadline FROM sessions').get() as { deadline: number };
    expect(row.deadline).toBe(h.clock.now() + 20_000); // mín(janela, agora + 180 s)
    h.clock.advance(20_000);
    expect((await s.closed).code).toBe(4001);
  });
});

describe('T7 — limites do eco (fechamento 4002, conexão já estabelecida)', () => {
  it('eco devolve exatamente o que chegou e não toca o SQLite por mensagem', async () => {
    h = await harness();
    const s = await openSession(h.port, 180);
    const before = h.db.accesses;
    for (let i = 0; i < 100; i++) s.ws.send(`m${i}`);
    await waitFor(() => s.messages.length === 100);
    expect(s.messages[42]!.toString()).toBe('m42');
    expect(h.db.accesses).toBe(before);
    s.ws.close();
  });

  it('mensagem de 65 bytes → 4002; 64 bytes passa', async () => {
    h = await harness();
    const s = await openSession(h.port);
    s.ws.send('x'.repeat(64));
    await waitFor(() => s.messages.length === 1);
    s.ws.send('x'.repeat(65));
    expect(await s.closed).toEqual({ code: 4002, reason: 'mensagem grande demais' });
  });

  it('acima de 1024 bytes o próprio ws corta (1009), antes da aplicação', async () => {
    h = await harness();
    const s = await openSession(h.port);
    s.ws.send('x'.repeat(2000));
    expect((await s.closed).code).toBe(1009);
    await waitFor(() => h!.server.conns.size === 0);
  });

  it('rajada: 360 mensagens no mesmo instante passam, a 361ª → 4002', async () => {
    h = await harness();
    const s = await openSession(h.port, 180);
    for (let i = 0; i < 361; i++) s.ws.send('r');
    expect(await s.closed).toEqual({ code: 4002, reason: 'taxa acima do limite' });
    expect(s.messages.length).toBe(360);
  });

  it('taxa média: com o balde vazio, repõe 120 por segundo (nem mais, nem menos)', async () => {
    h = await harness();
    const s = await openSession(h.port, 180);
    for (let i = 0; i < 360; i++) s.ws.send('r');
    await waitFor(() => s.messages.length === 360);
    h.clock.advance(1000);
    for (let i = 0; i < 120; i++) s.ws.send('r');
    await waitFor(() => s.messages.length === 480);
    s.ws.send('r'); // balde vazio de novo, sem tempo passar
    expect(await s.closed).toEqual({ code: 4002, reason: 'taxa acima do limite' });
    expect(s.messages.length).toBe(480);
  });

  it('achado da F3b: 60/s com engasgo de rede de 5,5 s (330 represadas chegam juntas) NÃO derruba; 6,5 s (390) derruba', async () => {
    const run = async (stallMs: number) => {
      h = await harness();
      const s = await openSession(h.port, 180);
      // 2 s normais a 60 Hz
      for (let t = 0; t < 120; t++) {
        s.ws.send('r');
        await waitFor(() => s.messages.length === t + 1);
        h.clock.advance(1000 / 60);
      }
      // engasgo: nada chega ao servidor; depois, tudo o que o cliente mandou chega junto
      h.clock.advance(stallMs);
      const n = Math.round((stallMs / 1000) * 60);
      for (let i = 0; i < n; i++) s.ws.send('r');
      const r = await Promise.race([s.closed, waitFor(() => s.messages.length === 120 + n, 5000).then(() => 'ok' as const)]);
      await h.close();
      h = null;
      return r;
    };
    expect(await run(5500)).toBe('ok');
    expect(await run(6500)).toEqual({ code: 4002, reason: 'taxa acima do limite' });
  });

  it('cota reservada esgotada → 4002', async () => {
    h = await harness({ limits: { targetHz: 1, margin: 1 } });
    const s = await openSession(h.port, 5); // reserva 5
    for (let i = 0; i < 6; i++) s.ws.send('q');
    expect(await s.closed).toEqual({ code: 4002, reason: 'cota da sessão esgotada' });
    expect(s.messages.length).toBe(5);
    expect(h.server.budget.stats(h.clock.now()).reserved_msgs).toBe(5);
  });
});

describe('T8 — prazo, inatividade, janela e varredura (fechamento 4001)', () => {
  it('fim da duração → 4001 "prazo da sessão"', async () => {
    h = await harness();
    const s = await openSession(h.port, 10);
    h.clock.advance(9_999);
    await tick();
    expect(s.ws.readyState).toBe(1);
    h.clock.advance(1);
    expect(await s.closed).toEqual({ code: 4001, reason: 'prazo da sessão' });
  });

  it('60 s sem mensagem → 4001 "inatividade"; mensagens adiam', async () => {
    h = await harness();
    const s = await openSession(h.port, 180);
    h.clock.advance(59_000);
    s.ws.send('vivo');
    await waitFor(() => s.messages.length === 1);
    h.clock.advance(59_000);
    await tick();
    expect(s.ws.readyState).toBe(1);
    h.clock.advance(1_000);
    expect(await s.closed).toEqual({ code: 4001, reason: 'inatividade' });
  });

  it('janela fechada no meio da sessão → 4001 "janela encerrada" em até 5 s', async () => {
    h = await harness();
    const s = await openSession(h.port, 180);
    h.windowText.value = null; // operador fechou
    h.clock.advance(5_000);
    expect(await s.closed).toEqual({ code: 4001, reason: 'janela encerrada' });
  });

  it('mensagem que chega depois do prazo não é respondida', async () => {
    h = await harness();
    const s = await openSession(h.port, 10);
    for (const c of h.server.conns) c.disableOwnTimerForTests();
    // Avança o relógio sem disparar a varredura (manipula o tempo por fora dos timers).
    (h.clock as unknown as { t: number }).t += 10_000;
    s.ws.send('tarde');
    expect(await s.closed).toEqual({ code: 4001, reason: 'prazo da sessão' });
    expect(s.messages.length).toBe(0);
  });

  it('varredura de 1 s fecha mesmo com o timer próprio da conexão desligado', async () => {
    h = await harness();
    const s = await openSession(h.port, 10);
    for (const c of h.server.conns) c.disableOwnTimerForTests();
    h.clock.advance(10_000); // só a varredura dispara
    expect((await s.closed).code).toBe(4001);
  });

  it('sem varredura e sem timer próprio a conexão NÃO fecharia (controle do teste anterior)', async () => {
    h = await harness();
    const s = await openSession(h.port, 10);
    for (const c of h.server.conns) c.disableOwnTimerForTests();
    (h.clock as unknown as { t: number }).t += 20_000;
    await tick(50);
    expect(s.ws.readyState).toBe(1);
    h.server.sweep();
    expect((await s.closed).code).toBe(4001);
  });
});
