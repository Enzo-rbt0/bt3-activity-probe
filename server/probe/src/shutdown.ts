// Encerramento por sinal. Saída 0 só se stop() terminar bem; falha ou demora acima do limite
// é registrada e sai com código 1 (o systemd marca a unidade como "failed" e isso aparece no status).
import type { Logger } from './log.js';

export const STOP_TIMEOUT_MS = 8000; // abaixo do TimeoutStopSec=10 da unidade systemd

export async function shutdown(
  stop: () => Promise<void>,
  log: Logger,
  exit: (code: number) => void,
  timeoutMs = STOP_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const r = await Promise.race([stop().then(() => 'ok' as const), timeout]);
    if (r === 'timeout') {
      log('encerramento_falhou', { reason: 'tempo esgotado' });
      return exit(1);
    }
    log('encerrado', {});
    exit(0);
  } catch (e) {
    log('encerramento_falhou', { reason: e instanceof Error ? e.name : 'erro' });
    exit(1);
  } finally {
    clearTimeout(timer);
  }
}
