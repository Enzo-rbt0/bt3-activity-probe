// Worker do teste de abertura simultânea: abre o MESMO arquivo SQLite ao mesmo tempo que os outros,
// com o openDb de produção (dist), e responde "ok" ou o erro.
import { parentPort, workerData } from 'node:worker_threads';

const { openDb } = await import(workerData.dist + '/db.js');
const gate = new Int32Array(workerData.sab);
Atomics.add(gate, 1, 1); // pronto
Atomics.wait(gate, 0, 0); // largada simultânea
try {
  openDb(workerData.dbPath).close();
  parentPort.postMessage('ok');
} catch (e) {
  parentPort.postMessage('erro: ' + e.message);
}
