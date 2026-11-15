// Testes de WebAssembly da F2a: compilar embutido (A-WASM-EMBED), carregar por URL (A-WASM-URL),
// recursos extras (A-WASM-FEAT), bloqueios de CSP (A-CSP) e uma conta informativa (I-BENCH).
// Todos os módulos são próprios e minúsculos (wasm/core/*.wat). Nada de jogo.
import { clip } from '../hash';
import type {
  BenchResult, CspCategory, CspResult, CspViolation, FeatureKey, WasmEmbedResult, WasmFeatResult, WasmUrlResult,
} from '../report/types';
import { FEATURE_KEYS } from '../report/types';

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const errText = (e: unknown) => clip(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 300);

interface CoreExports { add(a: number, b: number): number; bench(n: number): number }

// ---------- A-CSP ----------
// Registra bloqueios da Content Security Policy sem guardar URLs: só a diretiva, se foi aplicado ou
// só relatado, e uma categoria do recurso.
export function cspCategory(blockedURI: string, pageOrigin: string): CspCategory {
  const b = blockedURI.trim().toLowerCase();
  if (b === 'wasm-eval') return 'wasm-eval';
  if (b === 'eval') return 'eval';
  if (b === 'inline' || b === '') return 'inline';
  if (b.startsWith('data')) return 'data';
  if (b.startsWith('blob')) return 'blob';
  try {
    return new URL(blockedURI).origin === pageOrigin ? 'mesma-origem' : 'outra-origem';
  } catch {
    return 'outro';
  }
}

export class CspCollector {
  private map = new Map<string, CspViolation>();
  add(directive: string, disposition: string, category: CspCategory): void {
    const disp: CspViolation['disposition'] = disposition === 'enforce' || disposition === 'report' ? disposition : 'desconhecido';
    const dir = (directive || 'desconhecida').slice(0, 80);
    const key = `${dir}|${disp}|${category}`;
    const cur = this.map.get(key);
    if (cur) cur.count++;
    else if (this.map.size < 50) this.map.set(key, { directive: dir, disposition: disp, category, count: 1 });
  }
  listen(win: Window): void {
    win.addEventListener('securitypolicyviolation', (e) => {
      this.add(e.effectiveDirective || e.violatedDirective, e.disposition, cspCategory(e.blockedURI, win.location.origin));
    });
  }
  result(): CspResult {
    const violations = [...this.map.values()];
    if (violations.length === 0) return { status: 'AP', detail: 'Nenhum bloqueio de CSP durante a sonda.', violations };
    const enforced = violations.filter((v) => v.disposition === 'enforce').reduce((n, v) => n + v.count, 0);
    return {
      status: 'INV',
      detail: `${violations.reduce((n, v) => n + v.count, 0)} bloqueio(s) de CSP registrados (${enforced} aplicados). Ver lista.`,
      violations,
    };
  }
}

// ---------- A-WASM-EMBED ----------
export async function runWasmEmbed(bytes: Uint8Array<ArrayBuffer>): Promise<{ result: WasmEmbedResult; exports: CoreExports | null }> {
  if (typeof WebAssembly !== 'object') {
    return { result: { status: 'RP', detail: 'Este navegador não tem WebAssembly.', result_ok: false, compile_ms: null, error: null }, exports: null };
  }
  const t0 = performance.now();
  try {
    const { instance } = await WebAssembly.instantiate(bytes);
    const ms = performance.now() - t0;
    const ex = instance.exports as unknown as CoreExports;
    const ok = ex.add(2, 40) === 42;
    return {
      result: {
        status: ok ? 'AP' : 'RP',
        detail: ok ? `WebAssembly embutido compilou e calculou certo (${ms.toFixed(1)} ms).` : 'Compilou, mas a conta deu errado.',
        result_ok: ok, compile_ms: ms, error: null,
      },
      exports: ok ? ex : null,
    };
  } catch (e) {
    return {
      result: {
        status: 'RP',
        detail: 'Compilação de WebAssembly bloqueada ou falhou (ver A-CSP).',
        result_ok: false, compile_ms: null, error: errText(e),
      },
      exports: null,
    };
  }
}

