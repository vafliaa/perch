'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { exists, isDir, cleanText, projectName, readTail, buildSession, sortSessions, parseTime } = require('./util');

const ACTIVE_MS = 30 * 60 * 1000;
const RECENT_LIMIT = 8;
const TAIL_BYTES = 128 * 1024;
const SCAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * OpenAI Codex CLI пишет «роллауты» в
 * ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<дата>-<uuid>.jsonl
 * Первая строка — session_meta (id, cwd), далее response_item / event_msg.
 */
class CodexAgent {
  constructor() {
    this.id = 'codex';
    this.label = 'Codex CLI';
    this.short = 'Codex';
    this.accent = '#8bd49c';
    this.installHint = 'npm i -g @openai/codex';
    this.supportsUsage = false;
    this.root = path.join(os.homedir(), '.codex');
    this.sessionsDir = path.join(this.root, 'sessions');
    this._recent = [];
    this._cache = new Map();
  }

  detect() {
    return isDir(this.sessionsDir);
  }

  listFiles() {
    const out = [];
    const now = Date.now();
    const walk = (dir, depth) => {
      if (depth > 4 || out.length > 400) return;
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!item.name.startsWith('rollout-') || !item.name.endsWith('.jsonl')) continue;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (now - stat.mtimeMs > SCAN_MAX_AGE_MS) continue;
        out.push({ file: full, id: item.name.replace(/^rollout-/, '').replace(/\.jsonl$/, ''), mtimeMs: stat.mtimeMs });
      }
    };
    walk(this.sessionsDir, 0);
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  readRollout(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const cached = this._cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.data;

    let text = '';
    try {
      text = readTail(file, TAIL_BYTES).text;
    } catch {
      text = '';
    }

    const data = {
      sessionId: '',
      cwd: '',
      model: '',
      firstUser: '',
      lastAssistant: '',
      lastAction: '',
      lastAt: 0,
      messageCount: 0,
    };

    for (const line of text.split('\n')) {
      if (!line || line[0] !== '{') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const at = parseTime(entry.timestamp);
      if (at && at > data.lastAt) data.lastAt = at;
      const payload = entry.payload || {};

      if (entry.type === 'session_meta' || payload.type === 'session_meta') {
        data.sessionId = data.sessionId || String(payload.id || payload.session_id || '');
        data.cwd = data.cwd || String(payload.cwd || '');
        if (payload.model) data.model = String(payload.model);
        continue;
      }

      if (payload.type === 'message' && Array.isArray(payload.content)) {
        const role = payload.role;
        let textValue = '';
        for (const part of payload.content) {
          if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim()) {
            textValue = cleanText(part.text, 140);
          }
        }
        if (!textValue) continue;
        data.messageCount += 1;
        if (role === 'user') {
          if (!data.firstUser) data.firstUser = textValue;
          data.lastAction = textValue;
        } else {
          data.lastAssistant = textValue;
          data.lastAction = textValue;
        }
        continue;
      }

      if (payload.type === 'function_call' || payload.type === 'local_shell_call') {
        const name = payload.name || payload.type;
        const args = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments || {});
        data.lastAction = cleanText(`${name}${args && args !== '{}' ? ` · ${args}` : ''}`, 120);
        continue;
      }

      if (payload.type === 'agent_message' && typeof payload.message === 'string') {
        data.lastAssistant = cleanText(payload.message, 140);
        data.lastAction = data.lastAssistant;
      }
    }

    if (!data.lastAt) data.lastAt = stat.mtimeMs;
    this._cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    if (this._cache.size > 80) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    return data;
  }

  toSession(item, now) {
    const info = this.readRollout(item.file);
    const updated = (info && info.lastAt) || item.mtimeMs;
    const idle = now - updated > 4 * 60 * 1000;
    const status = idle ? 'idle' : 'busy';
    const cwd = (info && info.cwd) || '';
    const title = (info && info.firstUser) || projectName(cwd) || 'Сессия Codex';
    let action = (info && info.lastAction) || (status === 'busy' ? 'Работает…' : 'Ожидает следующей задачи');
    if (idle && info && info.lastAssistant) action = info.lastAssistant;

    return buildSession({
      agent: this.id,
      agentLabel: this.label,
      id: (info && info.sessionId) || item.id,
      title,
      cwd,
      kind: 'interactive',
      status,
      attention: status === 'busy' && now - updated > 4 * 60 * 1000,
      startedAt: item.mtimeMs,
      updatedAt: updated,
      lastActivityAt: updated,
      model: (info && info.model) || '',
      lastAction: action,
      lastText: (info && info.lastAssistant) || '',
      messageCount: (info && info.messageCount) || 0,
      transcriptPath: item.file,
    });
  }

  readSessions() {
    if (!this.detect()) return [];
    const now = Date.now();
    const sessions = [];
    for (const item of this.listFiles()) {
      if (now - item.mtimeMs > ACTIVE_MS) break;
      try {
        sessions.push(this.toSession(item, now));
      } catch (error) {
        console.error('Perch: codex session parse error:', error.message);
      }
    }
    return sortSessions(sessions);
  }

  scanRecent(activeIds) {
    if (!this.detect()) {
      this._recent = [];
      return this._recent;
    }
    const active = activeIds instanceof Set ? activeIds : new Set();
    const recent = [];
    for (const item of this.listFiles()) {
      if (recent.length >= RECENT_LIMIT) break;
      const session = this.toSession(item, Date.now());
      if (active.has(session.id)) continue;
      recent.push({
        agent: this.id,
        agentLabel: this.label,
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        project: session.project,
        model: session.model,
        modelShort: session.modelShort,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
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

  executable() {
    const appData = process.env.APPDATA || '';
    const candidates = [path.join(appData, 'npm', 'codex.cmd'), path.join(os.homedir(), '.local', 'bin', 'codex')];
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
    return 'codex';
  }

  resumeCommand(session) {
    return { executable: this.executable(), args: ['resume', session.id], label: `codex resume ${session.id}` };
  }
}

module.exports = { CodexAgent };
