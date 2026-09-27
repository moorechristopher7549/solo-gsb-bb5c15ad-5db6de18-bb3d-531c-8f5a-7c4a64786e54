import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Edge, Evidence } from './types';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'evidence.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  occurred_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(from_id, to_id)
);
`);

interface EvidenceRow {
  id: string;
  title: string;
  description: string;
  source: string;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: number;
  from_id: string;
  to_id: string;
  created_at: string;
}

function toEvidence(r: EvidenceRow): Evidence {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    source: r.source,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toEdge(r: EdgeRow): Edge {
  return { id: r.id, fromId: r.from_id, toId: r.to_id, createdAt: r.created_at };
}

export function getEvidence(): Evidence[] {
  const rows = db.prepare('SELECT * FROM evidence ORDER BY created_at, rowid').all() as EvidenceRow[];
  return rows.map(toEvidence);
}

export function getEdges(): Edge[] {
  const rows = db.prepare('SELECT * FROM edges ORDER BY id').all() as EdgeRow[];
  return rows.map(toEdge);
}
