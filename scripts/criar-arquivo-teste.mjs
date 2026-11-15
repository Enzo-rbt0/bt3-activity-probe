// Cria (ou apaga) o arquivo de teste da F2b para o A-FILE-LARGE em Linux/macOS e na CI. Mesmo
// formato do criar-arquivo-teste.ps1 (Windows): 3 GiB esparsos com marcadores no início, logo
// depois de 2 GiB e no fim. Nada do BT3.
//   node scripts/criar-arquivo-teste.mjs <pasta>            cria <pasta>/teste.bt3probe-large.bin
//   node scripts/criar-arquivo-teste.mjs <pasta> --apagar   apaga (só se o marcador conferir)
// Cuidados: nunca sobrescreve; recusa pasta dentro deste repositório; confere espaço livre; se o
// espaço físico passar de 64 MiB (sistema de arquivos sem esparso), apaga e cancela.
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'teste.bt3probe-large.bin';
export const SIZE = 3 * 2 ** 30;
export const AFTER_2GIB = 2 ** 31 + 2 ** 20;
const LIMIT = 64 * 2 ** 20;
const MIN_FREE = 256 * 2 ** 20;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const die = (msg) => {
  console.error(`ERRO: ${msg}`);
  process.exit(1);
};

export function create(dir) {
  const path = join(resolve(dir), NAME);
  const rel = relative(repo, path);
  if (!rel.startsWith('..') && !rel.startsWith('/')) die(`a pasta fica dentro do repositório (${repo}); use outra.`);
  if (existsSync(path)) die(`'${path}' já existe. Nada foi alterado; rode com --apagar antes.`);
  const fsinfo = statfsSync(resolve(dir));
  if (fsinfo.bavail * fsinfo.bsize < MIN_FREE) die('menos de 256 MiB livres; cancelado.');
  const fd = openSync(path, 'wx');
  try {
    ftruncateSync(fd, SIZE);
    const physical = () => fstatSync(fd).blocks * 512;
    if (physical() > LIMIT) throw new Error(`sem arquivo esparso: já ocupa ${Math.round(physical() / 2 ** 20)} MiB`);
    for (const pos of [0, AFTER_2GIB, SIZE - 4096]) writeSync(fd, Buffer.from(`BT3PROBE-MARK:${pos};`, 'ascii'), 0, undefined, pos);
    if (physical() > LIMIT) throw new Error(`depois dos marcadores ocupa ${Math.round(physical() / 2 ** 20)} MiB`);
    console.log(`criado ${path}: ${SIZE} bytes lógicos, ${Math.ceil(physical() / 1024)} KiB físicos`);
  } catch (e) {
    closeSync(fd);
    unlinkSync(path);
    die(`${e.message}. Arquivo apagado.`);
  }
  closeSync(fd);
  return path;
}

export function remove(dir) {
  const path = join(resolve(dir), NAME);
  if (!existsSync(path)) return console.log('nada a apagar');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(64);
  readSync(fd, buf, 0, 64, 0);
  closeSync(fd);
  if (!buf.toString('ascii').startsWith('BT3PROBE-MARK:0;')) die('o arquivo não tem o marcador do teste; não apaguei.');
  unlinkSync(path);
  console.log(`apagado ${path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) die('informe a pasta. Ex.: node scripts/criar-arquivo-teste.mjs /tmp');
  if (flag === '--apagar') remove(dir);
  else create(dir);
}
