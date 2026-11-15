import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')) as { version: string };
const sdkPkg = JSON.parse(
  readFileSync(resolve(here, '../../node_modules/@discord/embedded-app-sdk/package.json'), 'utf8'),
) as { version: string };

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: here }).toString().trim();
  } catch {
    return 'desconhecido';
  }
}

export default defineConfig({
  root: here,
  // Caminhos relativos: a mesma build funciona em enzo-rbt0.github.io/bt3-activity-probe/ e na raiz
  // do proxy do Discord (<app>.discordsays.com/).
  base: './',
  define: {
    __PROBE_VERSION__: JSON.stringify(pkg.version),
    __PROBE_GIT_SHA__: JSON.stringify(gitSha()),
    __PROBE_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    __SDK_VERSION__: JSON.stringify(sdkPkg.version),
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
