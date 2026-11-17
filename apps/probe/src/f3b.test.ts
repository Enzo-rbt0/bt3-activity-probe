// F3b: N-ECHO (eco contínuo de 60 s a 60 Hz) com relógio falso e servidor de eco simulado.
import { describe, expect, it } from 'vitest';
import { dEstimate, decodeMsg, ECHO_CONFIG, EchoTest, encodeMsg, histogram, percentile, reservedFor, sessionSeconds, variation, type EchoConfig } from './tests/c-echo';
import { echoServer, FakeClock, type EchoServerOpts } from './test-helpers/echo-fakes';
import { fakeFetch, HEALTH, res, server, TICKET, type Handler } from './test-helpers/net-fakes';

const BASES = { httpBase: 'https://1571332639812493522.discordsays.com', wsBase: 'wss://1571332639812493522.discordsays.com' };

function setup(o: EchoServerOpts = {}, h: Handler = server(), cfg: Partial<EchoConfig> = {}) {
  const clock = new FakeClock();
  const WS = echoServer(clock, o);
  const fetch = fakeFetch(h);
  const test = new EchoTest({ fetch, now: clock.now, timeoutMs: 5000, WebSocket: WS, timers: clock }, cfg);
  const run = async () => {
    const p = test.run(BASES, 'relativo');
    await clock.runUntil(p);
    await p;
    return test.result();
  };
  return { clock, WS, fetch, test, run };
}

const bodies = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.url.endsWith('/net/session')).map((c) => JSON.parse(c.body ?? '{}'));

describe('N-ECHO · protocolo e contas', () => {
  it('mensagem de 16 bytes: sequência + instante; ida e volta exata; formato errado é recusado', () => {
    const b = encodeMsg(4_000_000_000, 12345.678);
    expect(b.byteLength).toBe(16);
    expect(decodeMsg(b)).toEqual({ seq: 4_000_000_000, t: 12345.678 });
    expect(decodeMsg(new Uint8Array(b))).toEqual({ seq: 4_000_000_000, t: 12345.678 }); // Buffer do Node
    expect(decodeMsg(new ArrayBuffer(15))).toBeNull();
    const bad = new Uint8Array(b.slice(0));
    bad[15] = 1;
    expect(decodeMsg(bad.buffer)).toBeNull();
    expect(decodeMsg('texto')).toBeNull();
  });

  it('percentil nearest-rank, histograma de 10 ms (teto 1000+), variação e D', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(v, 50), percentile(v, 95), percentile(v, 99), percentile(v, 100)]).toEqual([50, 95, 99, 100]);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(histogram([0, 9.9, 10, 205, 999, 1000, 5000])).toEqual([[0, 2], [10, 1], [200, 1], [990, 1], [1000, 2]]);
    expect(variation([100, 110, 100, 100])).toEqual({ mean_ms: 6.7, std_ms: 4.7 });
    expect(variation([100])).toEqual({ mean_ms: null, std_ms: null });
    expect(dEstimate(200)).toBe(7); // ⌈100 / 16,67⌉ + 1
    expect(dEstimate(null)).toBeNull();
  });

  it('sessão pedida: 62 s de envio + 3 s de folga = 65 s → reserva de 4.290 mensagens', () => {
    expect(sessionSeconds(ECHO_CONFIG.warmupMs + ECHO_CONFIG.measureMs)).toBe(65);
    expect(reservedFor(65)).toBe(4290);
    expect(reservedFor(65) * 14).toBeLessThanOrEqual(300_000);
  });
});

