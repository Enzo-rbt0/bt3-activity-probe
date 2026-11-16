// Testes de mutação dos pontos críticos. Para cada mutante: altera o trecho, roda a suíte inteira e
// confere que ela FALHA ("morto"); depois restaura o arquivo. Sai com 1 se algum mutante sobreviver
// e com 2 se um trecho não for encontrado exatamente uma vez (lista desatualizada).
// Uso: npm run mutacao   (só toca arquivos deste pacote; restaura tudo mesmo se interrompido)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST = join(ROOT, 'node_modules/vitest/vitest.mjs');

// [nome, arquivo, de, para, (de, para)...]
const M = [
  // Janela e reinício
  ['reinício: ignora opened_at < início', 'src/config.ts', 'if (opened < processStartedAt)', 'if (false)'],
  ['janela: current() sem prazo', 'src/config.ts', 'this.clock.now() >= s.until', 'false'],
  ['janela: aceita mais de 12 h', 'src/config.ts', 'if (until - opened > MAX_WINDOW_MS)', 'if (false)'],
  ['janela: 12 h exatas recusadas (> vira >=)', 'src/config.ts', 'if (until - opened > MAX_WINDOW_MS)', 'if (until - opened >= MAX_WINDOW_MS)'],
  ['janela: volta a regra "restante ≤ 12 h"', 'src/config.ts', 'if (until - opened > MAX_WINDOW_MS)', 'if (until - opened > MAX_WINDOW_MS || until - now > MAX_WINDOW_MS)'],
  ['janela: aceita vencimento ≤ abertura', 'src/config.ts', 'if (until <= opened)', 'if (false)'],
  ['janela: aceita vencimento = abertura (<= vira <)', 'src/config.ts', 'if (until <= opened)', 'if (until < opened)'],
  ['janela: sem limite de abertura no futuro', 'src/config.ts', 'if (opened > now + FUTURE_SKEW_MS)', 'if (false)'],
  ['janela: tolerância de 60 s vira < 60 s (> vira >=)', 'src/config.ts', 'if (opened > now + FUTURE_SKEW_MS)', 'if (opened >= now + FUTURE_SKEW_MS)'],
  ['janela: tolerância de 60 s vira 61 s', 'src/config.ts', 'export const FUTURE_SKEW_MS = 60 * 1000;', 'export const FUTURE_SKEW_MS = 61 * 1000;'],
  // Orçamento e bilhetes
  ['tx: BEGIN deferred', 'src/db.ts', "raw.exec('BEGIN IMMEDIATE')", "raw.exec('BEGIN')"],
  ['simultâneas: >= vira >', 'src/budget.ts', 'this.activeCount(now) >= this.limits.maxConcurrent', 'this.activeCount(now) > this.limits.maxConcurrent'],
  ['admissões/dia: >= vira >', 'src/budget.ts', 'd.admissions >= this.limits.maxAdmissionsPerDay', 'd.admissions > this.limits.maxAdmissionsPerDay'],
  ['orçamento/dia: removido', 'src/budget.ts', 'd.reserved_msgs + reserved > this.limits.maxReservedPerDay', 'false'],
  ['bilhete: uso único removido (2 travas)', 'src/budget.ts', 'r.redeemed_at !== null || ', '', 'WHERE id = ? AND redeemed_at IS NULL', 'WHERE id = ?'],
  ['bilhete: TTL ignorado', 'src/budget.ts', ' || r.ticket_expires_at <= now', ''],
  ['bilhete: prazo ignora janela', 'src/budget.ts', 'Math.min(windowUntil, now + r.duration_ms)', 'now + r.duration_ms'],
  ['end: não idempotente', 'src/budget.ts', 'if (!r || r.ended_at !== null) return false;', 'if (!r) return false;', "WHERE id = ? AND ended_at IS NULL').run(now, usedClamped", "WHERE id = ?').run(now, usedClamped"],
  ['reap: sem devolução', 'src/budget.ts', "this.db.raw.prepare('UPDATE daily SET reserved_msgs = MAX(0, reserved_msgs - ?) WHERE day = ?').run(r.reserved_msgs, r.day);", ''],
  ['reinício: recoverOnStart sem efeito', 'src/budget.ts', "WHERE ended_at IS NULL').run(now)", "WHERE 0').run(now)"],
  ['quota: ponto flutuante', 'src/budget.ts', 'Math.round((durationMs / 1000) * l.targetHz * l.margin * 1000) / 1000', '(durationMs / 1000) * l.targetHz * l.margin'],
  ['health: stats volta a gravar no banco', 'src/budget.ts', "const d = this.db.raw.prepare('SELECT admissions, reserved_msgs FROM daily WHERE day = ?').get(day) as unknown as DailyRow | undefined;", 'const d = this.daily(day) as DailyRow | undefined;'],
  // Conexão
  ['conn: 64 B vira >=', 'src/ws/conn.ts', 'data.length > this.limits.maxMsgBytes', 'data.length >= this.limits.maxMsgBytes'],
  ['conn: taxa < 1 vira < 0', 'src/ws/conn.ts', 'this.tokens < 1', 'this.tokens < 0'],
  ['conn: cota > vira >=', 'src/ws/conn.ts', 'this.received > this.reserved', 'this.received >= this.reserved'],
  ['conn: sem check antes de responder', 'src/ws/conn.ts', 'if (!this.check()) return;', ''],
  ['conn: inatividade não confere', 'src/ws/conn.ts', 'if (now - this.lastMsgAt >= this.limits.idleMs)', 'if (false)'],
  ['conn: janela não confere', 'src/ws/conn.ts', "if (!this.window().open) return this.close(CLOSE_EXPIRED, 'janela encerrada'), false;", ''],
  // Servidor HTTP
  ['server: varredura vazia', 'src/server.ts', 'for (const c of [...this.conns]) c.check();', ''],
  ['server: upgrade sem Origin', 'src/server.ts', "if (!this.originOk(req)) return this.reject(socket, 403, 'origem não permitida');", ''],
  ['server: POST sem Origin', 'src/server.ts', "if (!this.originOk(req)) return this.json(res, 403, { erro: 'origem não permitida' });", ''],
  ['server: upgrade sem checar janela', 'src/server.ts', 'if (this.stopping || !w.open || w.until === null) return this.reject', 'if (false) return this.reject'],
  ['server: POST sem checar janela', 'src/server.ts', 'if (this.stopping || !w.open) return this.json(res, 503', 'if (false) return this.json(res, 503'],
  ['server: stop fecha com 1000', 'src/server.ts', 'c.close(CLOSE_GOING_AWAY,', 'c.close(1000,'],
  ['server: limite de corpo removido', 'src/server.ts', 'if (size > MAX_BODY) {', 'if (false) {', "if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return tooBig();", ''],
  ['server: erro do banco escapa (sem 503)', 'src/server.ts', "if (!res.headersSent) this.json(res, 503, { erro: 'erro interno: fechado' });", 'throw new Error("mutante");'],
  ['corpo: null aceito como objeto + exceção escapa (derruba o processo)', 'src/server.ts', 'raw === null || ', '', "if (!res.headersSent) this.json(res, 503, { erro: 'erro interno: fechado' });", 'throw new Error("mutante");'],
  ['corpo: null aceito como objeto', 'src/server.ts', 'raw === null || ', ''],
  ['corpo: chaves desconhecidas aceitas', 'src/server.ts', "if (keys.some((k) => k !== 'kind' && k !== 'duration_s')) return", 'if (false) return'],
  ['corpo: duration_s sem checagem de tipo', 'src/server.ts', "(typeof duration_s !== 'number' || !Number.isFinite(duration_s) || duration_s <= 0)", 'false'],
  // Log e encerramento
  ['log: sem lista fechada', 'src/log.ts', 'if (ALLOWED.has(k)) safe[k] = v;', 'safe[k] = v;'],
  ['shutdown: falha sai com 0', 'src/shutdown.ts', "log('encerramento_falhou', { reason: e instanceof Error ? e.name : 'erro' });\n    exit(1);", "log('encerramento_falhou', { reason: e instanceof Error ? e.name : 'erro' });\n    exit(0);"],
  ['shutdown: sem limite de tempo', 'src/shutdown.ts', "if (r === 'timeout') {", 'if (false) {'],
  // Script do interruptor
  ['script: opened_at sem milissegundos', 'ops/bt3probe-janela', 'T0="$(date -u +%s%3N)"', 'T0="$(($(date -u +%s) * 1000))"'],
  ['script: prazo com segunda leitura do relógio', 'ops/bt3probe-janela', 'T1=$((T0 + MIN * 60000))', 'sleep 0.01; T1=$(($(date -u +%s%3N) + MIN * 60000))'],
];

