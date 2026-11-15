import type { ContextInfo, EnvResult, Gl2Result, HumanInput, Report } from './types';

export interface BuildInput {
  version: string;
  gitSha: string;
  builtAt: string;
  sdkVersion: string | null;
  runId: string;
  startedAt: string;
  durationMs: number;
  tzOffsetMin: number;
  context: Omit<ContextInfo, keyof Omit<HumanInput, 'notes'>>;
  human: HumanInput;
  env: EnvResult;
  gl2: Gl2Result;
}

export function buildReport(i: BuildInput): Report {
  return {
    schema: 'bt3probe.report/1',
    probe: { version: i.version, git_sha: i.gitSha, built_at: i.builtAt, sdk_version: i.sdkVersion },
    run: {
      id: i.runId,
      started_at: i.startedAt,
      duration_ms: Math.max(0, Math.round(i.durationMs)),
      tz_offset_min: Math.trunc(i.tzOffsetMin),
    },
    context: {
      ...i.context,
      device_label: i.human.device_label.slice(0, 120),
      os_label: i.human.os_label.slice(0, 120),
      network: i.human.network,
      voice_call_active: i.human.voice_call_active,
    },
    tests: { 'A-ENV': i.env, 'A-GL2': i.gl2 },
    // F1 não faz nenhum teste pesado: nada a consentir e nada a limpar.
    consents: [],
    cleanup: { needed: false, performed: false },
    notes: i.human.notes.slice(0, 2000),
  };
}

export function reportFileName(r: Report): string {
  const stamp = r.run.started_at.replace(/[:.]/g, '-');
  const where = r.context.mode === 'discord' ? (r.context.discord_platform ?? 'discord') : 'standalone';
  return `bt3probe-${where}-${stamp}.json`;
}
