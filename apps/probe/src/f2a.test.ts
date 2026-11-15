import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASYNCIFY_WASM, CORE_WASM, FEATURE_WASM, JSPI_WASM } from './generated/wasm-modules';
import { FEATURE_KEYS } from './report/types';
import { hasJspi, readEmccVersion, runAsyncifyCore, runEmcc, runJspiCore } from './tests/a-async';
import { classifyGl2 } from './tests/a-gl2';
import { openDb, PersistTest, runIdbReadWrite } from './tests/a-idb';
import {
  classifyWasmUrl, cspCategory, CspCollector, fromB64, jsBench, runBench, runWasmEmbed, runWasmFeat, runWasmUrl,
} from './tests/a-wasm';

afterEach(() => vi.unstubAllGlobals());

describe('A-GL2: dica de aceleração de hardware', () => {
  it('INV por software traz a dica; os outros casos não', () => {
    expect(classifyGl2(true, true, 'software').detail).toContain('Aceleração de hardware');
    expect(classifyGl2(true, true, 'confirmed').detail).not.toContain('Aceleração de hardware');
  });
});

describe('A-WASM-EMBED e I-BENCH', () => {
  it('compila o módulo embutido e calcula certo', async () => {
    const { result, exports } = await runWasmEmbed(fromB64(CORE_WASM));
    expect(result.status).toBe('AP');
    expect(result.result_ok).toBe(true);
    expect(exports).not.toBeNull();
  });
  it('bytes corrompidos dão RP com o erro registrado', async () => {
    const bad = fromB64(CORE_WASM);
    bad[1] = 0; // estraga o "\0asm" do cabeçalho
    const { result } = await runWasmEmbed(bad);
    expect(result.status).toBe('RP');
    expect(result.error).toMatch(/CompileError/);
  });
  it('benchmark: WebAssembly e JavaScript chegam ao mesmo número (é só informativo)', async () => {
    const { exports } = await runWasmEmbed(fromB64(CORE_WASM));
    expect(exports!.bench(1000)).toBe(jsBench(1000));
    const b = runBench(exports, 100_000);
    expect(b.same_result).toBe(true);
    expect(b.status).toBe('AP');
    expect(runBench(null).status).toBe('SKIP');
  });
});

describe('A-WASM-URL', () => {
  const bytes = fromB64(CORE_WASM);
  const stub = (status: number, type: string) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(status === 200 ? bytes : 'não achei', { status, headers: { 'content-type': type } })));
  it('tipo application/wasm → streaming funciona → AP', async () => {
    stub(200, 'application/wasm');
    const r = await runWasmUrl('https://exemplo/probe-url.wasm');
    expect(r).toMatchObject({ status: 'AP', streaming_ok: true, fallback_ok: null, http_status: 200, content_type: 'application/wasm', bytes: bytes.length });
  });
  it('tipo errado → streaming falha, alternativo funciona → INV', async () => {
    stub(200, 'application/octet-stream');
    const r = await runWasmUrl('https://exemplo/probe-url.wasm');
    expect(r).toMatchObject({ status: 'INV', streaming_ok: false, fallback_ok: true });
  });
  it('404 → RP', async () => {
    stub(404, 'text/html');
    expect((await runWasmUrl('https://exemplo/x.wasm')).status).toBe('RP');
  });
  it('classificação', () => {
    expect(classifyWasmUrl(false, false, false).status).toBe('RP');
    expect(classifyWasmUrl(true, true, false).status).toBe('AP');
    expect(classifyWasmUrl(true, false, true).status).toBe('INV');
    expect(classifyWasmUrl(true, false, false).status).toBe('RP');
  });
});