const originals = new Map();
const restoreAll = () => {
  for (const [p, s] of originals) writeFileSync(p, s);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (restoreAll(), process.exit(130)));

const only = process.argv[2];
let killed = 0;
const survivors = [];
const list = only ? M.filter((m) => m[0].includes(only)) : M;
for (const [name, file, ...pairs] of list) {
  const p = join(ROOT, file);
  const orig = readFileSync(p, 'utf8');
  originals.set(p, orig);
  let s = orig;
  for (let i = 0; i < pairs.length; i += 2) {
    const n = s.split(pairs[i]).length - 1;
    if (n !== 1) {
      restoreAll();
      console.error(`ERRO: "${name}": trecho aparece ${n} vezes em ${file}: ${pairs[i]}`);
      process.exit(2);
    }
    s = s.replace(pairs[i], pairs[i + 1]);
  }
  writeFileSync(p, s);
  let passed = false;
  try {
    execFileSync(process.execPath, [VITEST, 'run'], { cwd: ROOT, stdio: 'pipe', timeout: 180_000 });
    passed = true;
  } catch {
    passed = false;
  } finally {
    writeFileSync(p, orig);
    originals.delete(p);
  }
  console.log(`${passed ? 'SOBREVIVEU' : 'morto     '}  ${name}`);
  if (passed) survivors.push(name);
  else killed++;
}
console.log(`\n${killed}/${list.length} mutantes mortos`);
process.exit(survivors.length ? 1 : 0);
