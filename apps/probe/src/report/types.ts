// Espelho em TypeScript de packages/report-schema/schema/report.v2.json. O schema é a fonte da verdade:
// os testes validam relatórios montados com estes tipos contra o validador gerado a partir dele.

export type Status = 'AP' | 'RP' | 'INV' | 'SKIP' | 'ERRO';
export type Network = 'nao-informado' | 'cabo' | 'wifi' | '4g' | '5g' | 'outra';
export type DiscordClient = 'desktop-app' | 'web' | 'mobile';
export type StorageContext = 'standalone' | 'discord-desktop-app' | 'discord-web' | 'discord-mobile';

export interface Size { width: number; height: number }

export interface UaCh { platform?: string; mobile?: boolean; brands?: string[] }

export interface ContextInfo {
  mode: 'discord' | 'standalone';
  discord_platform: 'desktop' | 'mobile' | null;
  discord_client: DiscordClient | null;
  storage_context: StorageContext;
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

export interface Basic { status: Status; detail: string }

export interface Gl2Result extends Basic {
  context_ok: boolean;
  draw_ok: boolean;
  renderer: string | null;
  vendor: string | null;
  software_renderer: boolean | null;
  gpu_acceleration_status: 'confirmed' | 'software' | 'unknown' | 'none';
  max_texture_size: number | null;
  max_renderbuffer_size: number | null;
  max_samples: number | null;
  max_viewport_dims: [number, number] | null;
  extensions: string[];
}

export interface WasmEmbedResult extends Basic { result_ok: boolean; compile_ms: number | null; error: string | null }

export interface WasmUrlResult extends Basic {
  http_status: number | null;
  content_type: string | null;
  bytes: number | null;
  streaming_ok: boolean | null;
  fallback_ok: boolean | null;
  ms: number | null;
  error: string | null;
}

export type CspCategory = 'wasm-eval' | 'eval' | 'inline' | 'mesma-origem' | 'outra-origem' | 'data' | 'blob' | 'outro';
export interface CspViolation {
  directive: string;
  disposition: 'enforce' | 'report' | 'desconhecido';
  category: CspCategory;
  count: number;
}
export interface CspResult extends Basic { violations: CspViolation[] }

export const FEATURE_KEYS = ['simd', 'bulk_memory', 'exceptions', 'multi_value', 'tail_call', 'sat_float_to_int', 'sign_ext'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export interface WasmFeatResult extends Basic {
  features: Record<FeatureKey, boolean | null>;
  jspi_api: boolean;
  shared_array_buffer: boolean;
  cross_origin_isolated: boolean;
}

export interface AsyncResult extends Basic {
  api_present?: boolean;
  emcc_version?: string | null;
  result: number | null;
  ms: number | null;
  error: string | null;
}

export interface IdbResult extends Basic {
  read_write_ok: boolean;
  quota_mb: number | null;
  usage_mb: number | null;
  persisted: boolean | null;
  error: string | null;
}

export type PersistState = 'none' | 'pending' | 'confirmed' | 'cancelled';
export interface PersistResult extends Basic {
  storage_context: StorageContext;
  state_at_open: PersistState;
  state_now: PersistState;
  marker_age_s: number | null;
  last_confirmed_age_s: number | null;
  marker_written_this_session: boolean;
  user_reported_missing: boolean;
  receipt_saved: boolean | null;
  legacy_migrated: boolean;
}

export interface LayoutChange { t_ms: number; width: number; height: number; orientation_type: string | null }
export interface LayoutResult extends Basic {
  orientation_type: string | null;
  orientation_angle: number | null;
  visual_viewport: { width: number; height: number; scale: number } | null;
  safe_area: { top: number; right: number; bottom: number; left: number };
  changes: LayoutChange[];
}

export interface VisResult extends Basic { hidden: number; visible: number; pagehide: number; blur: number; focus: number }

export interface BenchResult extends Basic {
  iterations: number;
  wasm_ms: number | null;
  js_ms: number | null;
  same_result: boolean | null;
}

export interface KeyResult extends Basic {
  keys_expected: string[];
  keys_received: string[];
  keys_missing: string[];
  combos: { keys: string[]; ok: boolean }[];
  max_held: number;
  escape_received: boolean | null;
  focus_lost: number;
}

export type PadType = 'xbox' | 'playstation' | 'outro';
export interface PadResult extends Basic {
  api_present: boolean;
  blocked: boolean;
  error: string | null;
  pad_detected: boolean;
  pad_type: PadType | null;
  mapping: string | null;
  buttons_count: number | null;
  axes_count: number | null;
  buttons_tested: number[];
  left_stick: boolean;
  right_stick: boolean;
  triggers_tested: number[];
  focus_regained: boolean;
  input_after_refocus: boolean | null;
  triggers_verifiable: boolean | null;
}

export interface TouchResult extends Basic {
  touch_capable: boolean;
  max_touch_points: number | null;
  max_simultaneous: number;
  drag_ok: boolean;
  cancels: number;
}

export interface FsResult extends Basic {
  fullscreen_enabled: boolean | null;
  entered: boolean;
  exited: boolean;
  error: string | null;
  size: Size | null;
}

export interface AudioResult extends Basic {
  state_before_gesture: string | null;
  state_after_gesture: string | null;
  sample_rate: number | null;
  base_latency_ms: number | null;
  output_latency_ms: number | null;
  heard: boolean | null;
  during_call: { heard: boolean | null; call_voice_ok: boolean | null } | null;
}

export type TypeCategory = 'imagem' | 'video' | 'audio' | 'outro';
export interface FileRead { where: 'inicio' | 'meio' | 'fim'; bytes: number; ms: number; ok: boolean }
export interface FileBasicResult extends Basic {
  picker_opened: boolean;
  cancelled: boolean;
  size: number | null;
  type_category: TypeCategory | null;
  reads: FileRead[];
}
export interface MarkerRead { where: 'inicio' | 'apos_2gib' | 'fim'; ok: boolean; ms: number | null }
export interface FileLargeResult extends Basic {
  picker_opened: boolean;
  cancelled: boolean;
  size: number | null;
  over_2gib: boolean | null;
  markers: MarkerRead[];
}

export interface Tests {
  'A-ENV': Basic;
  'A-GL2': Gl2Result;
  'A-WASM-EMBED': WasmEmbedResult;
  'A-WASM-URL': WasmUrlResult;
  'A-CSP': CspResult;
  'A-WASM-FEAT': WasmFeatResult;
  'A-JSPI-CORE': AsyncResult;
  'A-ASYNCIFY-CORE': AsyncResult;
  'A-JSPI-EMCC': AsyncResult;
  'A-ASYNCIFY-EMCC': AsyncResult;
  'A-IDB': IdbResult;
  'A-IDB-PERSIST': PersistResult;
  'A-LAYOUT': LayoutResult;
  'A-VIS': VisResult;
  'I-BENCH': BenchResult;
  'A-KEY': KeyResult;
  'A-PAD': PadResult;
  'A-TOUCH': TouchResult;
  'A-FS': FsResult;
  'A-AUDIO': AudioResult;
  'A-FILE-BASIC': FileBasicResult;
  'A-FILE-LARGE': FileLargeResult;
}

export interface Report {
  schema: 'bt3probe.report/4';
  probe: { version: string; git_sha: string; built_at: string; sdk_version: string | null };
  run: { id: string; started_at: string; duration_ms: number; tz_offset_min: number };
  context: ContextInfo;
  tests: Tests;
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

// Mantido para os testes da F1 (formato 1).
export type EnvResult = Basic;
