// Teste de fumaça: abre a build pronta (apps/probe/dist) num Chromium sem tela e confere que a sonda
// termina e produz um relatório válido. Roda dois cenários:
//   1. standalone (sem parâmetros do Discord);
//   2. URL com parâmetros do Discord falsos e sem Discord por trás: o SDK não responde, a sonda espera
//      o limite de 10 s, marca A-ENV como RP e ainda assim gera relatório válido.
// Também falha se a build contiver eval/new Function (o Discord pode bloquear por CSP).
// Pré-requisito: `npm run build`. Variável opcional PROBE_PW_MODULE aponta para outro pacote playwright
// (útil quando o Chromium já está instalado em outro lugar).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import validate from '../packages/report-schema/generated/validate-report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/probe/dist');
const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`FALHOU: ${msg}`);
  process.exitCode = 1;
}

// 1) Nada de avaliação de código em tempo de execução na build.
for (const f of readdirSync(join(dist, 'assets')).filter((n) => n.endsWith('.js'))) {
  const src = readFileSync(join(dist, 'assets', f), 'utf8');
  if (/new Function\s*\(|\beval\s*\(/.test(src)) fail(`${f} contém eval/new Function`);
}
const html = readFileSync(join(dist, 'index.html'), 'utf8');
if (/(src|href)="\/(?!\/)/.test(html)) fail('index.html usa caminho absoluto; precisa ser relativo (base ./)');

async function loadPlaywright() {
  const override = process.env.PROBE_PW_MODULE;
  if (override) return import(pathToFileURL(createRequire(import.meta.url).resolve(override)).href);
  return import('playwright');
}

async function waitForServer(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('servidor de preview não subiu');
}

const server = spawn('npx', ['vite', 'preview', '--config', 'apps/probe/vite.config.ts', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  detached: true,
});

async function scenario(browser, name, query, expectEnv, timeoutMs) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + query);
  await page.waitForSelector('body[data-probe-done]', { timeout: timeoutMs });
  const done = await page.getAttribute('body', 'data-probe-done');
  if (done !== 'true') fail(`${name}: sonda terminou com erro (${await page.textContent('#mode')})`);
  await page.fill('input[name=device_label]', 'smoke');
  await page.selectOption('select[name=network]', 'cabo');
  const report = JSON.parse(await page.inputValue('#json'));
  if (!validate(report)) fail(`${name}: relatório inválido ${JSON.stringify(validate.errors)}`);
  if (report.context.device_label !== 'smoke' || report.context.network !== 'cabo') fail(`${name}: campos humanos não entraram no relatório`);
  if (report.tests['A-ENV'].status !== expectEnv) fail(`${name}: A-ENV=${report.tests['A-ENV'].status}, esperado ${expectEnv}`);
  if (!['AP', 'INV', 'RP'].includes(report.tests['A-GL2'].status)) fail(`${name}: A-GL2=${report.tests['A-GL2'].status}`);
  if ((await page.getAttribute('body', 'data-report-valid')) !== 'true') fail(`${name}: a página não mostrou relatório válido`);
  if (errors.length) fail(`${name}: erros na página: ${errors.join(' | ')}`);
  console.log(`ok ${name}: A-ENV=${report.tests['A-ENV'].status} A-GL2=${report.tests['A-GL2'].status} (${report.tests['A-GL2'].renderer ?? 'sem renderer'})`);
  await page.close();
}

let browser;
try {
  await waitForServer(BASE, 20_000);
  const pw = await loadPlaywright();
  const chromium = pw.chromium ?? pw.default.chromium;
  browser = await chromium.launch();
  await scenario(browser, 'standalone', '', 'AP', 15_000);
  await scenario(browser, 'discord-falso', '?frame_id=f&instance_id=i&platform=desktop', 'RP', 25_000);
} catch (e) {
  fail(String(e));
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid);
  } catch {}
}
if (!process.exitCode) console.log('smoke: tudo certo');
