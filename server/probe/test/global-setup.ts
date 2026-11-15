// Compila src/ para dist/ antes dos testes: o teste de concorrência entre processos (worker_threads)
// e o teste de SIGTERM rodam o JavaScript compilado, como em produção.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
}
