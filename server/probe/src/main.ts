// Ponto de entrada em produção (systemd). Sempre começa FECHADO: a janela só abre com o script
// ops/bt3probe-janela rodado depois deste processo iniciar (ver config.ts).
// Variáveis: BT3PROBE_HOST (padrão 127.0.0.1), BT3PROBE_PORT (padrão 8787),
// BT3PROBE_DB (padrão /var/lib/bt3probe/probe.db), BT3PROBE_WINDOW_FILE (padrão /etc/bt3probe/janela),
// BT3PROBE_ORIGINS (lista separada por vírgula; padrão: Activity do Discord e GitHub Pages da sonda).
import { systemClock } from './clock.js';
import { openDb } from './db.js';
import { makeLogger } from './log.js';
import { DEFAULT_ORIGINS, ProbeServer } from './server.js';

const env = process.env;
const log = makeLogger();
const host = env.BT3PROBE_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' && env.BT3PROBE_ALLOW_PUBLIC_BIND !== 'sim') {
  log('erro', { reason: 'BT3PROBE_HOST diferente de 127.0.0.1 exige BT3PROBE_ALLOW_PUBLIC_BIND=sim' });
  process.exit(2);
}

const server = new ProbeServer({
  db: openDb(env.BT3PROBE_DB ?? '/var/lib/bt3probe/probe.db'),
  clock: systemClock,
  windowFile: env.BT3PROBE_WINDOW_FILE ?? '/etc/bt3probe/janela',
  processStartedAt: Date.now(),
  host,
  port: Number(env.BT3PROBE_PORT ?? 8787),
  origins: env.BT3PROBE_ORIGINS ? env.BT3PROBE_ORIGINS.split(',').map((s) => s.trim()) : DEFAULT_ORIGINS,
  log,
});

await server.start();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    log('encerrando', { reason: sig });
    server.stop().finally(() => process.exit(0));
  });
}
