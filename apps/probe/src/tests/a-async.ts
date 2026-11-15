// JSPI e Asyncify em dois níveis (plano F2 v2):
//   CORE: módulos escritos à mão (wasm/core) — mostra se o MECANISMO do navegador funciona.
//   EMCC: programa C compilado pelo Emscripten (wasm/emcc) — mostra se o RUNTIME do Emscripten,
//         que é o que o port usa, consegue pausar e retomar.
// Regra: um AP aqui prova só isso, para este programa minúsculo. Não prova que um jogo inteiro roda.
import { clip } from '../hash';
import type { AsyncResult } from '../report/types';

const errText = (e: unknown) => clip(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 300);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`sem resposta em ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

type WA = typeof WebAssembly & {
  Suspending?: new (fn: (...a: unknown[]) => Promise<unknown>) => unknown;
  promising?: (fn: unknown) => (...a: unknown[]) => Promise<unknown>;
};

export function hasJspi(wa: unknown = (globalThis as { WebAssembly?: unknown }).WebAssembly): boolean {
  const w = wa as WA | undefined;
  return !!w && typeof w.Suspending === 'function' && typeof w.promising === 'function';
}

// ---------- A-JSPI-CORE ----------
export async function runJspiCore(bytes: Uint8Array<ArrayBuffer>, wa: WA = WebAssembly as WA): Promise<AsyncResult> {
  if (!hasJspi(wa)) {
    return { status: 'RP', detail: 'O navegador não tem a API JSPI (WebAssembly.Suspending/promising).', api_present: false, result: null, ms: null, error: null };
  }
  const t0 = performance.now();
  try {
    const getv = new wa.Suspending!(async () => {
      await sleep(10);
      return 41;
    });
    const { instance } = await wa.instantiate(bytes, { env: { getv } } as WebAssembly.Imports);
    const run = wa.promising!((instance.exports as { run: unknown }).run);
    const r = Number(await withTimeout(run(), 5000));
    const ok = r === 42;
    return {
      status: ok ? 'AP' : 'INV',
      detail: ok ? 'JSPI: o módulo pausou esperando uma Promise e retomou com o valor certo.' : `JSPI retomou com valor errado (${r}).`,
      api_present: true, result: r, ms: performance.now() - t0, error: null,
    };
  } catch (e) {
    return { status: 'INV', detail: 'A API JSPI existe, mas o teste falhou.', api_present: true, result: null, ms: null, error: errText(e) };
  }
}

// ---------- A-ASYNCIFY-CORE ----------
// Mini-runtime de Asyncify: quando o WebAssembly chama env.sleep, a pilha é salva na memória
// (unwind); depois que a Promise resolve, a pilha é restaurada (rewind) e a execução continua.
interface AsyncifyExports {
  memory: WebAssembly.Memory;
  run(): number;
  asyncify_start_unwind(p: number): void;
  asyncify_stop_unwind(): void;
  asyncify_start_rewind(p: number): void;
  asyncify_stop_rewind(): void;
  asyncify_get_state(): number;
}
const DATA = 16; // estrutura do Asyncify: [início, fim] da área de pilha salva
const STACK_END = 1024;

// waitValue: valor que a Promise devolve (41 → resultado certo 42). Os testes usam outro valor para
// conferir que um resultado errado não é aprovado.
export async function runAsyncifyCore(bytes: Uint8Array<ArrayBuffer>, wa: typeof WebAssembly = WebAssembly, waitValue = 41): Promise<AsyncResult> {
  const t0 = performance.now();
  try {
    let ex!: AsyncifyExports;
    let pending: Promise<number> | null = null;
    let rewinding = false;
    let value = 0;
    const { instance } = await wa.instantiate(bytes, {
      env: {
        sleep: () => {
          if (rewinding) {
            ex.asyncify_stop_rewind();
            rewinding = false;
            return value;
          }
          const view = new Int32Array(ex.memory.buffer, DATA, 2);
          view[0] = DATA + 8;
          view[1] = STACK_END;
          ex.asyncify_start_unwind(DATA);
          pending = sleep(10).then(() => waitValue);
          return 0;
        },
      },
    });
    ex = instance.exports as unknown as AsyncifyExports;
    let r = ex.run();
    let rounds = 0;
    while (ex.asyncify_get_state() === 1) {
      ex.asyncify_stop_unwind();
      value = await withTimeout(pending!, 5000);
      rewinding = true;
      ex.asyncify_start_rewind(DATA);
      r = ex.run();
      if (++rounds > 3) throw new Error('Asyncify não terminou');
    }
    const ok = r === 42 && rounds === 1;
    return {
      status: ok ? 'AP' : 'RP',
      detail: ok ? 'Asyncify: o módulo salvou a pilha, esperou e retomou com o valor certo.' : `Asyncify terminou com valor errado (${r}).`,
      result: r, ms: performance.now() - t0, error: null,
    };
  } catch (e) {
    return { status: 'RP', detail: 'O teste de Asyncify falhou.', result: null, ms: null, error: errText(e) };
  }
}

// ---------- A-JSPI-EMCC / A-ASYNCIFY-EMCC ----------
interface EmccModule { ccall(name: string, ret: string, args: string[], vals: unknown[], opts?: { async?: boolean }): unknown }
type EmccFactory = (opts: Record<string, unknown>) => Promise<EmccModule>;

export async function readEmccVersion(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(new URL('emcc-version.txt', baseUrl).href, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    // O GitHub Pages devolve a página 404 em HTML; versão de verdade começa com "emcc".
    return text.startsWith('emcc') ? clip(text, 200) : null;
  } catch {
    return null;
  }
}

export async function runEmcc(kind: 'jspi' | 'asyncify', baseUrl: string, version: string | null): Promise<AsyncResult> {
  const label = kind === 'jspi' ? 'JSPI' : 'Asyncify';
  const base: AsyncResult = { status: 'SKIP', detail: '', emcc_version: version, result: null, ms: null, error: null };
  if (!version) return { ...base, detail: 'Esta build não tem os módulos do Emscripten (só a CI compila).' };
  if (kind === 'jspi' && !hasJspi()) {
    return { ...base, status: 'RP', api_present: false, detail: 'O navegador não tem JSPI; o build JSPI do Emscripten não roda aqui.' };
  }
  const t0 = performance.now();
  try {
    const url = new URL(`probe-${kind}.mjs`, baseUrl).href;
    const mod = (await import(/* @vite-ignore */ url)) as { default: EmccFactory };
    const Module = await withTimeout(
      mod.default({ locateFile: (p: string) => new URL(p, baseUrl).href, print: () => {}, printErr: () => {} }),
      10_000,
    );
    const r = Number(await withTimeout(Promise.resolve(Module.ccall('probe_run', 'number', ['number'], [20], { async: true })), 5000));
    const ok = r === 42;
    return {
      ...base,
      ...(kind === 'jspi' ? { api_present: true } : {}),
      status: ok ? 'AP' : 'RP',
      detail: ok
        ? `Emscripten ${label}: o programa C esperou o JavaScript assíncrono e retomou certo.`
        : `Emscripten ${label}: resultado errado (${r}).`,
      result: r, ms: performance.now() - t0,
    };
  } catch (e) {
    return {
      ...base,
      ...(kind === 'jspi' ? { api_present: true } : {}),
      status: kind === 'jspi' ? 'INV' : 'RP',
      detail: `Emscripten ${label}: o runtime falhou ao carregar ou rodar.`,
      error: errText(e),
    };
  }
}
