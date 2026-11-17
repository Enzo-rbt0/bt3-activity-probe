import { describe, expect, it } from 'vitest';
import { discordClient, readUrlHints, storageContext } from './env';
import { clip, shortHash } from './hash';
import { buildReport, reportFileName, type BuildInput } from './report/build';
import { validateReport } from './report/validate';
import { classifyEnv, type SdkOutcome } from './tests/a-env';
import { KeyTest, PadTest, TouchTest } from './tests/b-input';
import { AudioTest, FileBasicTest, FileLargeTest, FsTest } from './tests/b-media';
import { classifyGl2, gpuAcceleration, isSoftwareRenderer } from './tests/a-gl2';
import type { Gl2Result, Tests } from './report/types';
import { FEATURE_KEYS } from './report/types';
import { httpResult, pathResult, runPathChecks, WsOpenTest } from './tests/c-net';
import { EchoTest } from './tests/c-echo';
import { echoServer, FakeClock } from './test-helpers/echo-fakes';
import { fakeFetch, fakeWs, HEALTH, now, PAGE, res, server, T, TICKET } from './test-helpers/net-fakes';

const DISCORD_QS = '?frame_id=f1&instance_id=i-123&platform=desktop&guild_id=999&channel_id=888';

describe('readUrlHints (só detecção, nunca identidade)', () => {
  it('com os 3 parâmetros e plataforma válida, é candidato a Discord', () => {
    expect(readUrlHints(DISCORD_QS)).toEqual({ mode: 'discord', platform: 'desktop', mobileAppVersion: null });
    expect(readUrlHints('?frame_id=a&instance_id=b&platform=mobile&mobile_app_version=250.3').mobileAppVersion).toBe('250.3');
  });
  it.each([
    ['', 'sem parâmetros'],
    ['?instance_id=b&platform=desktop', 'sem frame_id'],
    ['?frame_id=a&platform=desktop', 'sem instance_id'],
    ['?frame_id=a&instance_id=b', 'sem platform'],
    ['?frame_id=a&instance_id=b&platform=tv', 'plataforma desconhecida'],
    ['?frame_id=%20&instance_id=b&platform=desktop', 'frame_id em branco'],
  ])('%s → standalone (%s)', (qs) => {
    expect(readUrlHints(qs)).toEqual({ mode: 'standalone', platform: null, mobileAppVersion: null });
  });
});

describe('hash e corte', () => {
  it('hash tem 12 hex, é estável e não contém o valor original', async () => {
    const h = await shortHash('i-123');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(await shortHash('i-123')).toBe(h);
    expect(await shortHash('i-124')).not.toBe(h);
    // SHA-256("abc") começa com ba7816bf8f01
    expect(await shortHash('abc')).toBe('ba7816bf8f01');
  });
  it('clip corta e preserva null', () => {
    expect(clip('abcdef', 3)).toBe('abc');
    expect(clip(null)).toBeNull();
    expect(clip(undefined)).toBeNull();
  });
});

describe('classificação A-GL2', () => {
  it.each([
    ['Google SwiftShader', 'software'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'software'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'software'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002F04) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'confirmed'],
    ['Adreno (TM) 840', 'confirmed'],
    ['Apple GPU', 'confirmed'],
    // Regressão da F2a: o Brave devolve só "Brave" — nome escondido, aceleração desconhecida.
    ['Brave', 'unknown'],
    ['WebKit WebGL', 'unknown'],
    ['Mozilla', 'unknown'],
    ['  ', 'unknown'],
    // Revisão do PR #3: nome não reconhecido não confirma aceleração.
    ['Generic Custom Renderer', 'unknown'],
    ['ANGLE (Unknown, Some Future GPU Direct3D11)', 'unknown'],
    ['Mali-G720', 'confirmed'],
    ['ANGLE (Intel, Intel(R) UHD Graphics (0x0000A7A8) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'confirmed'],
    ['AMD Radeon RX 7800 XT', 'confirmed'],
  ])('%s → %s', (r, g) => expect(gpuAcceleration(r)).toBe(g));
  it('renderizador ausente é desconhecido; software_renderer só é true/false quando se sabe', () => {
    expect(gpuAcceleration(null)).toBe('unknown');
    expect(isSoftwareRenderer('Brave')).toBeNull();
    expect(isSoftwareRenderer('Google SwiftShader')).toBe(true);
    expect(isSoftwareRenderer('Adreno (TM) 840')).toBe(false);
  });
  it('WebGL 2 funcionando é AP mesmo com a placa escondida; aceleração fica em campo separado', () => {
    expect(classifyGl2(false, false, 'none').status).toBe('RP');
    expect(classifyGl2(true, false, 'confirmed').status).toBe('RP');
    expect(classifyGl2(true, true, 'software').status).toBe('INV');
    const hidden = classifyGl2(true, true, 'unknown');
    expect(hidden.status).toBe('AP');
    expect(hidden.detail).toContain('NÃO confirmada');
    expect(classifyGl2(true, true, 'confirmed')).toMatchObject({ status: 'AP' });
    expect(classifyGl2(true, true, 'confirmed').detail).toContain('indicativo');
  });
});

