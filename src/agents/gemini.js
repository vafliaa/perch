'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { exists, isDir, cleanText, projectName, buildSession, sortSessions, parseTime } = require('./util');

const ACTIVE_MS = 30 * 60 * 1000;
const RECENT_LIMIT = 8;
const STALL_MS = 4 * 60 * 1000;

/**
 * Gemini CLI держит историю чатов в ~/.gemini/tmp/<hash>/chats/*.json,
 * а Antigravity — сводку сессий в conversations/conversation_summaries.db.
 * Читаем оба источника и приводим к общему виду.
 */
class GeminiAgent {
  constructor() {
    this.id = 'gemini';
    this.label = 'Gemini CLI';
    this.short = 'Gemini';
    this.accent = '#8ab4f8';
    this.installHint = 'npm i -g @google/gemini-cli';
    this.supportsUsage = false;
    this.root = path.join(os.homedir(), '.gemini');
    this.tmpDir = path.join(this.root, 'tmp');
    this.dbCandidates = [
      path.join(this.root, 'antigravity', 'conversations', 'conversation_summaries.db'),
      path.join(this.root, 'antigravity', 'conversation_summaries.db'),
    ];
    this._recent = [];
    this._sqlite = undefined;
  }

  detect() {
    return isDir(this.root);
  }

  sqlite() {
    if (this._sqlite !== undefined) return this._sqlite;
    try {
      const mod = require('node:sqlite');
      this._sqlite = mod && mod.DatabaseSync ? mod.DatabaseSync : null;
    } catch {
      this._sqlite = null;
    }
    return this._sqlite;
  }

