// Único ponto que fala com o Discord. Só é chamado quando a URL parece vir do Discord; fora dele o
// construtor do SDK lança erro. ready() não pede nenhuma permissão (sem authorize/OAuth): a sonda não
// sabe quem é o usuário e não precisa saber.
import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { SdkOutcome } from './tests/a-env';

export const DISCORD_CLIENT_ID = '1571332639812493522';
const READY_TIMEOUT_MS = 10_000;

export async function startSdk(): Promise<SdkOutcome> {
  const t0 = performance.now();
  let sdk: DiscordSDK;
  try {
    sdk = new DiscordSDK(DISCORD_CLIENT_ID);
  } catch (e) {
    return { ready: false, readyMs: null, error: `construtor: ${String(e).slice(0, 200)}`, instanceId: null, guildId: null, channelId: null, sdkVersion: null };
  }
  const base = { instanceId: sdk.instanceId || null, guildId: sdk.guildId, channelId: sdk.channelId, sdkVersion: sdk.sdkVersion ?? null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sdk.ready(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sem resposta em ${READY_TIMEOUT_MS / 1000} s`)), READY_TIMEOUT_MS);
      }),
    ]);
    return { ...base, ready: true, readyMs: performance.now() - t0, error: null };
  } catch (e) {
    return { ...base, ready: false, readyMs: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
