/**
 * SQLite store (bun:sqlite, no dependency) for sessions, utterances and events.
 * The people / voiceprints / speaker_assignments tables are created now, empty,
 * so the recognition milestone can fill them without a migration.
 */
import {Database} from "bun:sqlite"
import {mkdirSync} from "node:fs"
import {dirname} from "node:path"

export interface UtteranceRow {
  runId: string
  tStart: number
  tEnd: number
  speakerLabel: string
  text: string
  confidence: number
  speechFinal: boolean
  provider: string
}

export class Store {
  readonly db: Database

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), {recursive: true})
    this.db = new Database(path)
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      run_id TEXT PRIMARY KEY, phone_run_id TEXT, started_at INTEGER NOT NULL, user_id TEXT, package_name TEXT,
      wav_path TEXT, sample_rate INTEGER, provider TEXT, ended_at INTEGER, end_reason TEXT)`)
    try {
      this.db.run(`ALTER TABLE sessions ADD COLUMN phone_run_id TEXT`)
    } catch {
      /* column already exists */
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS utterances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, t_start REAL NOT NULL, t_end REAL NOT NULL,
      speaker_label TEXT NOT NULL, text TEXT NOT NULL, confidence REAL, speech_final INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL, created_at INTEGER NOT NULL)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS utterances_run ON utterances(run_id, t_start)`)
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, t INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL)`)
    this.db.run(`CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, notes TEXT)`)
    this.db.run(`CREATE TABLE IF NOT EXISTS voiceprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people(id), embedding BLOB NOT NULL,
      dims INTEGER NOT NULL, model TEXT NOT NULL, source_run_id TEXT, source_t_start REAL, source_t_end REAL, created_at INTEGER NOT NULL)`)
    this.db.run(`CREATE TABLE IF NOT EXISTS speaker_assignments (
      run_id TEXT NOT NULL, speaker_label TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES people(id),
      confidence REAL, method TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, speaker_label))`)
  }

  startSession(s: {runId: string; phoneRunId?: string; startedAt: number; userId?: string; packageName?: string; provider: string}): void {
    this.db.run(
      `INSERT INTO sessions (run_id, phone_run_id, started_at, user_id, package_name, provider) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET user_id = COALESCE(excluded.user_id, user_id), package_name = COALESCE(excluded.package_name, package_name)`,
      [s.runId, s.phoneRunId ?? s.runId, s.startedAt, s.userId ?? null, s.packageName ?? null, s.provider],
    )
  }

  setSessionAudio(runId: string, wavPath: string, sampleRate: number): void {
    this.db.run(`UPDATE sessions SET wav_path = ?, sample_rate = ? WHERE run_id = ?`, [wavPath, sampleRate, runId])
  }

  endSession(runId: string, reason: string): void {
    this.db.run(`UPDATE sessions SET ended_at = ?, end_reason = ? WHERE run_id = ?`, [Date.now(), reason, runId])
  }

  insertUtterance(u: UtteranceRow): number {
    const res = this.db.run(
      `INSERT INTO utterances (run_id, t_start, t_end, speaker_label, text, confidence, speech_final, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.runId, u.tStart, u.tEnd, u.speakerLabel, u.text, u.confidence, u.speechFinal ? 1 : 0, u.provider, Date.now()],
    )
    return Number(res.lastInsertRowid)
  }

  insertEvent(runId: string, type: string, payload: unknown): void {
    this.db.run(`INSERT INTO events (run_id, t, type, payload) VALUES (?, ?, ?, ?)`, [runId, Date.now(), type, JSON.stringify(payload)])
  }

  utterancesForRun(runId: string): Array<{t_start: number; t_end: number; speaker_label: string; text: string}> {
    return this.db
      .query(`SELECT t_start, t_end, speaker_label, text FROM utterances WHERE run_id = ? ORDER BY t_start`)
      .all(runId) as Array<{t_start: number; t_end: number; speaker_label: string; text: string}>
  }

  countUtterances(runId: string): number {
    const row = this.db.query(`SELECT COUNT(*) AS c FROM utterances WHERE run_id = ?`).get(runId) as {c: number}
    return row.c
  }

  close(): void {
    this.db.close()
  }
}
