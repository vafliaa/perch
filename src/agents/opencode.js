'use strict';

const os = require('os');
const path = require('path');

const { exists, cleanText, projectName, shortModel, buildSession, sortSessions, parseTime } = require('./util');

const ACTIVE_MS = 30 * 60 * 1000;
const STALL_MS = 4 * 60 * 1000;
const RECENT_LIMIT = 8;

/**
 * opencode хранит сессии в SQLite: ~/.local/share/opencode/opencode.db.
 * Читаем только на чтение через встроенный в Node/Electron модуль node:sqlite —
 * нативные зависимости не нужны.
 */
class OpencodeAgent {
  constructor() {
    this.id = 'opencode';
    this.label = 'opencode';
    this.short = 'opencode';
    this.accent = '#4fd1c5';
    this.installHint = 'npm i -g opencode-ai   (или: curl -fsSL https://opencode.ai/install | bash)';
    this.supportsUsage = false;
    this.dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    this._recent = [];
    this._sqlite = undefined;
    this._snap = null;
  }

  detect() {
    return exists(this.dbPath);
  }

  sqlite() {
    if (this._sqlite !== undefined) return this._sqlite;
    try {
      const mod = require('node:sqlite');
      this._sqlite = mod && mod.DatabaseSync ? mod.DatabaseSync : null;
    } catch (error) {
      console.warn('Perch: node:sqlite недоступен, opencode пропущен:', error.message);
      this._sqlite = null;
    }
    return this._sqlite;
  }

  withDb(fn) {
    const DatabaseSync = this.sqlite();
    if (!DatabaseSync) return null;
    let db = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 2000');
      return fn(db);
    } catch (error) {
      console.warn('Perch: opencode db error:', error.message);
      return null;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  }

  parseModel(raw) {
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.id) return String(parsed.id);
    } catch {
      // not JSON, use as-is
    }
    return String(raw);
  }

  describeMessage(message) {
    if (!message) return '';
    let data;
    try {
      data = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
    } catch {
      return '';
    }
    if (!data || typeof data !== 'object') return '';

    if (message.type === 'user') {
      const value = data.text || (data.metadata && data.metadata.displayText) || '';
      return cleanText(value, 120);
    }
    if (message.type === 'idle') {
      if (data.outcome === 'failed') {
        const err = data.error || {};
        return cleanText(err.message || 'Ошибка выполнения', 120);
      }
      return '';
    }
    if (message.type === 'assistant') {
      if (data.error && data.error.message) return cleanText(data.error.message, 120);
      const content = Array.isArray(data.content) ? data.content : [];
      for (let i = content.length - 1; i >= 0; i -= 1) {
        const part = content[i];
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string' && part.text.trim()) return cleanText(part.text, 140);
        if (part.type === 'tool') {
          const name = part.tool || (part.state && part.state.tool) || 'tool';
          const input = (part.state && part.state.input) || part.input || {};
          const detail = input.description || input.command || input.filePath || input.file_path || input.pattern || '';
          return cleanText(`${name}${detail ? ` · ${detail}` : ''}`, 120);
        }
        if (part.type === 'text' && typeof part.value === 'string') return cleanText(part.value, 140);
      }
      return '';
    }
    return '';
  }

  // Одно открытие БД на обновление: и активные сессии, и последние сообщения.
  snapshot() {
    const now = Date.now();
    if (this._snap && now - this._snap.at < 1200) return this._snap;
    const result = this.withDb((db) => ({
      rows: db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.agent, s.model, s.cost,
                  s.tokens_input, s.tokens_output, s.tokens_reasoning,
                  s.time_created, s.time_updated, s.time_idle, s.idle_outcome,
                  s.parent_id, s.time_archived,
                  p.worktree AS project_worktree, p.name AS project_name
             FROM session_v2 s
             LEFT JOIN project p ON p.id = s.project_id
            WHERE s.parent_id IS NULL AND (s.time_archived IS NULL OR s.time_archived = 0)
            ORDER BY s.time_updated DESC
            LIMIT 80`,
        )
        .all(),
      last: db
        .prepare(
          `SELECT session_id, type, data, seq FROM (
             SELECT session_id, type, data, seq,
                    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS rn
               FROM session_message
           ) WHERE rn = 1`,
        )
        .all(),
    }));

    const last = new Map();
    if (result && Array.isArray(result.last)) {
      for (const row of result.last) last.set(row.session_id, row);
    }
    this._snap = { at: now, rows: (result && result.rows) || [], last };
    return this._snap;
  }

  toSession(row, lastMessage, now) {
    const created = parseTime(row.time_created) || now;
    const updated = parseTime(row.time_updated) || created;
    const idleAt = parseTime(row.time_idle);
    const running = !idleAt || updated > idleAt;
    const stalled = running && now - updated > STALL_MS;
    const attention = stalled;
    const status = attention ? 'waiting' : running ? 'busy' : 'idle';
    const model = this.parseModel(row.model);

    let action = this.describeMessage(lastMessage);
    if (!action) {
      if (status === 'busy') action = 'Работает…';
      else if (row.idle_outcome === 'failed') action = 'Завершилось с ошибкой';
      else action = 'Ожидает следующей задачи';
    }
    if (stalled) action = 'Похоже, ждёт вашего ответа';

    return buildSession({
      agent: this.id,
      agentLabel: this.label,
      id: row.id,
      title: row.title || row.project_name || projectName(row.directory),
      cwd: row.directory || row.project_worktree || '',
      kind: 'interactive',
      status,
      attention,
      stalled,
      startedAt: created,
      updatedAt: updated,
      lastActivityAt: updated,
      model,
      lastAction: action,
      lastText: '',
    });
  }

  readSessions() {
    if (!this.detect()) return [];
    const now = Date.now();
    const { rows, last } = this.snapshot();
    if (!rows.length) return [];
    const sessions = [];
    for (const row of rows) {
      if (now - (parseTime(row.time_updated) || 0) > ACTIVE_MS) continue;
      try {
        sessions.push(this.toSession(row, last.get(row.id), now));
      } catch (error) {
        console.error('Perch: opencode session parse error:', error.message);
      }
    }
    return sortSessions(sessions);
  }

  scanRecent(activeIds) {
    if (!this.detect()) {
      this._recent = [];
      return this._recent;
    }
    const now = Date.now();
    const active = activeIds instanceof Set ? activeIds : new Set();
    const { rows, last } = this.snapshot();
    const recent = [];
    for (const row of rows) {
      if (recent.length >= RECENT_LIMIT) break;
      if (active.has(row.id)) continue;
      const updated = parseTime(row.time_updated) || 0;
      if (!updated) continue;
      const session = this.toSession(row, last.get(row.id), now);
      recent.push({
        agent: this.id,
        agentLabel: this.label,
        id: row.id,
        title: session.title,
        cwd: session.cwd,
        project: session.project,
        model: session.model,
        modelShort: session.modelShort,
        updatedAt: updated,
        messageCount: 0,
      });
    }
    this._recent = recent;
    return recent;
  }

  findRecent(id) {
    if (!id) return null;
    return this._recent.find((session) => session.id === id) || null;
  }

  executable() {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'opencode', 'opencode.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode', 'opencode.exe'),
      path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
    ];
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
    return 'opencode';
  }

  resumeCommand(session) {
    return {
      executable: this.executable(),
      args: ['--session', session.id],
      label: `opencode --session ${session.id}`,
    };
  }
}

module.exports = { OpencodeAgent };
