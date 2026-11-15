// Teste de fumaça: abre a build pronta (apps/probe/dist) num Chromium sem tela e confere que a sonda
// termina e produz um relatório válido (formato 2). Cenários:
//   1. standalone: WebAssembly, JSPI/Asyncify, IndexedDB e o save entre sessões (grava, recarrega,
//      encontra) funcionando fora do Discord;
//   2. URL com parâmetros do Discord falsos e sem Discord por trás: A-ENV = RP depois de 10 s;
//   3. CSP restrita, SEM permissão para WebAssembly: a sonda não trava, A-WASM-EMBED = RP e o
//      bloqueio aparece em A-CSP. (Simulação: a CSP real do Discord só é medida lá dentro.)
// Fora do Discord isso prova que o CÓDIGO funciona; não prova nada sobre o Discord.
// Também falha se a build contiver eval/new Function. Pré-requisito: `npm run build`.
// REQUIRE_EMCC=1 (CI) exige que os testes do Emscripten rodem e passem.
// PROBE_PW_MODULE aponta para outro pacote playwright (Chromium já instalado em outro lugar).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import validate from '../packages/report-schema/generated/validate-report-v2.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/probe/dist');
const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;
const REQUIRE_EMCC = process.env.REQUIRE_EMCC === '1';

function fail(msg) {
  console.error(`FALHOU: ${msg}`);
  process.exitCode = 1;
}

// 1) Nada de avaliação de código em tempo de execução na build (inclui o código do Emscripten).
for (const dir of ['assets', 'emcc']) {
  const d = join(dist, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((n) => /\.(m?js)$/.test(n))) {
    const src = readFileSync(join(d, f), 'utf8');
    if (/new Function\s*\(|\beval\s*\(/.test(src)) fail(`${dir}/${f} contém eval/new Function`);
  }
}
const html = readFileSync(join(dist, 'index.html'), 'utf8');
if (/(src|href)="\/(?!\/)/.test(html)) fail('index.html usa caminho absoluto; precisa ser relativo (base ./)');
if (!existsSync(join(dist, 'wasm/probe-url.wasm'))) fail('build sem wasm/probe-url.wasm');
if (REQUIRE_EMCC && !existsSync(join(dist, 'emcc/probe-jspi.mjs'))) fail('REQUIRE_EMCC=1, mas a build não tem emcc/');

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

async function openProbe(page, query, timeoutMs) {
  await page.goto(BASE + query);
  await page.waitForSelector('body[data-probe-done]', { timeout: timeoutMs });
  const done = await page.getAttribute('body', 'data-probe-done');
  if (done !== 'true') throw new Error(`sonda terminou com erro (${await page.textContent('#mode')})`);
  return JSON.parse(await page.inputValue('#json'));
}

function check(name, report, expect) {
  if (!validate(report)) fail(`${name}: relatório inválido ${JSON.stringify(validate.errors)}`);
  for (const [test, allowed] of Object.entries(expect)) {
    const st = report.tests[test]?.status;
    if (!allowed.includes(st)) fail(`${name}: ${test}=${st}, esperado ${allowed.join('/')} (${report.tests[test]?.detail ?? ''} ${report.tests[test]?.error ?? ''})`);
  }
  const t = report.tests;
  console.log(
    `ok ${name}: ` +
      Object.keys(expect).map((k) => `${k}=${t[k].status}`).join(' ') +
      ` | GL=${t['A-GL2'].status} EMCC=${t['A-JSPI-EMCC'].status}/${t['A-ASYNCIFY-EMCC'].status}`,
  );
}

const emcc = REQUIRE_EMCC ? ['AP'] : ['AP', 'SKIP'];

let browser;
try {
  await waitForServer(BASE, 20_000);
  const pw = await loadPlaywright();
  const chromium = pw.chromium ?? pw.default.chromium;
  browser = await chromium.launch();

  // Cenário 1: standalone + save entre sessões (grava, recarrega a página, encontra).
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let r = await openProbe(page, '', 20_000);
    await page.fill('input[name=device_label]', 'smoke');
    await page.selectOption('select[name=network]', 'cabo');
    r = JSON.parse(await page.inputValue('#json'));
    if (r.context.device_label !== 'smoke' || r.context.network !== 'cabo') fail('standalone: campos humanos não entraram no relatório');
    if (r.context.storage_context !== 'standalone') fail(`standalone: storage_context=${r.context.storage_context}`);
    check('standalone', r, {
      'A-ENV': ['AP'], 'A-WASM-EMBED': ['AP'], 'A-WASM-URL': ['AP'], 'A-CSP': ['AP'], 'A-WASM-FEAT': ['AP'],
      'A-JSPI-CORE': ['AP'], 'A-ASYNCIFY-CORE': ['AP'], 'A-JSPI-EMCC': emcc, 'A-ASYNCIFY-EMCC': emcc,
      'A-IDB': ['AP'], 'A-IDB-PERSIST': ['SKIP'], 'A-LAYOUT': ['AP'], 'A-VIS': ['AP'], 'I-BENCH': ['AP'],
    });
    if (r.tests['A-WASM-URL'].content_type !== 'application/wasm') fail(`standalone: .wasm servido como ${r.tests['A-WASM-URL'].content_type}`);
    if (!r.cleanup.performed) fail('standalone: limpeza do A-IDB não foi feita');
    await page.click('#persist-write');
    await page.waitForFunction(() => JSON.parse(document.querySelector('#json').value).tests['A-IDB-PERSIST'].marker_pending === true);
    r = await openProbe(page, '', 20_000); // "fecha e reabre" no mesmo contexto
    check('standalone-reaberto', r, { 'A-IDB-PERSIST': ['AP'] });
    if (!r.tests['A-IDB-PERSIST'].marker_deleted) fail('standalone-reaberto: marcador não foi apagado depois de confirmado');
    r = await openProbe(page, '', 20_000);
    check('standalone-terceira', r, { 'A-IDB-PERSIST': ['SKIP'] });
    if (errors.length) fail(`standalone: erros na página: ${errors.join(' | ')}`);
    await ctx.close();
  }

  // Cenário 2: parâmetros do Discord falsos, sem Discord por trás.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const r = await openProbe(page, '?frame_id=f&instance_id=i&platform=desktop', 30_000);
    check('discord-falso', r, { 'A-ENV': ['RP'], 'A-WASM-EMBED': ['AP'] });
    if (r.context.storage_context !== 'discord-web') fail(`discord-falso: storage_context=${r.context.storage_context}`);
    await ctx.close();
  }

  // Cenário 3: CSP restrita sem 'wasm-unsafe-eval'.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route(BASE, async (route) => {
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'" },
      });
    });
    const r = await openProbe(page, '', 30_000);
    check('csp-sem-wasm', r, { 'A-WASM-EMBED': ['RP'], 'A-WASM-URL': ['RP'], 'A-CSP': ['INV'], 'I-BENCH': ['SKIP'] });
    if (!r.tests['A-CSP'].violations.some((v) => v.category === 'wasm-eval' && v.disposition === 'enforce')) {
      fail(`csp-sem-wasm: bloqueio wasm-eval não registrado: ${JSON.stringify(r.tests['A-CSP'].violations)}`);
    }
    if (JSON.stringify(r.tests['A-CSP']).includes('http')) fail('csp-sem-wasm: A-CSP guardou URL');
    await ctx.close();
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid);
  } catch {}
}
if (!process.exitCode) console.log('smoke: tudo certo');
