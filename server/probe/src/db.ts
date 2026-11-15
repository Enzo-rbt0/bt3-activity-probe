// SQLite local (módulo nativo node:sqlite, sem dependência compilada) em modo WAL.
// Fonte de verdade de bilhetes, sessões e orçamento diário. Durante uma sessão, nada é lido ou gravado
// aqui por mensagem: só na admissão, no resgate do bilhete e no encerramento.
import { DatabaseSync } from 'node:sqlite';

export interface Db {
  raw: DatabaseSync;
  // Contador de acessos ao banco: os testes conferem que o eco não toca o SQLite por mensagem.
  accesses: number;
  tx<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY,
  admissions INTEGER NOT NULL DEFAULT 0,
  reserved_msgs INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ticket TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  reserved_msgs INTEGER NOT NULL,
  ticket_expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  deadline INTEGER,
  ended_at INTEGER,
  used_msgs INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_open ON sessions (ended_at);
`;

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
  raw.exec(SCHEMA);
  const db: Db = {
    raw,
    accesses: 0,
    tx<T>(fn: () => T): T {
      db.accesses++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // a transação já pode ter sido desfeita
        }
        throw e;
      }
    },
    close: () => raw.close(),
  };
  return db;
}