describe('N-ECHO · medição', () => {
  it('servidor estável a 100 ms: AP, 60 Hz exatos, nada pulado, 1 admissão de 65 s; bilhete fora do resultado', async () => {
    const { run, fetch, WS } = setup({ latency: () => 100 });
    const r = await run();
    expect(r.status).toBe('AP');
    expect(r.sent).toBeGreaterThanOrEqual(3599);
    expect(r.sent).toBeLessThanOrEqual(3601);
    expect(r.received).toBe(r.sent);
    expect(r.no_echo).toBe(0);
    expect(r.echo_ratio).toBe(1);
    expect(r.warmup.sent).toBe(120);
    expect(r.rtt).toEqual({ p50: 100, p95: 100, p99: 100, max: 100, mean: 100 });
    expect(r.variation).toEqual({ mean_ms: 0, std_ms: 0 });
    expect(r.histogram).toEqual([[100, r.received]]);
    expect(r.cadence.skipped).toBe(0);
    expect(r.cadence.late_over_5ms).toBe(0);
    expect(r.cadence.rate_hz).toBeCloseTo(60, 0);
    expect(r.cadence.interval_mean_ms).toBeCloseTo(16.7, 1);
    expect(r.measured_ms).toBe(60_000);
    expect(r.d_estimate_frames).toBe(4);
    expect(r.connection).toMatchObject({ admissions: 1, admit_statuses: [201], reconnects: 0, completed: true, close_codes: [] });
    expect(r.config).toEqual({ hz: 60, msg_bytes: 16, warmup_s: 2, measure_s: 60, session_s: 65 });
    expect(bodies(fetch)).toEqual([{ kind: 'echo', duration_s: 65 }]);
    expect(WS.urls).toEqual([`${BASES.wsBase}/net/ws/echo?bilhete=${TICKET}`]);
    expect(WS.clientCloses).toEqual([1000]);
    expect(JSON.stringify(r)).not.toContain(TICKET);
    expect(r.detail).toContain('p50 100');
  });

  it('latência variável: percentis, piores 20 (com instante) e atrasos > 50/100/250 ms', async () => {
    const { run } = setup({ latency: (seq) => (seq % 100 === 0 ? 300 : seq % 10 === 0 ? 120 : 80) });
    const r = await run();
    expect(r.rtt.p50).toBe(80);
    expect(r.rtt.max).toBe(300);
    expect(r.delays.over_250ms).toBe(36);
    expect(r.delays.over_100ms).toBe(360);
    expect(r.delays.over_50ms).toBe(r.received);
    expect(r.worst).toHaveLength(20);
    expect(r.worst.every((w) => w.rtt_ms === 300 && w.t_ms >= 2000)).toBe(true);
    expect(r.variation.mean_ms).toBeGreaterThan(0);
  });

  it('thread travada 210 ms: os envios perdidos são "pulados", SEM rajada (nunca 3 envios em 16,7 ms)', async () => {
    const { clock, run, WS } = setup({ latency: () => 100 });
    clock.stallAt(1000 + 10_000, 210);
    const r = await run();
    expect(r.cadence.skipped).toBeGreaterThanOrEqual(11);
    expect(r.cadence.late_over_5ms).toBeGreaterThanOrEqual(1);
    const s = WS.sends;
    for (let i = 2; i < s.length; i++) expect(s[i]! - s[i - 2]!).toBeGreaterThan(16.6);
    expect(r.cadence.interval_p99_ms).toBeLessThan(20);
    expect(r.status).toBe('AP');
  });

  it('2% sem eco → INV (95–99%); 10% sem eco → RP', async () => {
    const a = await setup({ drop: (seq) => seq % 50 === 7 }).run();
    expect(a.echo_ratio).toBeCloseTo(0.98, 2);
    expect(a.no_echo).toBe(a.sent - a.received);
    expect(a.status).toBe('INV');
    const b = await setup({ drop: (seq) => seq % 10 === 3 }).run();
    expect(b.status).toBe('RP');
    expect(b.detail).toContain('abaixo de 95%');
  });

  it('página escondida no meio → INV com o instante; perda de foco é só contada', async () => {
    const { clock, test, run } = setup();
    clock.set(() => {
      test.noteBlur();
      test.noteHidden();
    }, 30_000);
    const r = await run();
    expect(r.status).toBe('INV');
    expect(r.connection.hidden_during).toBe(true);
    expect(r.connection.hidden_at_ms).toBeGreaterThan(28_000);
    expect(r.connection.focus_lost).toBe(1);
  });

  it('queda aos 20 s → reconecta em 1 s com bilhete NOVO e só o tempo que falta; completa → INV', async () => {
    const { run, fetch, WS } = setup({ closeAfter: [{ conn: 0, afterMs: 20_000, code: 1006 }] });
    const r = await run();
    expect(r.connection.reconnects).toBe(1);
    expect(r.connection.close_codes).toEqual([1006]);
    expect(r.connection.reconnect_ms[0]).toBeGreaterThanOrEqual(1050);
    expect(r.connection.reconnect_ms[0]).toBeLessThan(1200);
    expect(r.connection.completed).toBe(true);
    expect(r.status).toBe('INV');
    expect(r.detail).toContain('reconexão');
    const b = bodies(fetch);
    expect(b).toHaveLength(2);
    expect(b[1].duration_s).toBeLessThan(65);
    expect(b[1].duration_s).toBeGreaterThanOrEqual(43);
    expect(WS.urls).toHaveLength(2);
    expect(r.no_echo).toBeGreaterThan(0); // os pendentes na queda
    expect(r.measured_ms).toBe(60_000);
  });

  it('quedas seguidas: no máximo 3 reconexões (1, 2 e 4 s); não completa → RP', async () => {
    const closeAfter = [0, 1, 2, 3].map((conn) => ({ conn, afterMs: 3000, code: 1006 }));
    const { run, fetch } = setup({ closeAfter });
    const r = await run();
    expect(r.connection.reconnects).toBe(3);
    expect(bodies(fetch)).toHaveLength(4);
    expect(r.connection.completed).toBe(false);
    expect(r.status).toBe('RP');
  });

  it('servidor fecha com 4002 (limite) → RP, sem reconectar', async () => {
    const { run, fetch } = setup({ closeAfter: [{ conn: 0, afterMs: 5000, code: 4002 }] });
    const r = await run();
    expect(r.status).toBe('RP');
    expect(r.connection.failed_stage).toBe('limite');
    expect(bodies(fetch)).toHaveLength(1);
  });

  it('parar no meio → INV "interrompido", fecha com 1000', async () => {
    const { clock, test, run, WS } = setup();
    clock.set(() => test.stop(), 10_000);
    const r = await run();
    expect(r.status).toBe('INV');
    expect(r.connection.stopped_by_user).toBe(true);
    expect(r.detail).toContain('Interrompido');
    expect(WS.clientCloses).toEqual([1000]);
    expect(r.measured_ms).toBeLessThan(10_000);
  });
});

