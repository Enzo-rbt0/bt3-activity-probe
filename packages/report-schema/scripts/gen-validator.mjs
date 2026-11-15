// Gera o validador do relatório como código JavaScript comum (Ajv "standalone"), sem `new Function`
// no navegador: dentro do Discord a página roda com uma Content Security Policy que pode bloquear
// avaliação de código em tempo de execução. O arquivo gerado fica em packages/report-schema/generated/
// (fora do git) e é refeito antes de build, testes e verificação de tipos.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../generated');
mkdirSync(out, { recursive: true });
// O código gerado usa require() para contar caracteres em maxLength. No navegador não existe require,
// então a função é escrita direto no arquivo (conta pontos de código Unicode, igual à original do Ajv).
const RUNTIME = 'require("ajv/dist/runtime/ucs2length")';
const INLINE = '{ default: (s) => Array.from(s).length }';
const DTS = [
  '// Gerado por scripts/gen-validator.mjs. Não editar.',
  'export interface ValidationError { instancePath: string; message?: string; keyword: string }',
  'declare const validate: ((data: unknown) => boolean) & { errors?: ValidationError[] | null };',
  'export default validate;',
  '',
].join('\n');

// Um validador por versão do formato: relatórios antigos continuam verificáveis.
for (const v of [1, 2, 3, 4]) {
  const schema = JSON.parse(readFileSync(join(here, `../schema/report.v${v}.json`), 'utf8'));
  const ajv = new Ajv({ code: { source: true, esm: true }, allErrors: true, strict: true });
  const code = standaloneCode(ajv, ajv.compile(schema)).replaceAll(RUNTIME, INLINE);
  if (code.includes('require(')) throw new Error(`validador v${v} ainda depende de require()`);
  writeFileSync(join(out, `validate-report-v${v}.mjs`), `// Gerado por scripts/gen-validator.mjs. Não editar.\n${code}`);
  writeFileSync(join(out, `validate-report-v${v}.d.mts`), DTS);
}
console.log('validadores do relatório gerados (v1 a v4)');