const sdkOk: SdkOutcome = { ready: true, readyMs: 123.4, error: null, instanceId: 'i-123', guildId: '999', channelId: '888', sdkVersion: '2.5.0' };

describe('classificação A-ENV', () => {
  const dHints = readUrlHints(DISCORD_QS);
  it('standalone aprova sem SDK', () => {
    expect(classifyEnv(readUrlHints(''), null).status).toBe('AP');
  });
  it('Discord com handshake aprova; sem handshake reprova; sem SDK é erro', () => {
    expect(classifyEnv(dHints, sdkOk)).toEqual({ status: 'AP', detail: 'Discord Desktop: handshake concluído em 123 ms.' });
    expect(classifyEnv(dHints, { ...sdkOk, ready: false, readyMs: null, error: 'sem resposta em 10 s' }).status).toBe('RP');
    expect(classifyEnv(dHints, null).status).toBe('ERRO');
  });
});

const gl2: Gl2Result = {
  status: 'AP', detail: 'ok', context_ok: true, draw_ok: true, renderer: 'ANGLE (NVIDIA)', vendor: 'Google Inc. (NVIDIA)',
  software_renderer: false, gpu_acceleration_status: 'confirmed', max_texture_size: 16384, max_renderbuffer_size: 16384, max_samples: 8,
  max_viewport_dims: [32767, 32767], extensions: ['EXT_color_buffer_float'],
};
const { gpu_acceleration_status: _semCampoNovo, ...gl2v1 } = gl2;

