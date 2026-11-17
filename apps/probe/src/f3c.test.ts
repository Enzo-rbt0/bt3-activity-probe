// F3c: N-RELAY (dois aparelhos numa sala do servidor) com relógio falso e servidor de relay simulado.
import { describe, expect, it } from 'vitest';
import { dCurve, dMinWithin, formatCode, framesToMs, joinWindowMs, normalizeCode, RELAY_CONFIG, relayFrames, relayReserve } from './tests/c-relay';
import { relayPair, ROOM_CODE } from './test-helpers/relay-fakes';
import { TICKET } from './test-helpers/net-fakes';

const bodies = (f: { calls: { url: string; body: string | null }[] }) => f.calls.filter((c) => c.url.endsWith('/net/session')).map((c) => c.body);

describe('N-RELAY · contas e código', () => {
  it('código: aceita minúsculas, hífen e espaço; recusa 0/O/1/I e tamanho errado; mostra com hífen', () => {
    expect(normalizeCode('k7q-4md')).toBe('K7Q4MD');
    expect(normalizeCode(' K7Q 4MD ')).toBe('K7Q4MD');
    expect(normalizeCode('K7Q4M0')).toBeNull();
    expect(normalizeCode('K7Q4MI')).toBeNull();
    expect(normalizeCode('K7Q4M')).toBeNull();
    expect(formatCode('K7Q4MD')).toBe('K7Q-4MD');
  });

  it('sessão de 180 s (reserva de 11.880 por aparelho); 3.720 quadros; o outro tem 90 s para entrar; 18 admissões cabem no dia', () => {
    expect(relayReserve()).toBe(11_880);
    expect(relayFrames()).toBe(3720);
    expect(joinWindowMs()).toBe(90_000);
    expect(relayReserve() * 18).toBeLessThanOrEqual(300_000);
  });

  it('curva D × travadas: atrasados além de D quadros + os que não chegaram; menor D com ≤ 1% e ≤ 0,1%', () => {
    const lat = [...Array(990).fill(95), ...Array(9).fill(395)]; // 1 não chegou
    const c = dCurve(lat, 1000, 60, 30);
    expect(c).toHaveLength(30);
    expect(c[0]).toBe(100); // D=1 (16,7 ms): tudo atrasado
    expect(c[5]).toBe(1); // D=6 (100 ms): 9 atrasados + 1 que não chegou = 1%
    expect(c[22]).toBe(1); // D=23 (383 ms)
    expect(c[23]).toBe(0.1); // D=24 (400 ms): só o que não chegou
    expect(dMinWithin(c, 1)).toBe(6);
    expect(dMinWithin(c, 0.1)).toBe(24);
    expect(dMinWithin(dCurve([500], 2, 60, 30), 1)).toBeNull();
    expect(framesToMs(6)).toBe(100);
  });
});