describe('N-ECHO · antes de medir', () => {
  it('antes de rodar: SKIP', () => {
    expect(setup().test.result()).toMatchObject({ status: 'SKIP', ran: false });
  });

  it('rede fechada no servidor → INV, nenhuma admissão', async () => {
    const { run, fetch } = setup({}, server({ health: res(200, HEALTH(false)) }));
    const r = await run();
    expect(r).toMatchObject({ status: 'INV', window_open: false });
    expect(bodies(fetch)).toHaveLength(0);
  });

  it('servidor inacessível → RP', async () => {
    const { run } = setup({}, server({ health: 'falha' }));
    expect((await run()).status).toBe('RP');
  });

  it('admissão 429 (limite do dia) → INV; 403 (origem) → RP; nenhuma tentativa extra', async () => {
    const a = setup({}, server({ session: res(429, '{"erro":"limite"}') }));
    const ra = await a.run();
    expect(ra.status).toBe('INV');
    expect(bodies(a.fetch)).toHaveLength(1);
    const b = setup({}, server({ session: res(403, '{"erro":"origem"}') }));
    const rb = await b.run();
    expect(rb.status).toBe('RP');
    expect(rb.detail).toContain('origem');
  });

  it('WebSocket recusado no upgrade → RP na etapa "upgrade"', async () => {
    const r = await setup({ refuse: true }).run();
    expect(r).toMatchObject({ status: 'RP' });
    expect(r.connection.failed_stage).toBe('upgrade');
  });

  it('rótulo do par: aparado e limitado a 40 caracteres', () => {
    const { test } = setup();
    test.setPairLabel(`  PC-1 ${'x'.repeat(60)}`);
    expect(test.result().pair_label).toHaveLength(40);
  });

  it('wake lock: registra ativo, negado ou indisponível', async () => {
    const clock = new FakeClock();
    const mk = (wakeLock?: () => Promise<{ release(): Promise<void> } | null>) =>
      new EchoTest({ fetch: fakeFetch(server()), now: clock.now, timeoutMs: 5000, WebSocket: echoServer(clock), timers: clock, wakeLock }, { measureMs: 1000, warmupMs: 0 });
    const ok = mk(async () => ({ release: async () => undefined }));
    let p = ok.run(BASES, 'relativo');
    await clock.runUntil(p);
    expect(ok.result().connection.wake_lock).toBe('ativo');
    const no = mk(async () => {
      throw new Error('NotAllowedError');
    });
    p = no.run(BASES, 'relativo');
    await clock.runUntil(p);
    expect(no.result().connection.wake_lock).toBe('negado');
    const none = mk();
    p = none.run(BASES, 'relativo');
    await clock.runUntil(p);
    expect(none.result().connection.wake_lock).toBe('indisponivel');
  });
});