  withDb(fn) {
    const DatabaseSync = this.sqlite();
    if (!DatabaseSync) return null;
    const dbPath = this.dbCandidates.find((candidate) => exists(candidate));
    if (!dbPath) return null;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 1500');
      return fn(db);
    } catch (error) {
      console.warn('Perch: gemini db error:', error.message);
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

  listChatFiles() {
    const out = [];
    let hashes = [];
    try {
      hashes = fs.readdirSync(this.tmpDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const hash of hashes) {
      if (!hash.isDirectory()) continue;
      const chatsDir = path.join(this.tmpDir, hash.name, 'chats');
      let files = [];
      try {
        files = fs.readdirSync(chatsDir).filter((name) => name.endsWith('.json'));
      } catch {
        continue;
      }
      for (const name of files) {
        const file = path.join(chatsDir, name);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        out.push({ file, mtimeMs: stat.mtimeMs });
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  parseChat(file) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object') return null;

    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    let firstUser = '';
    let lastText = '';
    let lastRole = '';
    let lastAt = 0;
    let lastTool = '';

    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const at = parseTime(message.timestamp);
      if (at && at > lastAt) lastAt = at;
      const role = String(message.type || message.role || '');
      const content = Array.isArray(message.content) ? message.content : [];
      let textValue = '';
      for (let i = content.length - 1; i >= 0; i -= 1) {
        const part = content[i];
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string' && part.text.trim()) {
          textValue = cleanText(part.text, 140);
          break;
        }
        if (part.functionCall || part.function_call) {
          const call = part.functionCall || part.function_call;
          lastTool = cleanText(`${call.name || 'tool'}`, 60);
        }
      }
      if (!textValue && !lastTool) continue;
      if (role === 'user') {
        if (!firstUser && textValue) firstUser = textValue;
        lastRole = 'user';
      } else {
        lastRole = 'model';
      }
      if (textValue) lastText = textValue;
    }

    const startedAt = parseTime(raw.startTime) || parseTime(raw.start_time) || 0;
    const updatedAt = parseTime(raw.lastUpdated) || parseTime(raw.last_updated) || lastAt || 0;

    return {
      id: String(raw.sessionId || raw.session_id || path.basename(file, '.json')),
      cwd: raw.cwd || raw.projectPath || '',
      firstUser,
      lastText,
      lastRole,
      lastTool,
      startedAt,
      updatedAt,
      messageCount: messages.length,
    };
  }

  chatSessions(now) {
    const sessions = [];
    for (const item of this.listChatFiles()) {
      const info = this.parseChat(item.file);
      if (!info) continue;
      const updated = info.updatedAt || item.mtimeMs;
      if (now - updated > ACTIVE_MS) continue;
      const running = info.lastRole === 'user';
      const stalled = running && now - updated > STALL_MS;
      sessions.push(
        buildSession({
          agent: this.id,
          agentLabel: this.label,
          id: info.id,
          title: info.firstUser || projectName(info.cwd) || 'Сессия Gemini',
          cwd: info.cwd,
          kind: 'interactive',
          status: stalled ? 'waiting' : running ? 'busy' : 'idle',
          attention: stalled,
          stalled,
          startedAt: info.startedAt || updated,
          updatedAt: updated,
          lastActivityAt: updated,
          lastAction: stalled
            ? 'Похоже, ждёт вашего ответа'
            : running
              ? 'Работает…'
              : info.lastText || 'Ожидает следующей задачи',
          lastText: info.lastText,
          lastTool: info.lastTool,
          messageCount: info.messageCount,
          transcriptPath: item.file,
        }),
      );
    }
    return sessions;
  }

  summarySessions(now) {
    const rows =
      this.withDb((db) =>
        db
          .prepare(
            `SELECT conversation_id, title, preview, step_count, last_modified_time,
                    workspace_uris, status, agent_name, parent_conversation_id
               FROM conversation_summaries
              ORDER BY last_modified_time DESC
              LIMIT 60`,
          )
          .all(),
      ) || [];

    const sessions = [];
    for (const row of rows) {
      if (row.parent_conversation_id) continue;
      const updated = parseTime(row.last_modified_time);
      if (!updated || now - updated > ACTIVE_MS) continue;
      let cwd = '';
      try {
        const uris = JSON.parse(row.workspace_uris || '[]');
        if (Array.isArray(uris) && uris[0]) cwd = decodeURIComponent(String(uris[0]).replace(/^file:\/\/\/?/, ''));
      } catch {
        // workspace may be a plain path
      }
      sessions.push(
        buildSession({
          agent: this.id,
          agentLabel: this.label,
          id: String(row.conversation_id),
          title: row.title || row.preview || projectName(cwd) || 'Сессия Gemini',
          cwd,
          kind: 'interactive',
          status: now - updated > STALL_MS ? 'waiting' : 'busy',
          attention: now - updated > STALL_MS,
          startedAt: updated,
          updatedAt: updated,
          lastActivityAt: updated,
          lastAction: row.preview || 'Работает…',
          messageCount: Number(row.step_count) || 0,
        }),
      );
    }
    return sessions;
  }

  readSessions() {
    if (!this.detect()) return [];
    const now = Date.now();
    const byId = new Map();
    for (const session of this.chatSessions(now)) byId.set(session.id, session);
    for (const session of this.summarySessions(now)) {
      if (!byId.has(session.id)) byId.set(session.id, session);
    }
    return sortSessions([...byId.values()]);
  }

  scanRecent(activeIds) {
    if (!this.detect()) {
      this._recent = [];
      return this._recent;
    }
    const active = activeIds instanceof Set ? activeIds : new Set();
    const recent = [];
    for (const item of this.listChatFiles()) {
      if (recent.length >= RECENT_LIMIT) break;
      const info = this.parseChat(item.file);
      if (!info || active.has(info.id)) continue;
      recent.push({
        agent: this.id,
        agentLabel: this.label,
        id: info.id,
        title: info.firstUser || projectName(info.cwd) || 'Сессия Gemini',
        cwd: info.cwd,
        project: projectName(info.cwd),
        model: '',
        modelShort: '',
        updatedAt: info.updatedAt || item.mtimeMs,
        messageCount: info.messageCount,
        transcriptPath: item.file,
      });
    }
    this._recent = recent;
    return recent;
  }

  findRecent(id) {
    if (!id) return null;
    return this._recent.find((session) => session.id === id) || null;
  }

  resumeCommand() {
    return null;
  }
}

module.exports = { GeminiAgent };
