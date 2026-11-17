// Teste de fumaça: abre a build pronta (apps/probe/dist) num Chromium sem tela e confere que a sonda
// termina e produz um relatório válido (formato 6). Cenários:
//   1. standalone: WebAssembly, JSPI/Asyncify, IndexedDB e o save entre sessões (grava, recarrega,
//      encontra) funcionando fora do Discord;
//   2. URL com parâmetros do Discord falsos e sem Discord por trás: A-ENV = RP depois de 10 s;
//   3. CSP restrita, SEM permissão para WebAssembly: a sonda não trava, A-WASM-EMBED = RP e o
//      bloqueio aparece em A-CSP. (Simulação: a CSP real do Discord só é medida lá dentro.)
//   4. Interativos (F2b) com teclado, toque de vários dedos, tela cheia, áudio e os dois arquivos.
//      O arquivo de 3 GiB é esparso, criado numa pasta temporária fora do repositório e apagado no
//      fim; nunca vira artefato. O controle não é simulável: espera-se INV (API sem controle).
//   5. Rede (F3a): 5 conexões de eco contra um servidor SIMULADO pelo próprio Playwright.
//   6. Eco contínuo (F3b): confirmação em dois passos, ~4 s a 60 Hz e "Parar" (INV, parado pela
//      pessoa), contra o mesmo servidor simulado. Os 62 s completos são testados com relógio falso
//      nos testes unitários e contra o servidor real em 127.0.0.1 nos testes de contrato.
// Em TODOS os cenários o endereço do servidor real (sonda.kingszin.com.br) é interceptado: a CI nunca
// fala com a VM, nem gasta admissões dela.
// Fora do Discord isso prova que o CÓDIGO funciona; não prova nada sobre o Discord.
// Também falha se a build contiver eval/new Function. Pré-requisito: `npm run build`.
// REQUIRE_EMCC=1 (CI) exige que os testes do Emscripten rodem e passem.
// PROBE_PW_MODULE aponta para outro pacote playwright (Chromium já instalado em outro lugar).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { create as createLarge } from './criar-arquivo-teste.mjs';
import validate from '../packages/report-schema/generated/validate-report-v6.mjs';

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

