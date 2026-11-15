// A-IDB (gravar, ler e apagar na mesma sessão) e A-IDB-PERSIST (o dado sobrevive a fechar e reabrir
// a Activity?). O port guarda os saves em IndexedDB (C4).
// Cuidados aprovados na revisão:
//   - o marcador é separado por contexto (Discord Desktop, Discord Web, Android, navegador). Cada
//     contexto só olha o seu; o navegador particiona o armazenamento de iframes, então abrir a página
//     fora do Discord e não achar o marcador do Discord NÃO é falha;
//   - o marcador só é apagado depois de encontrado (persistência confirmada) ou se o usuário pedir.
// Tamanhos: 1 KB no teste imediato, ~100 bytes no marcador. Nada pesado.
import { clip } from '../hash';
import type { IdbResult, PersistResult, PersistState, StorageContext } from '../report/types';

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

// ---------- Persistência entre sessões: máquina de estados (F2b-0) ----------
// Um único registro por contexto guarda o estado do teste:
//   none       nenhum registro (nunca testou, ou o armazenamento foi apagado)
//   pending    marcador gravado, esperando a próxima abertura
//   confirmed  marcador encontrado numa abertura seguinte (recibo: só datas)
//   cancelled  o usuário apagou o marcador antes de verificar
// Transições: none|confirmed|cancelled --gravar--> pending
//             pending --abrir de novo--> confirmed (AP)
//             pending --apagar--> cancelled
// Uma confirmação antiga nunca aprova uma tentativa nova (gravar de novo volta para pending) e
// nunca vira RP: "sumiu" só é aceito quando NÃO há registro nenhum (state_at_open = none).

export interface PersistRecord {
  state: Exclude<PersistState, 'none'>;
  ctx: StorageContext;
  created_at: number; // quando o marcador foi gravado
  confirmed_at?: number; // quando foi encontrado numa abertura seguinte
  cancelled_at?: number;
}
const key = (ctx: StorageContext) => `persist:${ctx}`;
// Chave usada pela versão 0.2.0 (F2a). Nela, um registro presente significava "marcador pendente"
// (a 0.2.0 apagava o marcador ao confirmar). Lido uma vez e migrado para o formato novo.
const legacyKey = (ctx: StorageContext) => `persist-marker:${ctx}`;
interface LegacyMarker { id?: string; created_at: number; ctx: StorageContext }

export class PersistTest {
  private state: PersistResult;
  constructor(private idb: IDBFactory | undefined, private ctx: StorageContext, private now: () => number = Date.now) {
    this.state = {
      status: 'SKIP', detail: '', storage_context: ctx, state_at_open: 'none', state_now: 'none',
      marker_age_s: null, last_confirmed_age_s: null, marker_written_this_session: false, user_reported_missing: false,
      receipt_saved: null, legacy_migrated: false,
    };
  }

  result(): PersistResult {
    return { ...this.state };
  }

