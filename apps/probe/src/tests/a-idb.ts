// A-IDB (gravar, ler e apagar na mesma sessão) e A-IDB-PERSIST (o dado sobrevive a fechar e reabrir
// a Activity?). O port guarda os saves em IndexedDB (C4).
// Cuidados aprovados na revisão:
//   - o marcador é separado por contexto (Discord Desktop, Discord Web, Android, navegador). Cada
//     contexto só olha o seu; o navegador particiona o armazenamento de iframes, então abrir a página
//     fora do Discord e não achar o marcador do Discord NÃO é falha;
//   - o marcador só é apagado depois de encontrado (persistência confirmada) ou se o usuário pedir.
// Tamanhos: 1 KB no teste imediato, ~100 bytes no marcador. Nada pesado.
import { clip } from '../hash';
import type { IdbResult, PersistResult, StorageContext } from '../report/types';

const DB = 'bt3probe';
const STORE = 'kv';
const errText = (e: unknown) => clip(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 300);

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('banco bloqueado'));
  });
}

async function op<T>(db: IDBDatabase, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const tx = db.transaction(STORE, mode);
  const out = await req(f(tx.objectStore(STORE)));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transação abortada'));
  });
  return out;
}

export interface RwOutcome { result: IdbResult; deleted: boolean }

export async function runIdbReadWrite(idb: IDBFactory | undefined, nav?: Navigator): Promise<RwOutcome> {
  const base: IdbResult = { status: 'RP', detail: '', read_write_ok: false, quota_mb: null, usage_mb: null, persisted: null, error: null };
  try {
    const est = await nav?.storage?.estimate?.();
    if (est?.quota !== undefined) base.quota_mb = Math.round(est.quota / 2 ** 20);
    if (est?.usage !== undefined) base.usage_mb = Math.round((est.usage / 2 ** 20) * 100) / 100;
    const p = await nav?.storage?.persisted?.();
    if (typeof p === 'boolean') base.persisted = p;
  } catch {
    // Sem a API de estimativa: os campos ficam nulos.
  }
  if (!idb) return { result: { ...base, detail: 'IndexedDB não existe neste ambiente.' }, deleted: false };
  let db: IDBDatabase | undefined;
  try {
    db = await openDb(idb);
    const data = new Uint8Array(1024);
    crypto.getRandomValues(data);
    await op(db, 'readwrite', (s) => s.put(data, 'rw-test'));
    const back = await op(db, 'readonly', (s) => s.get('rw-test') as IDBRequest<Uint8Array | undefined>);
    const same = !!back && back.length === data.length && back.every((b, i) => b === data[i]);
    await op(db, 'readwrite', (s) => s.delete('rw-test'));
    const gone = (await op(db, 'readonly', (s) => s.get('rw-test'))) === undefined;
    return {
      result: {
        ...base,
        status: same && gone ? 'AP' : 'RP',
        detail: same && gone
          ? 'READ_WRITE_OK: gravou 1 KB, leu igual e apagou. (Não prova que o dado fica salvo depois de fechar: ver A-IDB-PERSIST.)'
          : 'Gravou, mas a leitura ou a exclusão não conferiu.',
        read_write_ok: same && gone,
      },
      deleted: gone,
    };
  } catch (e) {
    return { result: { ...base, detail: 'IndexedDB bloqueado ou com erro.', error: errText(e) }, deleted: false };
  } finally {
    db?.close();
  }
}

// ---------- Persistência entre sessões ----------
export interface Marker { id: string; created_at: number; ctx: StorageContext }
const key = (ctx: StorageContext) => `persist-marker:${ctx}`;

export class PersistTest {
  private state: PersistResult;
  constructor(private idb: IDBFactory | undefined, private ctx: StorageContext, private now: () => number = Date.now) {
    this.state = {
      status: 'SKIP', detail: '', storage_context: ctx, marker_found: false, marker_age_s: null,
      marker_written_this_session: false, marker_pending: false, marker_deleted: false, user_reported_missing: false,
    };
  }

  result(): PersistResult {
    return { ...this.state };
  }

  private async withDb<T>(f: (db: IDBDatabase) => Promise<T>): Promise<T> {
    if (!this.idb) throw new Error('IndexedDB não existe neste ambiente');
    const db = await openDb(this.idb);
    try {
      return await f(db);
    } finally {
      db.close();
    }
  }

  // Na abertura: há um marcador DESTE contexto gravado numa sessão anterior?
  async check(): Promise<PersistResult> {
    try {
      const m = await this.withDb((db) => op(db, 'readonly', (s) => s.get(key(this.ctx)) as IDBRequest<Marker | undefined>));
      if (m && m.ctx === this.ctx) {
        const age = Math.max(0, Math.round((this.now() - m.created_at) / 1000));
        // Persistência confirmada: agora sim o marcador pode ser apagado.
        await this.withDb((db) => op(db, 'readwrite', (s) => s.delete(key(this.ctx))));
        this.state = {
          ...this.state, status: 'AP', marker_found: true, marker_age_s: age, marker_deleted: true, marker_pending: false,
          detail: `PERSISTENCE_OK: o marcador gravado há ${age} s numa sessão anterior (${this.ctx}) foi encontrado e apagado.`,
        };
      } else {
        this.state = {
          ...this.state, status: 'SKIP',
          detail: 'Nenhum marcador pendente neste ambiente. Para testar: "Gravar marcador", feche e reabra a Activity aqui mesmo.',
        };
      }
    } catch (e) {
      this.state = { ...this.state, status: 'RP', detail: `IndexedDB indisponível: ${errText(e)}` };
    }
    return this.result();
  }

  async write(): Promise<PersistResult> {
    try {
      const m: Marker = { id: crypto.randomUUID?.() ?? String(Math.random()), created_at: this.now(), ctx: this.ctx };
      await this.withDb((db) => op(db, 'readwrite', (s) => s.put(m, key(this.ctx))));
      this.state = {
        ...this.state, status: 'SKIP', marker_written_this_session: true, marker_pending: true, marker_deleted: false,
        detail: 'Marcador gravado. Feche a Activity e abra de novo neste mesmo ambiente; o resultado sai no relatório da próxima abertura.',
      };
    } catch (e) {
      this.state = { ...this.state, status: 'RP', detail: `Não consegui gravar o marcador: ${errText(e)}` };
    }
    return this.result();
  }

  async remove(): Promise<PersistResult> {
    try {
      await this.withDb((db) => op(db, 'readwrite', (s) => s.delete(key(this.ctx))));
      this.state = {
        ...this.state, status: 'SKIP', marker_pending: false, marker_deleted: true,
        detail: 'Marcador apagado a pedido; persistência não verificada.',
      };
    } catch (e) {
      this.state = { ...this.state, detail: `Não consegui apagar o marcador: ${errText(e)}` };
    }
    return this.result();
  }

  // O usuário gravou numa sessão anterior, reabriu no mesmo ambiente e o marcador não apareceu.
  reportMissing(): PersistResult {
    if (this.state.marker_found) return this.result();
    this.state = {
      ...this.state, status: 'RP', user_reported_missing: true,
      detail: 'O usuário gravou um marcador numa sessão anterior deste ambiente e ele não estava mais lá: o dado não persistiu.',
    };
    return this.result();
  }
}
