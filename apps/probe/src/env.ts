// Detecção de ambiente. ATENÇÃO (condição 5 aprovada): os parâmetros da URL só dizem "parece que a
// página foi aberta pelo Discord". Qualquer pessoa pode montar uma URL com eles, então isso NUNCA é
// prova de identidade nem de autorização. Aqui serve só para decidir se vale tentar o handshake do SDK.

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