describe('A-CSP (sem guardar URLs)', () => {
  it('categoriza o recurso bloqueado', () => {
    const o = 'https://123.discordsays.com';
    expect(cspCategory('wasm-eval', o)).toBe('wasm-eval');
    expect(cspCategory('eval', o)).toBe('eval');
    expect(cspCategory('inline', o)).toBe('inline');
    expect(cspCategory('data', o)).toBe('data');
    expect(cspCategory('blob', o)).toBe('blob');
    expect(cspCategory('https://123.discordsays.com/wasm/x.wasm', o)).toBe('mesma-origem');
    expect(cspCategory('https://cdn.exemplo.com/a.js', o)).toBe('outra-origem');
    expect(cspCategory('???', o)).toBe('outro');
  });
  it('agrupa repetidos, sem bloqueio = AP, com bloqueio = INV', () => {
    const c = new CspCollector();
    expect(c.result().status).toBe('AP');
    c.add('script-src', 'enforce', 'wasm-eval');
    c.add('script-src', 'enforce', 'wasm-eval');
    c.add('connect-src', 'report', 'outra-origem');
    const r = c.result();
    expect(r.status).toBe('INV');
    expect(r.violations).toEqual([
      { directive: 'script-src', disposition: 'enforce', category: 'wasm-eval', count: 2 },
      { directive: 'connect-src', disposition: 'report', category: 'outra-origem', count: 1 },
    ]);
    expect(JSON.stringify(r)).not.toContain('http');
  });
});

describe('A-WASM-FEAT', () => {
  it('valida cada recurso com um módulo próprio', () => {
    const r = runWasmFeat(FEATURE_WASM);
    expect(Object.keys(r.features).sort()).toEqual([...FEATURE_KEYS].sort());
    // Node 22 tem todos estes recursos.
    for (const k of FEATURE_KEYS) expect(r.features[k], k).toBe(true);
    expect(r.status).toBe('AP');
  });
  it('módulo inválido conta como recurso ausente', () => {
    const r = runWasmFeat({ ...FEATURE_WASM, simd: 'AAAA' });
    expect(r.features.simd).toBe(false);
    expect(r.detail).toContain('simd');
  });
  it('sem WebAssembly: SKIP', () => {
    expect(runWasmFeat(FEATURE_WASM, {} as typeof globalThis).status).toBe('SKIP');
  });
});

describe('A-JSPI-CORE / A-ASYNCIFY-CORE', () => {
  it('Asyncify: salva a pilha, espera a Promise e retoma com 42', async () => {
    const r = await runAsyncifyCore(fromB64(ASYNCIFY_WASM));
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ status: 'AP', result: 42 });
  });
  it('Asyncify que retoma com valor errado é RP (não aprova à toa)', async () => {
    const r = await runAsyncifyCore(fromB64(ASYNCIFY_WASM), WebAssembly, 10);
    expect(r).toMatchObject({ status: 'RP', result: 11 });
  });
  it('Asyncify com módulo sem a transformação falha (não aprova à toa)', async () => {
    const r = await runAsyncifyCore(fromB64(JSPI_WASM));
    expect(r.status).toBe('RP');
  });
  it('sem a API JSPI: RP com api_present=false', async () => {
    const r = await runJspiCore(fromB64(JSPI_WASM), { ...WebAssembly } as typeof WebAssembly);
    expect(hasJspi({})).toBe(false);
    expect(r).toMatchObject({ status: 'RP', api_present: false });
  });
  it.runIf(hasJspi())('com a API JSPI: AP com 42', async () => {
    expect(await runJspiCore(fromB64(JSPI_WASM))).toMatchObject({ status: 'AP', result: 42 });
  });
});

describe('A-*-EMCC', () => {
  it('build sem Emscripten: versão nula e os dois testes em SKIP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>404</html>', { status: 404 })));
    expect(await readEmccVersion('https://exemplo/emcc/')).toBeNull();
    expect((await runEmcc('jspi', 'https://exemplo/emcc/', null)).status).toBe('SKIP');
    expect((await runEmcc('asyncify', 'https://exemplo/emcc/', null)).status).toBe('SKIP');
  });
  it('a página 404 do GitHub Pages não conta como versão', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html>', { status: 200 })));
    expect(await readEmccVersion('https://exemplo/emcc/')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('emcc (Emscripten) 6.0.13\n', { status: 200 })));
    expect(await readEmccVersion('https://exemplo/emcc/')).toBe('emcc (Emscripten) 6.0.13');
  });
  it('navegador sem JSPI: o build JSPI do Emscripten é RP sem nem tentar', async () => {
    if (hasJspi()) return;
    expect((await runEmcc('jspi', 'https://exemplo/emcc/', 'emcc 6.0.13')).status).toBe('RP');
  });
});