describe('N-RELAY · medição entre dois aparelhos', () => {
  it('A (RTT 50) × B (RTT 140): os dois AP; atraso bruto = RTT do outro, corrigido = 95 ms dos dois lados; D = 6', async () => {
    const { run, fetchA, fetchB, WS } = relayPair({ links: [{ up: 25, down: 25 }, { up: 70, down: 70 }] });
    const { a, b } = await run();
    expect(a.status).toBe('AP');
    expect(b.status).toBe('AP');
    expect([a.role, b.role]).toEqual(['criou', 'entrou']);
    expect([a.rtt_self_ms, a.rtt_peer_ms, b.rtt_self_ms, b.rtt_peer_ms]).toEqual([50, 140, 140, 50]);
    expect(a.lateness_raw.p50).toBe(140);
    expect(b.lateness_raw.p50).toBe(50);
    expect([a.lateness.p50, a.lateness.max, b.lateness.p50, b.lateness.max]).toEqual([95, 95, 95, 95]);
    expect(a.uncertainty_ms).toBe(95);
    expect([a.expected, a.received, a.missing, a.received_ratio]).toEqual([3600, 3600, 0, 1]);
    expect([a.sent, a.skipped, a.warmup.sent, a.warmup.received]).toEqual([3600, 0, 120, 120]);
    expect(a.cadence.rate_hz).toBe(60);
    expect([a.d_min_1pct, a.d_min_01pct, b.d_min_1pct, b.d_min_01pct]).toEqual([6, 6, 6, 6]);
    expect(a.curve_basis).toBe('corrigido');
    expect(a.d_curve).toHaveLength(30);
    expect([a.rtt_before.answered, a.rtt_after.answered]).toEqual([20, 20]);
    expect(a.connection.completed && b.connection.completed).toBe(true);
    expect(a.connection.peer_left).toBe(false);
    expect(a.connection.wait_partner_ms).toBeGreaterThanOrEqual(3000);
    expect(a.detail).toContain('D com ≤ 1% de travadas: 6 (100 ms)');
    expect(a.detail).toContain('Jogável (proposta): D = 6 quadros (100 ms)');
    // Admissão do tipo certo, rota do relay, e nem o código nem o bilhete no resultado.
    expect(bodies(fetchA)).toEqual(['{"kind":"relay","duration_s":180}']);
    expect(bodies(fetchB)).toEqual(['{"kind":"relay","duration_s":180}']);
    expect(WS.urls.every((u) => u.includes('/net/ws/relay?bilhete='))).toBe(true);
    expect(WS.texts).toContain(JSON.stringify({ t: 'entrar', codigo: ROOM_CODE }));
    for (const r of [a, b]) {
      const j = JSON.stringify(r);
      expect(j).not.toContain(ROOM_CODE);
      expect(j).not.toContain('K7Q-4MD');
      expect(j).not.toContain(TICKET);
    }
    expect(WS.clientCloses).toEqual([1000, 1000]);
  });

  it('1% dos quadros de B chega 300 ms mais tarde: em A, ≤ 1% com D = 6, mas ≤ 0,1% só com D = 24', async () => {
    const { run } = relayPair({ links: [{ up: 25, down: 25 }, { up: 70, down: 70 }], frameDelay: (from, seq) => (from === 1 && seq % 100 === 0 ? 300 : 0) });
    const { a, b } = await run();
    expect(a.status).toBe('AP');
    expect([a.d_min_1pct, a.d_min_01pct]).toEqual([6, 24]);
    expect(a.lateness.max).toBe(395);
    expect(a.worst[0]!.lateness_ms).toBe(395);
    expect(a.worst).toHaveLength(20);
    expect([b.d_min_1pct, b.d_min_01pct]).toEqual([6, 6]);
  });

  it('4% dos quadros de B nunca chegam: A fica INV (96%), e nenhum D chega a ≤ 1% (contam como travadas)', async () => {
    const { run } = relayPair({ drop: (from, seq) => from === 1 && seq % 25 === 0 });
    const { a, b } = await run();
    expect([a.expected, a.received, a.missing]).toEqual([3600, 3456, 144]);
    expect(a.status).toBe('INV');
    expect(a.d_min_1pct).toBeNull();
    expect(a.detail).toContain('> 30');
    expect(b.status).toBe('AP');
  });

  it('o servidor derruba B aos 20 s de medição: B RP (conexão caiu); A INV (o outro saiu), com o que mediu até ali', async () => {
    const { run } = relayPair({ closeAfter: [{ conn: 1, afterMs: 30_000, code: 1006 }] });
    const { a, b } = await run();
    expect(b.status).toBe('RP');
    expect(b.connection.failed_stage).toBe('conexao');
    expect(a.status).toBe('INV');
    expect(a.connection.peer_left).toBe(true);
    expect(a.connection.peer_left_at_ms).toBeGreaterThan(15_000);
    expect(a.expected).toBeGreaterThan(1000);
    expect(a.expected).toBeLessThan(3600);
    expect(a.missing).toBeLessThanOrEqual(1);
  });

  it('4002 por taxa em A: RP com o motivo; B fica INV porque A saiu', async () => {
    const { run } = relayPair({ closeAfter: [{ conn: 0, afterMs: 30_000, code: 4002, reason: 'taxa acima do limite' }] });
    const { a, b } = await run();
    expect(a.status).toBe('RP');
    expect(a.connection.failed_stage).toBe('limite');
    expect(a.detail).toContain('o servidor fechou por taxa (4002)');
    expect(b.connection.peer_left).toBe(true);
    expect(b.status).toBe('INV');
  });
});