  // O botão "Gravei antes e ele sumiu" só faz sentido sem nenhum registro na abertura.
  canReportMissing(): boolean {
    return this.state.state_at_open === 'none' && !this.state.marker_written_this_session && !this.state.user_reported_missing;
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

  private read(): Promise<PersistRecord | undefined> {
    return this.withDb((db) => op(db, 'readonly', (s) => s.get(key(this.ctx)) as IDBRequest<PersistRecord | undefined>));
  }

  // Migração da 0.2.0: um marcador pendente na chave antiga vira "pending" na chave nova e a chave
  // antiga é apagada. Sem isso, um teste iniciado na 0.2.0 sumiria ao publicar a 0.2.1.
  private async migrateLegacy(): Promise<PersistRecord | undefined> {
    const old = await this.withDb((db) => op(db, 'readonly', (s) => s.get(legacyKey(this.ctx)) as IDBRequest<LegacyMarker | undefined>));
    if (!old || old.ctx !== this.ctx || typeof old.created_at !== 'number') return undefined;
    const rec: PersistRecord = { state: 'pending', ctx: this.ctx, created_at: old.created_at };
    // Grava a chave nova e apaga a antiga na MESMA transação: ou as duas acontecem, ou nenhuma.
    await this.withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          const s = tx.objectStore(STORE);
          s.put(rec, key(this.ctx));
          s.delete(legacyKey(this.ctx));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('migração abortada'));
        }),
    );
    this.state = { ...this.state, legacy_migrated: true };
    return rec;
  }

  private save(r: PersistRecord): Promise<IDBValidKey> {
    return this.withDb((db) => op(db, 'readwrite', (s) => s.put(r, key(this.ctx))));
  }

  private age(t: number | undefined): number | null {
    return t === undefined ? null : Math.max(0, Math.round((this.now() - t) / 1000));
  }

  async check(): Promise<PersistResult> {
    let rec: PersistRecord | undefined;
    try {
      rec = await this.read();
      if (!rec) rec = await this.migrateLegacy();
    } catch (e) {
      this.state = { ...this.state, status: 'RP', detail: `IndexedDB indisponível: ${errText(e)}` };
      return this.result();
    }
    const valid = rec && rec.ctx === this.ctx ? rec : undefined;
    const at: PersistState = valid?.state ?? 'none';
    this.state = { ...this.state, state_at_open: at, state_now: at, last_confirmed_age_s: this.age(valid?.confirmed_at) };
    if (valid?.state === 'pending') {
      const age = this.age(valid.created_at);
      const confirmed: PersistRecord = { state: 'confirmed', ctx: this.ctx, created_at: valid.created_at, confirmed_at: this.now() };
      const legacy = this.state.legacy_migrated ? ' (marcador da versão 0.2.0, migrado)' : '';
      try {
        await this.save(confirmed);
        this.state = {
          ...this.state, status: 'AP', state_now: 'confirmed', marker_age_s: age, last_confirmed_age_s: 0, receipt_saved: true,
          detail: `PERSISTENCE_OK: o marcador gravado há ${age} s numa sessão anterior (${this.ctx}) foi encontrado${legacy}. Recibo guardado.`,
        };
      } catch (e) {
        // A persistência foi comprovada (o marcador foi lido), mas o recibo não: o registro continua
        // "pending" no armazenamento e isso é dito com todas as letras.
        this.state = {
          ...this.state, status: 'AP', state_now: 'pending', marker_age_s: age, receipt_saved: false,
          detail: `PERSISTENCE_OK: o marcador gravado há ${age} s foi encontrado${legacy}, mas o recibo NÃO foi gravado (${errText(e)}). O registro continua pendente.`,
        };
      }
    } else if (valid?.state === 'confirmed') {
      this.state = {
        ...this.state, status: 'SKIP',
        detail: `Nenhum teste pendente. O último marcador já foi confirmado há ${this.state.last_confirmed_age_s} s; para testar de novo, grave um novo.`,
      };
    } else if (valid?.state === 'cancelled') {
      this.state = { ...this.state, status: 'SKIP', detail: 'Nenhum teste pendente: o último marcador foi apagado antes de ser verificado.' };
    } else {
      this.state = {
        ...this.state, status: 'SKIP',
        detail: 'Nenhum marcador pendente neste ambiente. Para testar: "Gravar marcador", feche e reabra a Activity aqui mesmo.',
      };
    }
    return this.result();
  }

  async write(): Promise<PersistResult> {
    try {
      await this.save({ state: 'pending', ctx: this.ctx, created_at: this.now() });
      this.state = {
        ...this.state, status: 'SKIP', state_now: 'pending', marker_written_this_session: true,
        detail: 'Marcador gravado. Feche a Activity e abra de novo neste mesmo ambiente; o resultado sai no relatório da próxima abertura.',
      };
    } catch (e) {
      this.state = { ...this.state, status: 'RP', detail: `Não consegui gravar o marcador: ${errText(e)}` };
    }
    return this.result();
  }

  async remove(): Promise<PersistResult> {
    if (this.state.state_now !== 'pending') return this.result();
    try {
      const rec = await this.read();
      await this.save({ state: 'cancelled', ctx: this.ctx, created_at: rec?.created_at ?? this.now(), cancelled_at: this.now() });
      this.state = { ...this.state, status: 'SKIP', state_now: 'cancelled', detail: 'Marcador apagado a pedido; persistência não verificada.' };
    } catch (e) {
      this.state = { ...this.state, detail: `Não consegui apagar o marcador: ${errText(e)}` };
    }
    return this.result();
  }

  // O usuário gravou numa sessão anterior, reabriu no mesmo ambiente e não há registro nenhum.
  reportMissing(): PersistResult {
    if (!this.canReportMissing()) return this.result();
    this.state = {
      ...this.state, status: 'RP', user_reported_missing: true,
      detail: 'O usuário gravou um marcador numa sessão anterior deste ambiente e não há mais nenhum registro: o dado não persistiu.',
    };
    return this.result();
  }
}
