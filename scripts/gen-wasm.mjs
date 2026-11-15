// Gera os módulos WebAssembly de teste da F2a a partir dos .wat em wasm/core (texto escrito à mão,
// nada de jogo). Saídas (fora do git):
//   apps/probe/src/generated/wasm-modules.ts  módulos embutidos na página (base64)
//   apps/probe/public/wasm/probe-url.wasm     o mesmo core.wasm, servido como arquivo separado (A-WASM-URL)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import binaryen from 'binaryen';
import wabtInit from 'wabt';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wabt = await wabtInit();

function wat2wasm(name, src, features = {}) {
  const mod = wabt.parseWat(name, src, features);
  try {
    mod.validate();
    return new Uint8Array(mod.toBinary({}).buffer);
  } finally {
    mod.destroy();
  }
}

const read = (f) => readFileSync(join(root, 'wasm/core', f), 'utf8');
const core = wat2wasm('core.wat', read('core.wat'));
const jspi = wat2wasm('jspi.wat', read('jspi.wat'));

// Asyncify pelo binaryen: só a importação env.sleep pode pausar.
const asyncSrc = wat2wasm('asyncify.wat', read('asyncify.wat'));
const bmod = binaryen.readBinary(asyncSrc);
binaryen.setPassArgument('asyncify-imports', 'env.sleep');
bmod.runPasses(['asyncify']);
if (!bmod.validate()) throw new Error('módulo asyncify inválido depois do binaryen');
const asyncify = bmod.emitBinary();
bmod.dispose();

// Módulos minúsculos, um por recurso. Só passam por WebAssembly.validate() no navegador:
// válido = o navegador entende aquele recurso.
const FEATURES = {
  simd: ['(module (func (result v128) v128.const i32x4 1 2 3 4 v128.const i32x4 1 1 1 1 i32x4.add))', { simd: true }],
  bulk_memory: ['(module (memory 1) (func i32.const 0 i32.const 8 i32.const 4 memory.copy))', { bulk_memory: true }],
  exceptions: [
    '(module (tag $e (param i32)) (func (result i32) try (result i32) i32.const 1 throw $e catch $e end))',
    { exceptions: true },
  ],
  multi_value: ['(module (func (result i32 i32) i32.const 1 i32.const 2))', { multi_value: true }],
  tail_call: ['(module (func $f (result i32) i32.const 1) (func (result i32) return_call $f))', { tail_call: true }],
  sat_float_to_int: ['(module (func (param f32) (result i32) local.get 0 i32.trunc_sat_f32_s))', { sat_float_to_int: true }],
  sign_ext: ['(module (func (param i32) (result i32) local.get 0 i32.extend8_s))', { sign_extension: true }],
};
const featureBins = Object.fromEntries(
  Object.entries(FEATURES).map(([k, [src, f]]) => [k, wat2wasm(`${k}.wat`, src, f)]),
);

const b64 = (u8) => Buffer.from(u8).toString('base64');
const genDir = join(root, 'apps/probe/src/generated');
mkdirSync(genDir, { recursive: true });
writeFileSync(
  join(genDir, 'wasm-modules.ts'),
  [
    '// Gerado por scripts/gen-wasm.mjs a partir de wasm/core/*.wat. Não editar.',
    `export const CORE_WASM = '${b64(core)}';`,
    `export const JSPI_WASM = '${b64(jspi)}';`,
    `export const ASYNCIFY_WASM = '${b64(asyncify)}';`,
    `export const FEATURE_WASM: Record<string, string> = ${JSON.stringify(Object.fromEntries(Object.entries(featureBins).map(([k, v]) => [k, b64(v)])), null, 2)};`,
    '',
  ].join('\n'),
);
const pubDir = join(root, 'apps/probe/public/wasm');
mkdirSync(pubDir, { recursive: true });
writeFileSync(join(pubDir, 'probe-url.wasm'), core);
console.log(`módulos wasm gerados (core ${core.length} B, asyncify ${asyncify.length} B)`);