describe('A-IDB', () => {
  it('grava 1 KB, lê igual e apaga', async () => {
    const r = await runIdbReadWrite(new IDBFactory());
    expect(r.deleted).toBe(true);
    expect(r.result).toMatchObject({ status: 'AP', read_write_ok: true });
  });
  it('sem IndexedDB: RP', async () => {
    expect((await runIdbReadWrite(undefined)).result.status).toBe('RP');
  });
});

describe('A-IDB-PERSIST (máquina de estados)', () => {
  it('fluxo completo: none → gravar (pending) → reabrir (confirmed, AP) → reabrir (SKIP com recibo)', async () => {
    const idb = new IDBFactory();
    let now = 1_000_000;
    const s1 = new PersistTest(idb, 'discord-desktop-app', () => now);
    expect(await s1.check()).toMatchObject({ status: 'SKIP', state_at_open: 'none', state_now: 'none' });
    expect(await s1.write()).toMatchObject({ status: 'SKIP', state_now: 'pending', marker_written_this_session: true });
    now += 42_000;
    const s2 = new PersistTest(idb, 'discord-desktop-app', () => now);
    expect(await s2.check()).toMatchObject({
      status: 'AP', state_at_open: 'pending', state_now: 'confirmed', marker_age_s: 42, last_confirmed_age_s: 0,
    });
    now += 60_000;
    const s3 = new PersistTest(idb, 'discord-desktop-app', () => now);
    expect(await s3.check()).toMatchObject({ status: 'SKIP', state_at_open: 'confirmed', last_confirmed_age_s: 60 });
  });

  it('regressão da F2a: depois de confirmado, "sumiu" NÃO vira RP', async () => {
    const idb = new IDBFactory();
    await new PersistTest(idb, 'discord-mobile').write();
    await new PersistTest(idb, 'discord-mobile').check(); // confirma
    const t = new PersistTest(idb, 'discord-mobile');
    await t.check();
    expect(t.canReportMissing()).toBe(false);
    expect(t.reportMissing()).toMatchObject({ status: 'SKIP', user_reported_missing: false });
  });

  it('uma confirmação antiga não aprova uma tentativa nova', async () => {
    const idb = new IDBFactory();
    await new PersistTest(idb, 'discord-web').write();
    await new PersistTest(idb, 'discord-web').check(); // confirmed
    const again = new PersistTest(idb, 'discord-web');
    await again.check();
    expect(await again.write()).toMatchObject({ status: 'SKIP', state_now: 'pending' });
    // Mesma sessão: continua pendente, não aprova.
    expect(again.result().status).toBe('SKIP');
    // Só a próxima abertura confirma a tentativa nova.
    expect((await new PersistTest(idb, 'discord-web').check()).state_at_open).toBe('pending');
  });

  it('apagar a pedido vira cancelled; na reabertura não aprova nem aceita "sumiu"', async () => {
    const idb = new IDBFactory();
    const t = new PersistTest(idb, 'standalone');
    await t.check();
    await t.write();
    expect(await t.remove()).toMatchObject({ status: 'SKIP', state_now: 'cancelled' });
    const u = new PersistTest(idb, 'standalone');
    expect(await u.check()).toMatchObject({ status: 'SKIP', state_at_open: 'cancelled' });
    expect(u.canReportMissing()).toBe(false);
  });

  it('sem registro nenhum: "sumiu" é aceito (RP) e não pode ser repetido', async () => {
    const t = new PersistTest(new IDBFactory(), 'discord-mobile');
    await t.check();
    expect(t.canReportMissing()).toBe(true);
    expect(t.reportMissing()).toMatchObject({ status: 'RP', user_reported_missing: true });
    expect(t.canReportMissing()).toBe(false);
  });

  it('quem gravou nesta sessão não pode marcar "sumiu"', async () => {
    const t = new PersistTest(new IDBFactory(), 'discord-mobile');
    await t.check();
    await t.write();
    expect(t.canReportMissing()).toBe(false);
  });

  it('contextos não se misturam', async () => {
    const idb = new IDBFactory();
    await new PersistTest(idb, 'discord-desktop-app').write();
    expect((await new PersistTest(idb, 'standalone').check()).state_at_open).toBe('none');
    expect((await new PersistTest(idb, 'discord-web').check()).state_at_open).toBe('none');
    expect((await new PersistTest(idb, 'discord-desktop-app').check()).status).toBe('AP');
  });

  it('"Apagar" só vale com teste pendente: não transforma um recibo em cancelled', async () => {
    const idb = new IDBFactory();
    await new PersistTest(idb, 'discord-web').write();
    await new PersistTest(idb, 'discord-web').check(); // confirmed
    const t = new PersistTest(idb, 'discord-web');
    await t.check();
    expect((await t.remove()).state_now).toBe('confirmed');
    expect((await new PersistTest(idb, 'discord-web').check()).state_at_open).toBe('confirmed');
  });

  it('registro com contexto diferente do esperado é ignorado', async () => {
    const idb = new IDBFactory();
    const db = await openDb(idb);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ state: 'pending', ctx: 'discord-web', created_at: 0 }, 'persist:standalone');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect((await new PersistTest(idb, 'standalone').check()).state_at_open).toBe('none');
  });

  it('falha ao gravar o recibo: persistência comprovada, mas recibo NÃO declarado como guardado', async () => {
    const idb = new IDBFactory();
    await new PersistTest(idb, 'discord-mobile', () => 1_000).write();
    const t = new PersistTest(idb, 'discord-mobile', () => 31_000);
    const spy = vi.spyOn(t as unknown as { save: () => Promise<unknown> }, 'save').mockRejectedValueOnce(new Error('cota cheia'));
    const r = await t.check();
    expect(spy).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ status: 'AP', state_now: 'pending', receipt_saved: false, marker_age_s: 30 });
    expect(r.detail).toContain('NÃO foi gravado');
    expect(r.detail).not.toContain('Recibo guardado');
    // O registro continua pendente: a próxima abertura confirma de novo, agora com recibo.
    expect(await new PersistTest(idb, 'discord-mobile', () => 40_000).check()).toMatchObject({ status: 'AP', receipt_saved: true, state_now: 'confirmed' });
  });

  it('recibo gravado com sucesso: receipt_saved = true', async () => {
    const idb = new IDBFactory();
    await new PersistTest(idb, 'discord-web').write();
    expect(await new PersistTest(idb, 'discord-web').check()).toMatchObject({ receipt_saved: true, legacy_migrated: false });
  });

  async function putRaw(idb: IDBFactory, key: string, value: unknown): Promise<void> {
    const db = await openDb(idb);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function getRaw(idb: IDBFactory, key: string): Promise<unknown> {
    const db = await openDb(idb);
    const v = await new Promise((resolve, reject) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return v;
  }

  it('migração: marcador pendente da versão 0.2.0 (chave antiga) é encontrado, confirmado e a chave antiga apagada', async () => {
    const idb = new IDBFactory();
    await putRaw(idb, 'persist-marker:discord-desktop-app', { id: 'x', created_at: 1_000, ctx: 'discord-desktop-app' });
    const r = await new PersistTest(idb, 'discord-desktop-app', () => 61_000).check();
    expect(r).toMatchObject({ status: 'AP', legacy_migrated: true, state_at_open: 'pending', state_now: 'confirmed', marker_age_s: 60 });
    expect(r.detail).toContain('0.2.0');
    expect(await getRaw(idb, 'persist-marker:discord-desktop-app')).toBeUndefined();
    expect(await new PersistTest(idb, 'discord-desktop-app').check()).toMatchObject({ state_at_open: 'confirmed', legacy_migrated: false });
  });

  it('migração não mistura contextos nem passa por cima de um registro novo', async () => {
    const idb = new IDBFactory();
    await putRaw(idb, 'persist-marker:discord-web', { id: 'x', created_at: 1_000, ctx: 'discord-web' });
    expect((await new PersistTest(idb, 'standalone').check()).state_at_open).toBe('none');
    await putRaw(idb, 'persist-marker:standalone', { id: 'y', created_at: 1_000, ctx: 'discord-mobile' });
    expect(await new PersistTest(idb, 'standalone').check()).toMatchObject({ state_at_open: 'none', legacy_migrated: false });
    await putRaw(idb, 'persist:discord-web', { state: 'cancelled', ctx: 'discord-web', created_at: 5, cancelled_at: 6 });
    expect(await new PersistTest(idb, 'discord-web').check()).toMatchObject({ state_at_open: 'cancelled', legacy_migrated: false });
  });

  it('sem IndexedDB: RP', async () => {
    expect((await new PersistTest(undefined, 'standalone').check()).status).toBe('RP');
  });
});