describe('N-RELAY · sala e recusas', () => {
  it('ninguém entra: A espera 90 s (mantendo a conexão viva), fecha com 1000 e fica INV', async () => {
    const { run, WS } = relayPair({}, { joinAtMs: null });
    const { a } = await run();
    expect(a.status).toBe('INV');
    expect(a.connection.failed_stage).toBe('par');
    expect(a.detail).toContain('ninguém entrou na sala em 90 s');
    expect(WS.texts.filter((t) => t.includes('"ping"')).length).toBeGreaterThanOrEqual(8); // a cada 10 s
    expect(WS.clientCloses).toEqual([1000]);
  });

  it('código digitado errado (com 0): INV na hora, sem gastar admissão', async () => {
    const { run, fetchB } = relayPair({}, { joinCode: 'K7Q-4M0' });
    const { b } = await run();
    expect(b.status).toBe('INV');
    expect(b.connection.failed_stage).toBe('codigo');
    expect(fetchB.calls).toHaveLength(0);
    expect(b.detail).toContain('Nada foi gasto');
  }, 30_000);

  it('código válido mas de outra sala: o servidor recusa → INV "Sala: código inválido ou vencido"', async () => {
    const { run } = relayPair({}, { joinCode: 'ABCDEF', cfg: { roomWaitMs: 10_000 } });
    const { a, b } = await run();
    expect(b.status).toBe('INV');
    expect(b.detail).toContain('Sala: código inválido ou vencido');
    expect(a.connection.failed_stage).toBe('par');
  });

  it('sala cheia ou outra recusa do servidor chega como INV com o motivo dele', async () => {
    const { run } = relayPair({ joinError: 'sala cheia' }, { cfg: { roomWaitMs: 10_000 } });
    const { b } = await run();
    expect(b.status).toBe('INV');
    expect(b.detail).toContain('sala cheia');
  });

  it('"Parar" enquanto espera o outro: INV "Interrompido antes da medição"', async () => {
    const { run, clock, A } = relayPair({}, { joinAtMs: null });
    clock.set(() => A.stop(), 20_000);
    const { a } = await run();
    expect(a.status).toBe('INV');
    expect(a.detail).toContain('Interrompido antes da medição');
  });

  it('página escondida durante a medição → INV', async () => {
    const { run, clock, A } = relayPair();
    clock.set(() => A.noteHidden(), 40_000);
    const { a } = await run();
    expect(a.status).toBe('INV');
    expect(a.connection.hidden_during).toBe(true);
  });

  it('travada de 1 s: os quadros atrasados saem juntos (não são pulados); travada de 4 s: no máximo 120 de uma vez', async () => {
    const one = relayPair();
    one.clock.stallAt(30_000, 1000);
    const r1 = await one.run();
    expect(r1.a.skipped).toBe(0);
    expect(r1.a.cadence.late_over_5ms).toBeGreaterThanOrEqual(55);
    expect(r1.a.sent).toBe(3600);
    const four = relayPair();
    four.clock.stallAt(30_000, 4000);
    const r4 = await four.run();
    expect(r4.a.skipped).toBeGreaterThan(100);
    expect(r4.a.skipped).toBeLessThan(140);
    expect(r4.a.sent + r4.a.skipped).toBe(3600);
  });

  it('configuração padrão: 2 s + 60 s a 60 Hz, 20 pings', () => {
    expect([RELAY_CONFIG.hz, RELAY_CONFIG.warmupMs, RELAY_CONFIG.measureMs, RELAY_CONFIG.pings, RELAY_CONFIG.maxBacklog]).toEqual([60, 2000, 60_000, 20, 120]);
  });
});