function fullTests(): Tests {
  const async = { status: 'AP' as const, detail: 'ok', result: 42, ms: 12, error: null };
  return {
    'A-ENV': { status: 'AP', detail: 'ok' },
    'A-GL2': gl2,
    'A-WASM-EMBED': { status: 'AP', detail: 'ok', result_ok: true, compile_ms: 1.2, error: null },
    'A-WASM-URL': {
      status: 'AP', detail: 'ok', http_status: 200, content_type: 'application/wasm', bytes: 97,
      streaming_ok: true, fallback_ok: null, ms: 8, error: null,
    },
    'A-CSP': { status: 'AP', detail: 'ok', violations: [] },
    'A-WASM-FEAT': {
      status: 'AP', detail: 'ok', features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Tests['A-WASM-FEAT']['features'],
      jspi_api: true, shared_array_buffer: false, cross_origin_isolated: false,
    },
    'A-JSPI-CORE': { ...async, api_present: true },
    'A-ASYNCIFY-CORE': async,
    'A-JSPI-EMCC': { ...async, api_present: true, emcc_version: 'emcc (Emscripten gcc/clang-like replacement) 6.0.13' },
    'A-ASYNCIFY-EMCC': { ...async, emcc_version: null },
    'A-IDB': { status: 'AP', detail: 'ok', read_write_ok: true, quota_mb: 1024, usage_mb: 0.01, persisted: false, error: null },
    'A-IDB-PERSIST': {
      status: 'SKIP', detail: 'ok', storage_context: 'discord-desktop-app', state_at_open: 'confirmed', state_now: 'pending',
      marker_age_s: null, last_confirmed_age_s: 600, marker_written_this_session: true, user_reported_missing: false,
      receipt_saved: null, legacy_migrated: false,
    },
    'A-LAYOUT': {
      status: 'AP', detail: 'ok', orientation_type: 'portrait-primary', orientation_angle: 0,
      visual_viewport: { width: 384, height: 832, scale: 1 }, safe_area: { top: 24, right: 0, bottom: 0, left: 0 },
      changes: [{ t_ms: 1200, width: 832, height: 384, orientation_type: 'landscape-primary' }],
    },
    'A-VIS': { status: 'AP', detail: 'ok', hidden: 1, visible: 1, pagehide: 0, blur: 2, focus: 2 },
    'I-BENCH': { status: 'AP', detail: 'ok', iterations: 20_000_000, wasm_ms: 20, js_ms: 25, same_result: true },
    // Interativos no estado inicial ("ainda não feito").
    'A-KEY': new KeyTest().result(),
    'A-PAD': new PadTest(true).result(),
    'A-TOUCH': new TouchTest(5).result(),
    'A-FS': new FsTest(true).result(),
    'A-AUDIO': new AudioTest().result(),
    'A-FILE-BASIC': new FileBasicTest().result(),
    'A-FILE-LARGE': new FileLargeTest().result(),
    // Rede (F3a) no estado inicial ("verificando…" / "ainda não feito").
    'N-HTTP': httpResult(null, 'discord'),
    'N-PATH': pathResult(null, 'discord'),
    'N-WS-OPEN': new WsOpenTest({ fetch: async () => { throw new Error('sem rede'); }, now: () => 0, WebSocket: class {} as never }).result(),
    // F3b no estado inicial.
    'N-ECHO': new EchoTest({ fetch: async () => { throw new Error('sem rede'); }, now: () => 0, WebSocket: class {} as never }).result(),
  };
}

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    version: '0.2.0', gitSha: 'abc1234def56', builtAt: '2026-11-15T12:00:00.000Z', sdkVersion: '2.5.0',
    runId: '123e4567-e89b-42d3-a456-426614174000', startedAt: '2026-11-15T12:05:00.000Z', durationMs: 812.6,
    tzOffsetMin: -180,
    context: {
      mode: 'discord', discord_platform: 'desktop', discord_client: 'desktop-app', storage_context: 'discord-desktop-app',
      mobile_app_version: null, instance_hash: 'ba7816bf8f01',
      in_guild: true, in_channel: true, sdk_ready_ms: 123.4, sdk_error: null, user_agent: 'Mozilla/5.0 discord/1.0.9268',
      ua_ch: { platform: 'Windows', mobile: false, brands: ['Chromium/152'] }, viewport: { width: 1280, height: 720 },
      screen: { width: 1920, height: 1080 }, dpr: 1, hardware_concurrency: 8, device_memory_gb: 8,
    },
    human: { device_label: 'PC', os_label: 'Windows 11', network: 'cabo', voice_call_active: false, notes: '' },
    tests: fullTests(),
    cleanup: { needed: true, performed: true },
    ...over,
  };
}

describe('cliente Discord e contexto de armazenamento', () => {
  const desk = readUrlHints(DISCORD_QS);
  const mob = readUrlHints('?frame_id=a&instance_id=b&platform=mobile');
  it('separa app do PC, Discord Web e celular', () => {
    expect(discordClient(desk, 'Mozilla/5.0 (Windows NT 10.0) discord/1.0.9268 Chrome/152 Electron/44')).toBe('desktop-app');
    expect(discordClient(desk, 'Mozilla/5.0 (Windows NT 10.0) Chrome/152 Safari/537.36')).toBe('web');
    expect(discordClient(mob, 'Mozilla/5.0 (Linux; Android 17; wv) Chrome/157')).toBe('mobile');
    expect(discordClient(readUrlHints(''), 'discord/1.0')).toBeNull();
  });
  it('cada cliente tem seu próprio contexto de armazenamento', () => {
    expect(storageContext('desktop-app')).toBe('discord-desktop-app');
    expect(storageContext('web')).toBe('discord-web');
    expect(storageContext('mobile')).toBe('discord-mobile');
    expect(storageContext(null)).toBe('standalone');
  });
});

