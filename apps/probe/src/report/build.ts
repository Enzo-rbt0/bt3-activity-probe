import type { ContextInfo, HumanInput, Report, Tests } from './types';

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
  tests: Tests;
  cleanup: { needed: boolean; performed: boolean };
}

export function buildReport(i: BuildInput): Report {
  return {
    schema: 'bt3probe.report/4',
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
    tests: i.tests,
    // Nenhum teste pesado: nada a consentir.
    consents: [],
    cleanup: i.cleanup,
    notes: i.human.notes.slice(0, 2000),
  };
}

export function reportFileName(r: Report): string {
  const stamp = r.run.started_at.replace(/[:.]/g, '-');
  return `bt3probe-${r.context.storage_context}-${stamp}.json`;
}
