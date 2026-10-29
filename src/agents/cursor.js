'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { exists, isDir, cleanText, projectName, readTail, buildSession, sortSessions } = require('./util');

const ACTIVE_MS = 30 * 60 * 1000;
const RECENT_LIMIT = 8;
const TAIL_BYTES = 96 * 1024;

/**
 * Cursor CLI (`cursor-agent`) складывает переписку в
 * ~/.cursor/projects/<slug>/agent-transcripts/<chatId>/<chatId>.jsonl
 * Формат строк: { role, message } и { type: 'turn_ended', status, error }.
 */
class CursorAgent {
  constructor() {
    this.id = 'cursor';
    this.label = 'Cursor CLI';
    this.short = 'Cursor';
    this.accent = '#a78bfa';
    this.installHint = 'curl https://cursor.com/install -fsS | bash   (Windows: npm i -g cursor-agent)';
    this.supportsUsage = false;
    this.projectsDir = path.join(os.homedir(), '.cursor', 'projects');
    this._recent = [];
    this._cache = new Map();
  }

  detect() {
    return isDir(this.projectsDir);
  }

  // slug вида "d-FAI" → "D:\FAI"
  decodeSlug(slug) {
    const match = /^([a-zA-Z])-(.+)$/.exec(slug || '');
    if (!match) return '';
    const candidate = `${match[1].toUpperCase()}:\\${match[2].replace(/-/g, '\\')}`;
    return isDir(candidate) ? candidate : '';
  }

  readTranscript(file) {
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
      firstPrompt: '',
      lastText: '',
      lastRole: '',
      lastAtIndex: 0,
      ended: false,
      endedStatus: '',
      lastError: '',
      messageCount: 0,
      lastTool: '',
    };

    for (const line of text.split('\n')) {
      if (!line || line[0] !== '{') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === 'turn_ended') {
        data.ended = true;
        data.endedStatus = String(entry.status || '');
        data.lastError = cleanText(entry.error || '', 120);
        continue;
      }
      if (!entry.role) continue;

      data.ended = false;
      data.lastRole = entry.role;
      data.messageCount += 1;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;

      let textValue = '';
      let toolValue = '';
      for (let i = content.length - 1; i >= 0; i -= 1) {
        const part = content[i];
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && part.text) {
          textValue = cleanText(
            String(part.text).replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '').replace(/<\/?user_query>/gi, ''),
            140,
          );
          break;
        }
        if (part.type === 'tool_use' && part.name) {
          const input = part.input || {};
          const detail = input.command || input.file_path || input.path || input.pattern || input.query || input.description || '';
          toolValue = cleanText(`${part.name}${detail ? ` · ${detail}` : ''}`, 120);
          break;
        }
      }
      if (entry.role === 'user' && textValue && !data.firstPrompt) data.firstPrompt = textValue;
      if (textValue) data.lastText = textValue;
      if (toolValue) data.lastTool = toolValue;
      if (stat.mtimeMs) data.lastAtIndex = stat.mtimeMs;
    }

    this._cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    if (this._cache.size > 80) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    return data;
  }

  toSession(chatId, file, cwd, now) {
    const info = this.readTranscript(file);
    const stat = fs.statSync(file);
    const updated = stat.mtimeMs;
    const running = Boolean(info && info.lastRole === 'user' && !info.ended);
    const status = running ? 'busy' : 'idle';
    const title = (info && info.firstPrompt) || projectName(cwd) || 'Сессия Cursor';

    let action = status === 'busy' ? 'Работает…' : 'Ожидает следующей задачи';
    if (info && info.ended && info.endedStatus === 'error' && info.lastError) {
      action = info.lastError;
    } else if (info && info.lastTool) {
      action = info.lastTool;
    } else if (info && info.lastText) {
      action = info.lastText;
    }

    return buildSession({
      agent: this.id,
      agentLabel: this.label,
      id: chatId,
      title,
      cwd: cwd || '',
      kind: 'interactive',
      status,
      attention: false,
      startedAt: updated,
      updatedAt: updated,
      lastActivityAt: updated,
      lastAction: action,
      lastText: (info && info.lastText) || '',
      lastTool: (info && info.lastTool) || '',
      messageCount: (info && info.messageCount) || 0,
      transcriptPath: file,
    });
  }

  listTranscripts() {
    const out = [];
    let projects = [];
    try {
      projects = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.name.startsWith('.')) continue;
      const transcriptsDir = path.join(this.projectsDir, project.name, 'agent-transcripts');
      let chats = [];
      try {
        chats = fs.readdirSync(transcriptsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const cwd = this.decodeSlug(project.name);
      for (const chat of chats) {
        if (!chat.isDirectory()) continue;
        const file = path.join(transcriptsDir, chat.name, `${chat.name}.jsonl`);
        if (!exists(file)) continue;
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        out.push({ id: chat.name, file, cwd, mtimeMs: stat.mtimeMs });
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  readSessions() {
    if (!this.detect()) return [];
    const now = Date.now();
    const sessions = [];
    for (const item of this.listTranscripts()) {
      if (now - item.mtimeMs > ACTIVE_MS) break;
      try {
        sessions.push(this.toSession(item.id, item.file, item.cwd, now));
      } catch (error) {
        console.error('Perch: cursor session parse error:', error.message);
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
    for (const item of this.listTranscripts()) {
      if (recent.length >= RECENT_LIMIT) break;
      if (active.has(item.id)) continue;
      let info = null;
      try {
        info = this.readTranscript(item.file);
      } catch {
        // unreadable
      }
      recent.push({
        agent: this.id,
        agentLabel: this.label,
        id: item.id,
        title: (info && info.firstPrompt) || projectName(item.cwd) || 'Сессия Cursor',
        cwd: item.cwd,
        project: projectName(item.cwd),
        model: '',
        modelShort: '',
        updatedAt: item.mtimeMs,
        messageCount: (info && info.messageCount) || 0,
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

  // Cursor CLI не даёт надёжного «продолжить по id» — открываем папку проекта.
  resumeCommand() {
    return null;
  }
}

module.exports = { CursorAgent };
