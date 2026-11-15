// Detecção de ambiente. ATENÇÃO (condição 5 aprovada): os parâmetros da URL só dizem "parece que a
// página foi aberta pelo Discord". Qualquer pessoa pode montar uma URL com eles, então isso NUNCA é
// prova de identidade nem de autorização. Aqui serve só para decidir se vale tentar o handshake do SDK
// e para separar resultados por ambiente.
import type { DiscordClient, StorageContext } from './report/types';

export type Mode = 'discord' | 'standalone';
export type DiscordPlatform = 'desktop' | 'mobile';

export interface UrlHints {
  mode: Mode;
  platform: DiscordPlatform | null;
  mobileAppVersion: string | null;
}

const REQUIRED = ['frame_id', 'instance_id', 'platform'] as const;

export function readUrlHints(search: string): UrlHints {
  const params = new URLSearchParams(search);
  const hasAll = REQUIRED.every((k) => (params.get(k) ?? '').trim() !== '');
  const rawPlatform = params.get('platform');
  const platform: DiscordPlatform | null =
    rawPlatform === 'desktop' || rawPlatform === 'mobile' ? rawPlatform : null;
  // Sem os três parâmetros, ou com plataforma desconhecida, o SDK lançaria erro no construtor:
  // nesse caso a sonda roda sozinha (modo standalone) e não cria o SDK.
  if (!hasAll || platform === null) {
    return { mode: 'standalone', platform: null, mobileAppVersion: null };
  }
  return { mode: 'discord', platform, mobileAppVersion: params.get('mobile_app_version') };
}

// O SDK diz "desktop" tanto para o app do PC quanto para o Discord aberto no navegador. O app do PC
// é Electron e põe "discord/<versão>" no user agent (visto na F1); o navegador não.
export function discordClient(hints: UrlHints, userAgent: string): DiscordClient | null {
  if (hints.mode !== 'discord') return null;
  if (hints.platform === 'mobile') return 'mobile';
  return /\bdiscord\/\d/i.test(userAgent) ? 'desktop-app' : 'web';
}

// Cada ambiente guarda seus dados separado (o navegador particiona o armazenamento pelo site que
// abre o iframe). O teste de persistência só compara sessões do MESMO contexto.
export function storageContext(client: DiscordClient | null): StorageContext {
  if (client === 'desktop-app') return 'discord-desktop-app';
  if (client === 'web') return 'discord-web';
  if (client === 'mobile') return 'discord-mobile';
  return 'standalone';
}
