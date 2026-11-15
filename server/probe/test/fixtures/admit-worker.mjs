// Worker do teste de concorrência entre processos/threads: cada worker abre sua própria conexão
// SQLite no MESMO arquivo e tenta admitir sessões ao mesmo tempo que os outros.
import { parentPort, workerData } from 'node:worker_threads';

const { openDb } = await import(workerData.dist + '/db.js');
const { Budget } = await import(workerData.dist + '/budget.js');
const db = openDb(workerData.dbPath);
const budget = new Budget(db);
const gate = new Int32Array(workerData.sab);
Atomics.add(gate, 1, 1); // pronto
Atomics.wait(gate, 0, 0); // largada simultânea
const out = [];
for (let i = 0; i < workerData.n; i++) {
  try {
    const r = budget.admit('echo', 60_000, workerData.now);
    out.push(r.ok ? 'ok' : r.reason);
  } catch (e) {
    out.push('erro: ' + e.message);
  }
}
db.close();
parentPort.postMessage(out);