describe('relatório e schema', () => {
  it('relatório v2 completo é válido', () => {
    const r = buildReport(input());
    const v = validateReport(r);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(r.schema).toBe('bt3probe.report/6');
    expect(r.run.duration_ms).toBe(813);
    expect(reportFileName(r)).toBe('bt3probe-discord-desktop-app-2026-11-15T12-05-00-000Z.json');
  });
  it('relatório standalone (tudo do Discord nulo) é válido', () => {
    const base = input();
    const r = buildReport(input({
      context: {
        ...base.context, mode: 'standalone', discord_platform: null, discord_client: null, storage_context: 'standalone',
        instance_hash: null, in_guild: null, in_channel: null, sdk_ready_ms: null, ua_ch: null, device_memory_gb: null,
      },
      human: { device_label: '', os_label: '', network: 'nao-informado', voice_call_active: null, notes: '' },
    }));
    expect(validateReport(r).ok).toBe(true);
    expect(reportFileName(r)).toMatch(/^bt3probe-standalone-/);
  });
  it('relatório da F1 (formato 1) continua válido', () => {
    const f1 = {
      schema: 'bt3probe.report/1',
      probe: { version: '0.1.0', git_sha: '279928828998', built_at: '2026-11-15T02:40:56.454Z', sdk_version: '2.5.0' },
      run: { id: '527cfe8c-1077-446e-a900-133c77388081', started_at: '2026-11-15T03:00:05.720Z', duration_ms: 104, tz_offset_min: -180 },
      context: {
        mode: 'discord', discord_platform: 'desktop', mobile_app_version: null, instance_hash: '17257686099a', in_guild: true,
        in_channel: true, sdk_ready_ms: 36.8, sdk_error: null, user_agent: 'Mozilla/5.0 discord/1.0.9268', ua_ch: null,
        viewport: { width: 1528, height: 720 }, screen: { width: 1920, height: 1080 }, dpr: 1, hardware_concurrency: 16,
        device_memory_gb: 32, device_label: 'PC', os_label: 'Windows 11', network: 'cabo', voice_call_active: null,
      },
      tests: { 'A-ENV': { status: 'AP', detail: 'ok' }, 'A-GL2': gl2v1 },
      consents: [], cleanup: { needed: false, performed: false }, notes: '',
    };
    expect(validateReport(f1).errors).toEqual([]);
    // O mesmo conteúdo rotulado como formato 2 não passa: faltam os testes novos.
    expect(validateReport({ ...f1, schema: 'bt3probe.report/2' }).ok).toBe(false);
    expect(validateReport({ ...f1, schema: 'bt3probe.report/9' }).ok).toBe(false);
  });
  it('relatórios da F2a (formato 2) e da F2b-0 (formato 3) continuam válidos', () => {
    const r = buildReport(input()) as unknown as Record<string, unknown> & { tests: Record<string, unknown> };
    const { 'A-KEY': _1, 'A-PAD': _2, 'A-TOUCH': _3, 'A-FS': _4, 'A-AUDIO': _5, 'A-FILE-BASIC': _6, 'A-FILE-LARGE': _7, 'N-HTTP': _8, 'N-PATH': _9, 'N-WS-OPEN': _10, 'N-ECHO': _11, ...f2a } = r.tests;
    const v3 = { ...r, schema: 'bt3probe.report/3', tests: f2a };
    // Formato 3 (F2b-0, publicado na 0.2.1) continua válido; o formato 4 exige os testes da F2b.
    expect(validateReport(v3).errors).toEqual([]);
    expect(validateReport({ ...v3, schema: 'bt3probe.report/4' }).ok).toBe(false);
    const v2 = {
      ...r,
      schema: 'bt3probe.report/2',
      tests: {
        ...f2a,
        'A-GL2': gl2v1,
        'A-IDB-PERSIST': {
          status: 'AP', detail: 'ok', storage_context: 'discord-mobile', marker_found: true, marker_age_s: 31,
          marker_written_this_session: false, marker_pending: false, marker_deleted: true, user_reported_missing: false,
        },
      },
    };
    expect(validateReport(v2).errors).toEqual([]);
    // O formato 3 exige os campos novos.
    expect(validateReport({ ...v2, schema: 'bt3probe.report/3' }).ok).toBe(false);
  });
  it('relatório da F2b (formato 4) continua válido; o formato 5 exige os testes de rede', () => {
    const r = buildReport(input()) as unknown as Record<string, unknown> & { tests: Record<string, unknown> };
    const { 'N-HTTP': _1, 'N-PATH': _2, 'N-WS-OPEN': _3, 'N-ECHO': _4, ...f2b } = r.tests;
    const v4 = { ...r, schema: 'bt3probe.report/4', tests: f2b };
    expect(validateReport(v4).errors).toEqual([]);
    expect(validateReport({ ...v4, schema: 'bt3probe.report/5' }).ok).toBe(false);
  });
  it('relatório da F3a (formato 5) continua válido; o formato 6 exige o N-ECHO', () => {
    const r = buildReport(input()) as unknown as Record<string, unknown> & { tests: Record<string, unknown> };
    const { 'N-ECHO': _1, ...f3a } = r.tests;
    const v5 = { ...r, schema: 'bt3probe.report/5', tests: f3a };
    expect(validateReport(v5).errors).toEqual([]);
    expect(validateReport({ ...v5, schema: 'bt3probe.report/6' }).ok).toBe(false);
    expect(validateReport({ ...r, schema: 'bt3probe.report/5' }).ok).toBe(false); // v5 não conhece o N-ECHO
  });
  it('eco contínuo: resultados reais (AP, queda e reconexão, 4002, parado) passam no schema v6 sem bilhete', async () => {
    const BASES = { httpBase: PAGE, wsBase: 'wss://x.discordsays.com' };
    const cases = [
      { latency: (seq: number) => (seq % 97 === 0 ? 1500 : 90 + (seq % 7)) },
      { closeAfter: [{ conn: 0, afterMs: 15_000, code: 1006 }] },
      { closeAfter: [{ conn: 0, afterMs: 5000, code: 4002 }] },
      { refuse: true },
    ];
    for (const o of cases) {
      const clock = new FakeClock();
      const e = new EchoTest({ fetch: fakeFetch(server()), now: clock.now, timeoutMs: 5000, WebSocket: echoServer(clock, o), timers: clock });
      e.setPairLabel('PC-1');
      const p = e.run(BASES, 'relativo');
      await clock.runUntil(p);
      const r = buildReport(input({ tests: { ...fullTests(), 'N-ECHO': e.result() } }));
      expect(validateReport(r).errors).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(TICKET);
    }
  });
  it('eco contínuo: o schema recusa amostras cruas, URL e campos extras', () => {
    const r = buildReport(input()) as unknown as Record<string, Record<string, unknown>>;
    const t = r.tests as Record<string, Record<string, unknown>>;
    const e = t['N-ECHO']!;
    expect(validateReport({ ...r, tests: { ...t, 'N-ECHO': { ...e, samples: [100, 101] } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'N-ECHO': { ...e, url: 'wss://x/net/ws/echo?bilhete=ab' } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'N-ECHO': { ...e, worst: Array(21).fill({ t_ms: 1, rtt_ms: 1 }) } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'N-ECHO': { ...e, pair_label: 'x'.repeat(41) } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'N-ECHO': { ...e, connection: { ...(e.connection as object), ticket: 'ab'.repeat(16) } } } }).ok).toBe(false);
  });
  it('rede: resultados reais (sucesso, falhas variadas e caminhos) passam no schema v6', async () => {
    const W = fakeWs(['ok', 'recusa', 'fecha-4002', 'trava', 'eco-errado']);
    const t = new WsOpenTest({ fetch: fakeFetch(server()), now, timeoutMs: T, WebSocket: W });
    await t.run({ httpBase: PAGE, wsBase: 'wss://x.discordsays.com' });
    const discord = await runPathChecks({ fetch: fakeFetch((u) => (u.includes('kingszin') ? 'falha' : u.includes('.proxy') ? res(404, '') : res(200, HEALTH(true)))), now, timeoutMs: T }, 'discord', PAGE);
    const alone = await runPathChecks({ fetch: fakeFetch(() => 'trava'), now, timeoutMs: T }, 'standalone', 'https://enzo-rbt0.github.io');
    for (const [run, mode] of [[discord, 'discord'], [alone, 'standalone']] as const) {
      const r = buildReport(input({ tests: { ...fullTests(), 'N-HTTP': httpResult(run, mode), 'N-PATH': pathResult(run, mode), 'N-WS-OPEN': t.result() } }));
      expect(validateReport(r).errors).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(TICKET);
    }
    expect(t.result().attempts).toHaveLength(5);
  });
  it('rede: não aceita bilhete, URL ou IP no relatório', () => {
    const r = buildReport(input()) as unknown as Record<string, Record<string, unknown>>;
    const t = r.tests as Record<string, Record<string, unknown>>;
    const attempt = {
      n: 1, admit_status: 201, open_ok: true, open_ms: 80, echo_ok: true, echo_ms: 70, close_code: 1000,
      closed_by_server: false, failed_stage: null, error: null,
    };
    const ws = { ...t['N-WS-OPEN'], status: 'INV', ran: true, window_open: true, attempts: [attempt], opened: 1, echoed: 1 };
    expect(validateReport({ ...r, tests: { ...t, 'N-WS-OPEN': ws } }).errors).toEqual([]);
    expect(validateReport({ ...r, tests: { ...t, 'N-WS-OPEN': { ...ws, attempts: [{ ...attempt, bilhete: 'ab'.repeat(16) }] } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'N-HTTP': { ...t['N-HTTP'], url: 'https://sonda.kingszin.com.br/net/health' } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'N-PATH': { ...t['N-PATH'], client_ip: '203.0.113.9' } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'N-WS-OPEN': { ...ws, attempts: Array(6).fill(attempt) } } }).ok).toBe(false);
  });
  it('rejeita campo extra em qualquer nível (ex.: alguém tentar incluir user_id ou URL)', () => {
    const r = buildReport(input()) as unknown as Record<string, Record<string, unknown>>;
    const t = r.tests as Record<string, Record<string, unknown>>;
    expect(validateReport({ ...r, user_id: '1' }).ok).toBe(false);
    expect(validateReport({ ...r, context: { ...r.context, guild_id: '999' } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'A-WASM-URL': { ...t['A-WASM-URL'], url: 'https://x' } } }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...t, 'A-CSP': { ...t['A-CSP'], violations: [{ directive: 'script-src', disposition: 'enforce', category: 'wasm-eval', count: 1, blocked_uri: 'https://x' }] } } }).ok).toBe(false);
  });
  it('rejeita identificador cru no lugar do hash e servidor como texto', () => {
    const r = buildReport(input());
    expect(validateReport({ ...r, context: { ...r.context, instance_hash: 'i-123' } }).ok).toBe(false);
    expect(validateReport({ ...r, context: { ...r.context, in_guild: '999' } }).ok).toBe(false);
  });
  it('rejeita teste faltando, status desconhecido e consentimento', () => {
    const r = buildReport(input());
    const { 'A-JSPI-EMCC': _omit, ...semEmcc } = r.tests;
    expect(validateReport({ ...r, tests: semEmcc }).ok).toBe(false);
    expect(validateReport({ ...r, tests: { ...r.tests, 'A-GL2': { ...gl2, status: 'OK' } } }).ok).toBe(false);
    expect(validateReport({ ...r, consents: [{ test: 'A-MEM' }] }).ok).toBe(false);
  });
  it('corta textos humanos longos para caber no schema', () => {
    const r = buildReport(input({ human: { device_label: 'x'.repeat(500), os_label: 'y', network: 'wifi', voice_call_active: true, notes: 'n'.repeat(5000) } }));
    expect(r.context.device_label).toHaveLength(120);
    expect(r.notes).toHaveLength(2000);
    expect(validateReport(r).ok).toBe(true);
  });
});
