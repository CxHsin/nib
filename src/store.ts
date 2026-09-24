import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { CapturedMessage, ChatTurn, DigestWindow, StoredDigest } from "./types.js";
import { RETENTION_MS } from "./time.js";

interface MessageRow {
  message_id: string;
  group_id: string;
  group_name: string;
  author_id: string;
  author_name: string;
  occurred_at: number;
  text: string;
  urls_json: string;
}

interface DigestRow {
  id: number;
  window_start: number;
  window_end: number;
  body: string;
}

export interface LinkCacheEntry {
  url: string;
  fetchedAt: number;
  ok: boolean;
  title: string | null;
  content: string | null;
  error: string | null;
}

export interface DeliverySegment {
  id: number;
  digestId: number;
  partIndex: number;
  totalParts: number;
  body: string;
  status: "pending" | "sending" | "sent";
  attempts: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        urls_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_occurred_at ON messages(occurred_at);
      CREATE TABLE IF NOT EXISTS link_cache (
        url TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        title TEXT,
        content TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS collection_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL UNIQUE,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_id INTEGER NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
        part_index INTEGER NOT NULL,
        total_parts INTEGER NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        telegram_message_id TEXT,
        UNIQUE(digest_id, part_index)
      );
      CREATE TABLE IF NOT EXISTS chat_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_turns(group_id, author_id, id);
      CREATE TABLE IF NOT EXISTS chat_requests (
        group_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY(group_id, message_id)
      );
    `);
    const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns("chat_turns").includes("expires_at")) {
      this.db.exec("ALTER TABLE chat_turns ADD COLUMN expires_at INTEGER");
      // Existing derived replies have no provenance: conservatively expire each session with its oldest turn.
      this.db.prepare(`UPDATE chat_turns SET expires_at = ? + (SELECT MIN(t.created_at) FROM chat_turns t
        WHERE t.group_id = chat_turns.group_id AND t.author_id = chat_turns.author_id)`).run(RETENTION_MS);
    }
    if (!columns("chat_requests").includes("created_at")) {
      this.db.exec("ALTER TABLE chat_requests ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    }
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  initializeRuntime(now: number): { firstStart: boolean; previousHeartbeat?: number } {
    const rawStart = this.getMeta("service_started_at");
    const rawHeartbeat = this.getMeta("last_heartbeat_at");
    if (!rawStart) this.setMeta("service_started_at", String(now));
    this.setMeta("last_heartbeat_at", String(now));
    return {
      firstStart: !rawStart,
      ...(rawHeartbeat ? { previousHeartbeat: Number(rawHeartbeat) } : {}),
    };
  }

  heartbeat(now: number): void {
    this.setMeta("last_heartbeat_at", String(now));
  }

  recordGap(startedAt: number, endedAt: number): void {
    if (endedAt <= startedAt) return;
    this.db.prepare("INSERT INTO collection_gaps(started_at, ended_at) VALUES (?, ?)").run(startedAt, endedAt);
  }

  hasGap(start: number, end: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM collection_gaps
      WHERE started_at < ? AND ended_at > ? LIMIT 1
    `).get(end, start));
  }

  saveMessage(message: CapturedMessage, receivedAt = Date.now()): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO messages(
        message_id, group_id, group_name, author_id, author_name,
        occurred_at, text, urls_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.messageId,
      message.groupId,
      message.groupName,
      message.authorId,
      message.authorName,
      message.occurredAt,
      message.text,
      JSON.stringify(message.urls),
      receivedAt,
    );
    return result.changes > 0;
  }

  listMessages(start: number, end: number): CapturedMessage[] {
    const rows = this.db.prepare(`
      SELECT message_id, group_id, group_name, author_id, author_name,
             occurred_at, text, urls_json
      FROM messages
      WHERE occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at, message_id
    `).all(start, end) as unknown as MessageRow[];
    return rows.map((row) => this.mapMessage(row));
  }

  listGroupMessages(groupId: string, keyword: string, now = Date.now()): CapturedMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE group_id = ? AND occurred_at <= ? AND occurred_at > ?
        AND instr(text, ?) > 0
      ORDER BY occurred_at DESC, message_id DESC LIMIT 50
    `).all(groupId, now, now - RETENTION_MS, keyword) as unknown as MessageRow[];
    return rows.reverse().map((row) => this.mapMessage(row));
  }

  claimChatRequest(message: CapturedMessage): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO chat_requests(group_id, message_id, created_at) VALUES (?, ?, ?)`)
      .run(message.groupId, message.messageId, message.occurredAt).changes > 0;
  }

  saveChatTurn(groupId: string, authorId: string, turn: ChatTurn): void {
    this.db.prepare(`INSERT INTO chat_turns(group_id, author_id, role, text, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(groupId, authorId, turn.role, turn.text, turn.createdAt,
        Math.min(turn.expiresAt ?? Infinity, turn.createdAt + RETENTION_MS));
  }

  listChatTurns(groupId: string, authorId: string, now = Date.now()): ChatTurn[] {
    const rows = this.db.prepare(`SELECT role, text, created_at, expires_at FROM chat_turns
      WHERE group_id = ? AND author_id = ? AND expires_at > ? ORDER BY id DESC LIMIT 12`)
      .all(groupId, authorId, now) as unknown as Array<{
        role: ChatTurn["role"]; text: string; created_at: number; expires_at: number;
      }>;
    return rows.reverse().map((row) => ({
      role: row.role, text: row.text, createdAt: row.created_at, expiresAt: row.expires_at,
    }));
  }

  private mapMessage(row: MessageRow): CapturedMessage {
    return {
      messageId: row.message_id,
      groupId: row.group_id,
      groupName: row.group_name,
      authorId: row.author_id,
      authorName: row.author_name,
      occurredAt: row.occurred_at,
      text: row.text,
      urls: JSON.parse(row.urls_json) as string[],
    };
  }

  getLink(url: string): LinkCacheEntry | undefined {
    const row = this.db.prepare(`
      SELECT url, fetched_at, ok, title, content, error FROM link_cache WHERE url = ?
    `).get(url) as {
      url: string; fetched_at: number; ok: number; title: string | null;
      content: string | null; error: string | null;
    } | undefined;
    return row ? {
      url: row.url,
      fetchedAt: row.fetched_at,
      ok: row.ok === 1,
      title: row.title,
      content: row.content,
      error: row.error,
    } : undefined;
  }

  saveLink(entry: LinkCacheEntry): void {
    this.db.prepare(`
      INSERT INTO link_cache(url, fetched_at, ok, title, content, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        fetched_at = excluded.fetched_at, ok = excluded.ok,
        title = excluded.title, content = excluded.content, error = excluded.error
    `).run(entry.url, entry.fetchedAt, entry.ok ? 1 : 0, entry.title, entry.content, entry.error);
  }

  getDigestByEnd(windowEnd: number): StoredDigest | undefined {
    const row = this.db.prepare(`
      SELECT id, window_start, window_end, body FROM digests WHERE window_end = ?
    `).get(windowEnd) as DigestRow | undefined;
    return row ? this.mapDigest(row) : undefined;
  }

  saveDigest(window: DigestWindow, body: string, createdAt = Date.now()): StoredDigest {
    this.db.prepare(`
      INSERT OR IGNORE INTO digests(window_start, window_end, body, created_at)
      VALUES (?, ?, ?, ?)
    `).run(window.start, window.end, body, createdAt);
    const digest = this.getDigestByEnd(window.end);
    if (!digest) throw new Error("晚报保存失败");
    return digest;
  }

  prepareDelivery(digestId: number, parts: string[]): void {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO delivery_segments(digest_id, part_index, total_parts, body)
      VALUES (?, ?, ?, ?)
    `);
    this.transaction(statement, parts.map((body, index) => [digestId, index, parts.length, body]));
  }

  listUnsentSegments(): DeliverySegment[] {
    const rows = this.db.prepare(`
      SELECT id, digest_id, part_index, total_parts, body, status, attempts
      FROM delivery_segments WHERE status != 'sent'
      ORDER BY digest_id, part_index
    `).all() as unknown as Array<{
      id: number; digest_id: number; part_index: number; total_parts: number;
      body: string; status: "pending" | "sending"; attempts: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      digestId: row.digest_id,
      partIndex: row.part_index,
      totalParts: row.total_parts,
      body: row.body,
      status: row.status,
      attempts: row.attempts,
    }));
  }

  markSegmentSending(id: number): void {
    this.db.prepare(`
      UPDATE delivery_segments SET status = 'sending', attempts = attempts + 1 WHERE id = ?
    `).run(id);
  }

  markSegmentSent(id: number, telegramMessageId: string): void {
    this.db.prepare(`
      UPDATE delivery_segments SET status = 'sent', telegram_message_id = ? WHERE id = ?
    `).run(telegramMessageId, id);
  }

  cleanup(cutoff: number): { messages: number; links: number } {
    const messages = this.db.prepare("DELETE FROM messages WHERE occurred_at <= ?").run(cutoff).changes;
    const links = this.db.prepare("DELETE FROM link_cache WHERE fetched_at <= ?").run(cutoff).changes;
    this.db.prepare("DELETE FROM chat_turns WHERE expires_at <= ?").run(cutoff + RETENTION_MS);
    this.db.prepare("DELETE FROM chat_requests WHERE created_at <= ?").run(cutoff);
    this.db.prepare("DELETE FROM digests WHERE window_start <= ?").run(cutoff);
    this.db.prepare("DELETE FROM collection_gaps WHERE ended_at <= ?").run(cutoff);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { messages: Number(messages), links: Number(links) };
  }

  private mapDigest(row: DigestRow): StoredDigest {
    return { id: row.id, windowStart: row.window_start, windowEnd: row.window_end, body: row.body };
  }

  private transaction(statement: StatementSync, parameterSets: SQLInputValue[][]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const parameters of parameterSets) statement.run(...parameters);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
