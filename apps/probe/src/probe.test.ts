import { describe, expect, it } from 'vitest';
import { readUrlHints } from './env';
import { clip, shortHash } from './hash';
import { buildReport, reportFileName, type BuildInput } from './report/build';
import { validateReport } from './report/validate';
import { classifyEnv, type SdkOutcome } from './tests/a-env';
import { classifyGl2, isSoftwareRenderer } from './tests/a-gl2';
import type { Gl2Result } from './report/types';

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
    ['Google SwiftShader', true],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', true],
    ['Microsoft Basic Render Driver', true],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', false],
    ['Adreno (TM) 642L', false],
    ['Apple GPU', false],
  ])('%s → software=%s', (r, sw) => expect(isSoftwareRenderer(r)).toBe(sw));
  it('renderizador vazio ou ausente é desconhecido', () => {
    expect(isSoftwareRenderer(null)).toBeNull();
    expect(isSoftwareRenderer('  ')).toBeNull();
  });
  it('status segue contexto → desenho → software', () => {
    expect(classifyGl2(false, false, null).status).toBe('RP');
    expect(classifyGl2(true, false, false).status).toBe('RP');
    expect(classifyGl2(true, true, true).status).toBe('INV');
    expect(classifyGl2(true, true, null).status).toBe('INV');
    expect(classifyGl2(true, true, false).status).toBe('AP');
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
  software_renderer: false, max_texture_size: 16384, max_renderbuffer_size: 16384, max_samples: 8,
  max_viewport_dims: [32767, 32767], extensions: ['EXT_color_buffer_float'],
};

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    version: '0.1.0', gitSha: 'abc1234def56', builtAt: '2026-11-14T12:00:00.000Z', sdkVersion: '2.5.0',
    runId: '123e4567-e89b-42d3-a456-426614174000', startedAt: '2026-11-14T12:05:00.000Z', durationMs: 812.6,
    tzOffsetMin: -180,
    context: {
      mode: 'discord', discord_platform: 'desktop', mobile_app_version: null, instance_hash: 'ba7816bf8f01',
      in_guild: true, in_channel: true, sdk_ready_ms: 123.4, sdk_error: null, user_agent: 'Mozilla/5.0 Discord',
      ua_ch: { platform: 'Windows', mobile: false, brands: ['Chromium/134'] }, viewport: { width: 1280, height: 720 },
      screen: { width: 1920, height: 1080 }, dpr: 1, hardware_concurrency: 8, device_memory_gb: 8,
    },
    human: { device_label: 'PC', os_label: 'Windows 11', network: 'cabo', voice_call_active: false, notes: '' },
    env: { status: 'AP', detail: 'ok' },
    gl2,
    ...over,
  };
}

describe('relatório e schema', () => {
  it('relatório completo é válido', () => {
    const r = buildReport(input());
    const v = validateReport(r);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(r.run.duration_ms).toBe(813);
    expect(reportFileName(r)).toBe('bt3probe-desktop-2026-11-14T12-05-00-000Z.json');
  });
  it('relatório standalone (tudo do Discord nulo) é válido', () => {
    const base = input();
    const r = buildReport(input({
      context: { ...base.context, mode: 'standalone', discord_platform: null, instance_hash: null, in_guild: null, in_channel: null, sdk_ready_ms: null, ua_ch: null, device_memory_gb: null },
      human: { device_label: '', os_label: '', network: 'nao-informado', voice_call_active: null, notes: '' },
    }));
    expect(validateReport(r).ok).toBe(true);
    expect(reportFileName(r)).toMatch(/^bt3probe-standalone-/);
  });
  it('rejeita campo extra em qualquer nível (ex.: alguém tentar incluir user_id)', () => {
    const r = buildReport(input()) as unknown as Record<string, Record<string, unknown>>;
    expect(validateReport({ ...r, user_id: '1' }).ok).toBe(false);
    expect(validateReport({ ...r, context: { ...r.context, user_id: '1' } }).ok).toBe(false);
    expect(validateReport({ ...r, context: { ...r.context, guild_id: '999' } }).ok).toBe(false);
  });
  it('rejeita identificador cru no lugar do hash e servidor como texto', () => {
    const r = buildReport(input());
    expect(validateReport({ ...r, context: { ...r.context, instance_hash: 'i-123' } }).ok).toBe(false);
    expect(validateReport({ ...r, context: { ...r.context, in_guild: '999' } }).ok).toBe(false);
  });
  it('rejeita status desconhecido, schema errado e consentimento em F1', () => {
    const r = buildReport(input());
    expect(validateReport({ ...r, tests: { ...r.tests, 'A-GL2': { ...gl2, status: 'OK' } } }).ok).toBe(false);
    expect(validateReport({ ...r, schema: 'bt3probe.report/2' }).ok).toBe(false);
    expect(validateReport({ ...r, consents: [{ test: 'A-MEM' }] }).ok).toBe(false);
  });
  it('corta textos humanos longos para caber no schema', () => {
    const r = buildReport(input({ human: { device_label: 'x'.repeat(500), os_label: 'y', network: 'wifi', voice_call_active: true, notes: 'n'.repeat(5000) } }));
    expect(r.context.device_label).toHaveLength(120);
    expect(r.notes).toHaveLength(2000);
    expect(validateReport(r).ok).toBe(true);
  });
});