// ---------- A-WASM-URL ----------
export function classifyWasmUrl(httpOk: boolean, streamingOk: boolean, fallbackOk: boolean): { status: WasmUrlResult['status']; detail: string } {
  if (!httpOk) return { status: 'RP', detail: 'O arquivo .wasm não foi baixado pela URL da Activity.' };
  if (streamingOk) return { status: 'AP', detail: 'Arquivo .wasm baixado e compilado em streaming (caminho normal do Emscripten).' };
  if (fallbackOk) return { status: 'INV', detail: 'Só funcionou sem streaming (tipo do arquivo ou proxy). O jogo precisaria do caminho alternativo.' };
  return { status: 'RP', detail: 'Arquivo .wasm baixado, mas não compilou.' };
}

export async function runWasmUrl(url: string): Promise<WasmUrlResult> {
  const base: WasmUrlResult = {
    status: 'RP', detail: '', http_status: null, content_type: null, bytes: null,
    streaming_ok: null, fallback_ok: null, ms: null, error: null,
  };
  if (typeof WebAssembly !== 'object') return { ...base, detail: 'Este navegador não tem WebAssembly.' };
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    return { ...base, ...classifyWasmUrl(false, false, false), error: errText(e) };
  }
  const contentType = clip(res.headers.get('content-type'), 100);
  if (!res.ok) return { ...base, ...classifyWasmUrl(false, false, false), http_status: res.status, content_type: contentType };
  const copy = res.clone();
  let streamingOk = false;
  let fallbackOk: boolean | null = null;
  let error: string | null = null;
  try {
    const { instance } = await WebAssembly.instantiateStreaming(res);
    streamingOk = (instance.exports as unknown as CoreExports).add(2, 40) === 42;
  } catch (e) {
    error = errText(e);
  }
  const buf = await copy.arrayBuffer();
  if (!streamingOk) {
    try {
      const { instance } = await WebAssembly.instantiate(buf);
      fallbackOk = (instance.exports as unknown as CoreExports).add(2, 40) === 42;
    } catch (e) {
      fallbackOk = false;
      error = error ?? errText(e);
    }
  }
  return {
    ...classifyWasmUrl(true, streamingOk, fallbackOk === true),
    http_status: res.status, content_type: contentType, bytes: buf.byteLength,
    streaming_ok: streamingOk, fallback_ok: fallbackOk, ms: performance.now() - t0, error,
  };
}

// ---------- A-WASM-FEAT ----------
export function runWasmFeat(modules: Record<string, string>, g: typeof globalThis = globalThis): WasmFeatResult {
  const wa = (g as { WebAssembly?: typeof WebAssembly }).WebAssembly;
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, null])) as Record<FeatureKey, boolean | null>;
  const jspi = !!wa && typeof (wa as unknown as { Suspending?: unknown }).Suspending === 'function' &&
    typeof (wa as unknown as { promising?: unknown }).promising === 'function';
  const sab = typeof (g as { SharedArrayBuffer?: unknown }).SharedArrayBuffer === 'function';
  const coi = (g as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!wa) {
    return { status: 'SKIP', detail: 'Sem WebAssembly: recursos não verificados.', features, jspi_api: false, shared_array_buffer: sab, cross_origin_isolated: coi };
  }
  for (const k of FEATURE_KEYS) {
    const b64 = modules[k];
    if (!b64) continue;
    try {
      features[k] = wa.validate(fromB64(b64));
    } catch {
      features[k] = false;
    }
  }
  const missing = FEATURE_KEYS.filter((k) => features[k] === false);
  return {
    status: 'AP',
    detail: missing.length ? `Recursos ausentes: ${missing.join(', ')}.` : 'Todos os recursos testados estão presentes.',
    features, jspi_api: jspi, shared_array_buffer: sab, cross_origin_isolated: coi,
  };
}

// ---------- I-BENCH (informativo, nunca critério) ----------
export function jsBench(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) acc = ((acc + Math.imul(i, i)) | 0) ^ 7;
  return acc;
}

export function runBench(ex: CoreExports | null, iterations = 20_000_000): BenchResult {
  if (!ex) return { status: 'SKIP', detail: 'WebAssembly não rodou; conta não feita.', iterations: 0, wasm_ms: null, js_ms: null, same_result: null };
  let t = performance.now();
  const w = ex.bench(iterations);
  const wasmMs = performance.now() - t;
  t = performance.now();
  const j = jsBench(iterations);
  const jsMs = performance.now() - t;
  return {
    status: 'AP',
    detail: `Informativo: WebAssembly ${wasmMs.toFixed(1)} ms × JavaScript ${jsMs.toFixed(1)} ms (${iterations / 1e6} milhões de voltas).`,
    iterations, wasm_ms: wasmMs, js_ms: jsMs, same_result: w === j,
  };
}