// Servidor da F3 simulado. Responde como o real (health, admissão com bilhete, eco por WebSocket) e
// conta o que recebeu. Qualquer outra coisa para o host real vira 404: nada sai para a internet.
const SONDA = 'https://sonda.kingszin.com.br';
const TICKET = 'fedcba9876543210fedcba9876543210';
async function fakeServer(ctx, { open }) {
  const seen = { health: 0, session: 0, ws: 0, bodies: [] };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST' };
  await ctx.route(`${SONDA}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (path === '/net/health' && req.method() === 'GET') {
      seen.health++;
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ aberto: open, fecha_em: null, motivo: 'simulado', tetos: { sessoes_simultaneas: 4 }, uso_do_dia: null }) });
    }
    if (path === '/net/session' && req.method() === 'POST') {
      seen.session++;
      seen.bodies.push(req.postData());
      if (!open) return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: '{"erro":"rede fechada"}' });
      return route.fulfill({ status: 201, headers: cors, contentType: 'application/json', body: JSON.stringify({ bilhete: TICKET, bilhete_vale_ate: 'x', duracao_s: 5, mensagens_reservadas: 330 }) });
    }
    return route.fulfill({ status: 404, headers: cors, body: '' });
  });
  await ctx.routeWebSocket(/^wss:\/\/sonda\.kingszin\.com\.br\//, (ws) => {
    seen.ws++;
    if (!open || !ws.url().includes(`bilhete=${TICKET}`)) return ws.close({ code: 1008, reason: 'recusado' });
    ws.onMessage((m) => ws.send(Buffer.from(m))); // como o servidor real: eco em binário
  });
  return seen;
}

async function waitNet(page, key) {
  await page.waitForFunction((k) => JSON.parse(document.querySelector('#json').value).tests[k].detail !== 'verificando…', key, { timeout: 15_000 });
  return JSON.parse(await page.inputValue('#json'));
}

let browser;
try {
  await waitForServer(BASE, 20_000);
  const pw = await loadPlaywright();
  const chromium = pw.chromium ?? pw.default.chromium;
  browser = await chromium.launch();

  // Cenário 1: standalone + save entre sessões (grava, recarrega a página, encontra).
  {
    const ctx = await browser.newContext();
    const seen = await fakeServer(ctx, { open: false });
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
    await page.waitForFunction(() => JSON.parse(document.querySelector('#json').value).tests['A-IDB-PERSIST'].state_now === 'pending');
    r = await openProbe(page, '', 20_000); // "fecha e reabre" no mesmo contexto
    check('standalone-reaberto', r, { 'A-IDB-PERSIST': ['AP'] });
    if (r.tests['A-IDB-PERSIST'].state_now !== 'confirmed') fail('standalone-reaberto: estado não virou confirmed');
    r = await openProbe(page, '', 20_000);
    check('standalone-terceira', r, { 'A-IDB-PERSIST': ['SKIP'] });
    // Regressão da F2a: com recibo de confirmação, "Gravei antes e ele sumiu" fica desabilitado.
    if (r.tests['A-IDB-PERSIST'].state_at_open !== 'confirmed') fail('standalone-terceira: recibo de confirmação não encontrado');
    if (!(await page.isDisabled('#persist-missing'))) fail('standalone-terceira: botão "sumiu" deveria estar desabilitado');
    if (!['confirmed', 'software', 'unknown'].includes(r.tests['A-GL2'].gpu_acceleration_status)) fail('A-GL2 sem gpu_acceleration_status');
    r = await waitNet(page, 'N-HTTP');
    check('standalone-rede', r, { 'N-HTTP': ['AP'], 'N-PATH': ['SKIP'], 'N-WS-OPEN': ['SKIP'] });
    if (r.tests['N-HTTP'].route !== 'absoluto' || r.tests['N-HTTP'].server_region !== 'us-phoenix-1') fail('standalone-rede: rota/região erradas');
    if (seen.session !== 0) fail('standalone-rede: admissão pedida sem apertar o botão');
    if (errors.length) fail(`standalone: erros na página: ${errors.join(' | ')}`);
    await ctx.close();
  }

  // Cenário 2: parâmetros do Discord falsos, sem Discord por trás.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await fakeServer(ctx, { open: true });
    let r = await openProbe(page, '?frame_id=f&instance_id=i&platform=desktop', 30_000);
    check('discord-falso', r, { 'A-ENV': ['RP'], 'A-WASM-EMBED': ['AP'] });
    // Sem Discord por trás, /net/health cai no servidor de preview (não é a sonda): N-PATH = RP.
    r = await waitNet(page, 'N-PATH');
    check('discord-falso-rede', r, { 'N-PATH': ['RP'], 'N-HTTP': ['RP'], 'N-WS-OPEN': ['SKIP'] });
    if (!r.tests['N-PATH'].routes.every((x) => x.tested)) fail('discord-falso-rede: nem todos os caminhos foram testados');
    if (r.context.storage_context !== 'discord-web') fail(`discord-falso: storage_context=${r.context.storage_context}`);
    await ctx.close();
  }

  // Cenário 3: CSP restrita sem 'wasm-unsafe-eval'.
  {
    const ctx = await browser.newContext();
    await fakeServer(ctx, { open: false });
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
  // Cenário 4: testes interativos.
  {
    const tmp = mkdtempSync(join(tmpdir(), 'bt3probe-smoke-'));
    try {
      const largePath = createLarge(tmp);
      const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 900 } });
      await fakeServer(ctx, { open: false });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await openProbe(page, '', 20_000);
      const btn = (cardId, name) => page.locator(`#card-${cardId}`).getByRole('button', { name, exact: true });

      // Teclado: teclas soltas, 2 combinações e Esc por último.
      await btn('A-KEY', 'Começar').click();
      for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter']) {
        await page.keyboard.press(k);
      }
      for (const combo of [['KeyW', 'KeyD', 'Space'], ['KeyW', 'Shift', 'Space']]) {
        for (const k of combo) await page.keyboard.down(k);
        for (const k of combo) await page.keyboard.up(k);
      }
      await btn('A-KEY', 'Concluir teclas').click();
      await btn('A-KEY', 'Testar Esc (5 s)').click();
      await page.keyboard.press('Escape');

      // Controle: sem controle na CI → INV ("API existe, controle não apareceu").
      await btn('A-PAD', 'Começar').click();
      await btn('A-PAD', 'Concluir').click();

      // Toque: 2 dedos juntos e um arrasto, via eventos de toque do Chromium.
      await page.locator('#touch-area').scrollIntoViewIfNeeded();
      const box = await page.locator('#touch-area').boundingBox();
      const cdp = await ctx.newCDPSession(page);
      const pt = (x, y, id) => ({ x: box.x + x, y: box.y + y, id });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(40, 60, 1), pt(120, 60, 2)] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(20, 90, 3)] });
      for (let x = 40; x <= 220; x += 30) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(x, 90, 3)] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await btn('A-TOUCH', 'Concluir').click();

      // Tela cheia (AP ou RP: no Chromium sem tela pode variar) e áudio.
      await btn('A-FS', 'Tela cheia').click();
      await btn('A-AUDIO', 'Tocar som').click();
      await btn('A-AUDIO', 'Ouvi').click();

      // Arquivos: um comum (10 KB) e o de teste de 3 GiB com marcadores.
      await page.setInputFiles('#file-basic', { name: 'foto-pessoal.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(10_000, 7) });
      await page.setInputFiles('#file-large', largePath);
      await page.waitForFunction(() => {
        const t = JSON.parse(document.querySelector('#json').value).tests;
        return t['A-FILE-LARGE'].status !== 'SKIP' && t['A-FILE-BASIC'].status !== 'SKIP' && t['A-KEY'].escape_received !== null;
      }, undefined, { timeout: 20_000 });
      await page.waitForTimeout(2600); // a tela cheia sai sozinha em 2 s
      const r = JSON.parse(await page.inputValue('#json'));
      check('interativos', r, {
        'A-KEY': ['AP'], 'A-PAD': ['INV'], 'A-TOUCH': ['AP'], 'A-FS': ['AP', 'RP'], 'A-AUDIO': ['AP'],
        'A-FILE-BASIC': ['AP'], 'A-FILE-LARGE': ['AP'],
      });
      const json = JSON.stringify(r);
      if (json.includes('foto-pessoal') || json.includes('bt3probe-large')) fail('interativos: nome de arquivo foi para o relatório');
      if (errors.length) fail(`interativos: erros na página: ${errors.join(' | ')}`);
      await ctx.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  // Cenário 5: rede (F3a) com servidor simulado aberto: 5 conexões de eco.
  {
    const ctx = await browser.newContext();
    const seen = await fakeServer(ctx, { open: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openProbe(page, '', 20_000);
    await waitNet(page, 'N-HTTP');
    await page.locator('#card-NET').getByRole('button', { name: 'Testar 5 conexões', exact: true }).click();
    await page.waitForFunction(() => {
      const t = JSON.parse(document.querySelector('#json').value).tests['N-WS-OPEN'];
      return t.ran && !t.detail.startsWith('em andamento');
    }, undefined, { timeout: 30_000 });
    const r = JSON.parse(await page.inputValue('#json'));
    check('rede', r, { 'N-HTTP': ['AP'], 'N-PATH': ['SKIP'], 'N-WS-OPEN': ['AP'] });
    const w = r.tests['N-WS-OPEN'];
    if (w.opened !== 5 || w.echoed !== 5) fail(`rede: abertas ${w.opened}, eco ${w.echoed}`);
    if (seen.session !== 5 || seen.ws !== 5) fail(`rede: servidor viu ${seen.session} admissões e ${seen.ws} WebSockets`);
    if (!seen.bodies.every((b) => b === '{"kind":"echo","duration_s":5}')) fail(`rede: corpo de admissão inesperado ${seen.bodies[0]}`);
    if (JSON.stringify(r).includes(TICKET)) fail('rede: bilhete foi para o relatório');
    if (errors.length) fail(`rede: erros na página: ${errors.join(' | ')}`);
    await ctx.close();
  }
  // Cenário 6: eco contínuo (F3b) com o servidor simulado: confirma, mede ~4 s e para.
  {
    const ctx = await browser.newContext();
    const seen = await fakeServer(ctx, { open: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openProbe(page, '', 20_000);
    await waitNet(page, 'N-HTTP');
    await page.fill('#echo-pair', 'PC-1');
    await page.click('#echo-start');
    if (seen.session !== 0) fail('eco: admissão pedida antes da confirmação');
    await page.click('#echo-confirm');
    await page.waitForFunction(() => document.querySelector('#live-ECHO').textContent.startsWith('Medindo… 4'), undefined, { timeout: 20_000 });
    await page.click('#echo-stop');
    await page.waitForFunction(() => {
      const t = JSON.parse(document.querySelector('#json').value).tests['N-ECHO'];
      return t.ran && t.status !== 'SKIP';
    }, undefined, { timeout: 15_000 });
    const r = JSON.parse(await page.inputValue('#json'));
    check('eco', r, { 'N-HTTP': ['AP'], 'N-ECHO': ['INV'] });
    const e = r.tests['N-ECHO'];
    if (!e.connection.stopped_by_user) fail('eco: não registrou a parada pela pessoa');
    if (e.pair_label !== 'PC-1' || e.route !== 'absoluto') fail(`eco: rótulo/rota errados (${e.pair_label}, ${e.route})`);
    if (e.sent + e.warmup.sent < 150) fail(`eco: só ${e.sent + e.warmup.sent} envios em ~4 s`);
    if (e.unexpected !== 0 || e.sent - e.received > 3) fail(`eco: enviados ${e.sent}, recebidos ${e.received}, inesperados ${e.unexpected}`);
    if (e.rtt.p50 === null || e.cadence.rate_hz === null) fail('eco: sem RTT ou cadência');
    if (seen.session !== 1 || seen.ws !== 1) fail(`eco: servidor viu ${seen.session} admissões e ${seen.ws} WebSockets`);
    if (seen.bodies[0] !== '{"kind":"echo","duration_s":65}') fail(`eco: corpo de admissão inesperado ${seen.bodies[0]}`);
    if (JSON.stringify(r).includes(TICKET)) fail('eco: bilhete foi para o relatório');
    if (errors.length) fail(`eco: erros na página: ${errors.join(' | ')}`);
    console.log(`   eco: ${e.sent} enviados (+${e.warmup.sent} aquecimento), RTT p50 ${e.rtt.p50} ms, ${e.cadence.rate_hz} msg/s`);
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
