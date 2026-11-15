// A-ENV: em que ambiente a sonda está rodando (Discord Desktop, Discord celular ou navegador comum) e
// o handshake com o Discord funcionou? Nenhum identificador de usuário é coletado: servidor e canal
// viram sim/não; a instância vira um hash curto.
import { clip, shortHash } from '../hash';
import { discordClient, storageContext, type UrlHints } from '../env';
import type { ContextInfo, DiscordClient, EnvResult, UaCh } from '../report/types';

export type EnvContext = Omit<ContextInfo, 'device_label' | 'os_label' | 'network' | 'voice_call_active'>;

export interface SdkOutcome {
  ready: boolean;
  readyMs: number | null;
  error: string | null;
  instanceId: string | null;
  guildId: string | null;
  channelId: string | null;
  sdkVersion: string | null;
}

export function classifyEnv(hints: UrlHints, sdk: SdkOutcome | null, client: DiscordClient | null = null): EnvResult {
  if (hints.mode === 'standalone') {
    return { status: 'AP', detail: 'Fora do Discord (navegador comum). Coleta feita; o SDK não foi iniciado.' };
  }
  if (!sdk) return { status: 'ERRO', detail: 'Parece Discord, mas o SDK não foi executado.' };
  if (!sdk.ready) {
    return { status: 'RP', detail: `Parece Discord, mas o handshake falhou: ${sdk.error ?? 'sem resposta'}.` };
  }
  const where = hints.platform === 'mobile' ? 'Discord no celular' : client === 'web' ? 'Discord Web' : 'Discord Desktop';
  return { status: 'AP', detail: `${where}: handshake concluído em ${Math.round(sdk.readyMs ?? 0)} ms.` };
}

function readUaCh(nav: Navigator): UaCh | null {
  const d = (nav as Navigator & { userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string; version: string }[] } }).userAgentData;
  if (!d) return null;
  const out: UaCh = {};
  if (typeof d.platform === 'string') out.platform = d.platform.slice(0, 64);
  if (typeof d.mobile === 'boolean') out.mobile = d.mobile;
  if (Array.isArray(d.brands)) out.brands = d.brands.slice(0, 10).map((b) => `${b.brand}/${b.version}`.slice(0, 80));
  return out;
}

export async function collectEnv(hints: UrlHints, sdk: SdkOutcome | null, win: Window = window): Promise<EnvContext> {
  const nav = win.navigator;
  const devMem = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
  const client = discordClient(hints, nav.userAgent);
  return {
    mode: hints.mode,
    discord_platform: hints.platform,
    discord_client: client,
    storage_context: storageContext(client),
    mobile_app_version: clip(hints.mobileAppVersion, 64),
    instance_hash: sdk?.instanceId ? await shortHash(sdk.instanceId) : null,
    in_guild: sdk ? sdk.guildId !== null && sdk.guildId !== '' : null,
    in_channel: sdk ? sdk.channelId !== null && sdk.channelId !== '' : null,
    sdk_ready_ms: sdk?.readyMs ?? null,
    sdk_error: clip(sdk?.error ?? null, 300),
    user_agent: nav.userAgent.slice(0, 1024),
    ua_ch: readUaCh(nav),
    viewport: { width: win.innerWidth, height: win.innerHeight },
    screen: { width: win.screen.width, height: win.screen.height },
    dpr: win.devicePixelRatio || 1,
    hardware_concurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    device_memory_gb: typeof devMem === 'number' ? devMem : null,
  };
}
