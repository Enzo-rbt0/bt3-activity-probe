// Espelho em TypeScript de packages/report-schema/schema/report.v1.json. O schema é a fonte da verdade:
// os testes validam relatórios montados com estes tipos contra o validador gerado a partir dele.

export type Status = 'AP' | 'RP' | 'INV' | 'SKIP' | 'ERRO';
export type Network = 'nao-informado' | 'cabo' | 'wifi' | '4g' | '5g' | 'outra';

export interface Size { width: number; height: number }

export interface UaCh { platform?: string; mobile?: boolean; brands?: string[] }

export interface ContextInfo {
  mode: 'discord' | 'standalone';
  discord_platform: 'desktop' | 'mobile' | null;
  mobile_app_version: string | null;
  instance_hash: string | null;
  in_guild: boolean | null;
  in_channel: boolean | null;
  sdk_ready_ms: number | null;
  sdk_error: string | null;
  user_agent: string;
  ua_ch: UaCh | null;
  viewport: Size;
  screen: Size;
  dpr: number;
  hardware_concurrency: number | null;
  device_memory_gb: number | null;
  device_label: string;
  os_label: string;
  network: Network;
  voice_call_active: boolean | null;
}

export interface EnvResult { status: Status; detail: string }

export interface Gl2Result {
  status: Status;
  detail: string;
  context_ok: boolean;
  draw_ok: boolean;
  renderer: string | null;
  vendor: string | null;
  software_renderer: boolean | null;
  max_texture_size: number | null;
  max_renderbuffer_size: number | null;
  max_samples: number | null;
  max_viewport_dims: [number, number] | null;
  extensions: string[];
}

export interface Report {
  schema: 'bt3probe.report/1';
  probe: { version: string; git_sha: string; built_at: string; sdk_version: string | null };
  run: { id: string; started_at: string; duration_ms: number; tz_offset_min: number };
  context: ContextInfo;
  tests: { 'A-ENV': EnvResult; 'A-GL2': Gl2Result };
  consents: [];
  cleanup: { needed: boolean; performed: boolean };
  notes: string;
}

export interface HumanInput {
  device_label: string;
  os_label: string;
  network: Network;
  voice_call_active: boolean | null;
  notes: string;
}
