'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  exists,
  isPidAlive,
  cleanText,
  projectName,
  shortModel,
  buildSession,
  sortSessions,
  readTail,
  parseTime,
} = require('./util');

const TAIL_BYTES = 224 * 1024;
const STALL_MS = 4 * 60 * 1000;
const RECENT_LIMIT = 8;
const RECENT_FILE_LIMIT = 24;
const RECENT_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

function promptFromMessage(message) {
  if (!message || !message.content) return '';
  let raw = '';
  if (typeof message.content === 'string') {
    raw = message.content;
  } else if (Array.isArray(message.content)) {
    raw = message.content
      .filter((block) => block && typeof block === 'object' && block.type === 'text' && block.text)
      .map((block) => block.text)
      .join(' ');
  }
  if (!raw || !raw.trim()) return '';
  if (/<local-command|<command-name|<system-reminder|<bash-input|<bash-stdout/i.test(raw)) return '';
  if (/^\s*(Caveat:|This session is being continued|\[Request interrupted)/i.test(raw)) return '';
  const text = cleanText(raw, 120);
  return text.length >= 3 ? text : '';
}

class ClaudeAgent {
  constructor() {
    this.id = 'claude';
    this.label = 'Claude Code';
    this.short = 'Claude';
    this.accent = '#e08a5f';
    this.installHint = 'npm i -g @anthropic-ai/claude-code';
    this.supportsUsage = true;

    this.claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    this.sessionsDir = path.join(this.claudeDir, 'sessions');
    this.projectsDir = path.join(this.claudeDir, 'projects');
    this.credentialsPath = path.join(this.claudeDir, '.credentials.json');
    this.globalConfigPath = path.join(os.homedir(), '.claude.json');

    this.transcriptCache = new Map();
    this.transcriptPaths = new Map();
    this.projectDirs = [];
    this.projectDirsAt = 0;
  }

  detect() {
    return exists(this.claudeDir);
  }

  refreshProjectDirs() {
    if (Date.now() - this.projectDirsAt < 30_000 && this.projectDirs.length) return;
    this.projectDirsAt = Date.now();
    try {
      this.projectDirs = fs
        .readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(this.projectsDir, entry.name));
    } catch {
      this.projectDirs = [];
    }
  }

  findTranscript(sessionId) {
    if (!sessionId) return null;
    const cached = this.transcriptPaths.get(sessionId);
    if (cached && exists(cached)) return cached;
    this.refreshProjectDirs();
    for (const dir of this.projectDirs) {
      const candidate = path.join(dir, `${sessionId}.jsonl`);
      if (exists(candidate)) {
        this.transcriptPaths.set(sessionId, candidate);
        return candidate;
      }
    }
    return null;
  }

  readHeadInfo(file, size) {
    const result = { headTitle: '', cwd: '', firstPrompt: '', sessionId: '' };
    try {
      const length = Math.min(size, 768 * 1024);
      if (!length) return result;
      const buffer = Buffer.allocUnsafe(length);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, 0);
      } finally {
        fs.closeSync(fd);
      }

      for (const line of buffer.toString('utf8').split('\n')) {
        if (!line || line[0] !== '{') continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        if (!result.headTitle && entry.type === 'ai-title' && entry.aiTitle) {
          result.headTitle = cleanText(entry.aiTitle, 78);
        }
        if (!result.cwd && typeof entry.cwd === 'string' && entry.cwd) result.cwd = entry.cwd;
        if (!result.sessionId && entry.sessionId) result.sessionId = String(entry.sessionId);
        if (!result.firstPrompt && entry.type === 'user' && !entry.isSidechain) {
          result.firstPrompt = promptFromMessage(entry.message);
        }
      }
    } catch {
      // ignore
    }
    return result;
  }

  readTranscript(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const cached = this.transcriptCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.data;
    }

    let text = '';
    try {
      text = readTail(file, TAIL_BYTES).text;
    } catch {
      return cached ? cached.data : null;
    }

    const previous = cached && cached.data;
    const data = {
      aiTitle: '',
      headTitle: previous ? previous.headTitle || '' : '',
      firstPrompt: previous ? previous.firstPrompt || '' : '',
      cwd: previous ? previous.cwd || '' : '',
      headScanned: Boolean(previous && previous.headScanned),
      model: '',
      contextTokens: 0,
      lastAction: '',
      lastText: '',
      lastAt: 0,
      turnMs: 0,
      messageCount: 0,
      lastTool: '',
    };

    if (!data.headScanned || (!data.headTitle && !data.cwd)) {
      const head = this.readHeadInfo(file, stat.size);
      if (!data.headTitle) data.headTitle = head.headTitle;
      if (!data.firstPrompt) data.firstPrompt = head.firstPrompt;
      if (!data.cwd) data.cwd = head.cwd;
      data.headScanned = true;
    }

    for (const line of text.split('\n')) {
      if (!line || line[0] !== '{') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const entryTime = parseTime(entry.timestamp);
      if (entryTime && entryTime > data.lastAt) data.lastAt = entryTime;
      if (!data.cwd && typeof entry.cwd === 'string' && entry.cwd) data.cwd = entry.cwd;

      if (entry.type === 'ai-title' && entry.aiTitle) data.aiTitle = cleanText(entry.aiTitle, 72);

      if (entry.type === 'system') {
        if (entry.subtype === 'turn_duration') {
          if (Number.isFinite(entry.durationMs)) data.turnMs = entry.durationMs;
          if (Number.isFinite(entry.messageCount)) data.messageCount = entry.messageCount;
          if (entryTime) data.lastAt = entryTime;
        }
        continue;
      }

      if (entry.type !== 'assistant' || entry.isSidechain) continue;
      const message = entry.message || {};
      if (message.model) data.model = message.model;

      const usage = message.usage;
      if (usage) {
        const total =
          (Number(usage.input_tokens) || 0) +
          (Number(usage.cache_read_input_tokens) || 0) +
          (Number(usage.cache_creation_input_tokens) || 0);
        if (total) data.contextTokens = total;
      }

      if (Array.isArray(message.content)) {
        for (let i = message.content.length - 1; i >= 0; i -= 1) {
          const block = message.content[i];
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_use' && block.name) {
            const input = block.input || {};
            const detail =
              input.description ||
              input.command ||
              input.file_path ||
              input.path ||
              input.pattern ||
              input.query ||
              input.url ||
              input.prompt ||
              '';
            data.lastTool = block.name;
            data.lastAction = cleanText(`${block.name}${detail ? ` · ${detail}` : ''}`, 120);
            break;
          }
          if (block.type === 'text' && block.text) {
            const textValue = cleanText(block.text, 140);
            if (textValue) {
              data.lastText = textValue;
              data.lastAction = textValue;
              break;
            }
          }
        }
      } else if (typeof message.content === 'string') {
        const textValue = cleanText(message.content, 140);
        if (textValue) {
          data.lastText = textValue;
          data.lastAction = textValue;
        }
      }
    }

    if (!data.aiTitle && previous && previous.aiTitle) data.aiTitle = previous.aiTitle;
    if (!data.lastAt) data.lastAt = stat.mtimeMs;

    this.transcriptCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    if (this.transcriptCache.size > 60) {
      const oldest = this.transcriptCache.keys().next().value;
      this.transcriptCache.delete(oldest);
    }
    return data;
  }

  enrich(session, now) {
    const info = this.readTranscript(this.findTranscript(session.sessionId));
    const status = String(session.status || '').toLowerCase();
    const normalized =
      ['waiting', 'needs_attention', 'needs-attention', 'attention', 'permission', 'prompt', 'blocked'].includes(status)
        ? 'waiting'
        : ['busy', 'working', 'running', 'thinking', 'active'].includes(status)
          ? 'busy'
          : 'idle';
    const lastActivityAt = (info && info.lastAt) || session.updatedAt || session.startedAt || now;
    const stalled = normalized === 'busy' && now - lastActivityAt > STALL_MS;
    const attention = normalized === 'waiting' || stalled;

    let action = info && info.lastAction;
    if (!action) action = normalized === 'busy' ? 'Работает…' : 'Ожидает следующей задачи';
    if (stalled) action = 'Похоже, ждёт вашего ответа';

    const fallbackTitle = session.name || projectName(session.cwd);
    const rawTitle = (info && (info.headTitle || info.aiTitle)) || fallbackTitle || this.label;

    return buildSession({
      agent: this.id,
      agentLabel: this.label,
      id: session.sessionId,
      pid: session.pid,
      title: rawTitle,
      cwd: session.cwd || '',
      kind: session.kind === 'bg' ? 'bg' : 'interactive',
      status: normalized,
      attention,
      stalled,
      startedAt: session.startedAt || now,
      updatedAt: session.updatedAt || session.startedAt || now,
      lastActivityAt,
      model: (info && info.model) || '',
      contextTokens: (info && info.contextTokens) || 0,
      lastAction: action,
      lastText: (info && info.lastText) || '',
      lastTool: (info && info.lastTool) || '',
      turnMs: (info && info.turnMs) || 0,
      messageCount: (info && info.messageCount) || 0,
      version: session.version || '',
      transcriptPath: this.findTranscript(session.sessionId) || '',
    });
  }

  readSessions() {
    let files = [];
    try {
      files = fs.readdirSync(this.sessionsDir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }

    const byId = new Map();
    for (const fileName of files) {
      const fullPath = path.join(this.sessionsDir, fileName);
      let session;
      try {
        session = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch {
        continue;
      }
      if (!session || !session.sessionId || !session.pid) continue;
      if (!isPidAlive(session.pid)) continue;
      const existing = byId.get(session.sessionId);
      if (existing && (existing.updatedAt || 0) >= (session.updatedAt || 0)) continue;
      byId.set(session.sessionId, session);
    }

    const now = Date.now();
    const sessions = [];
    for (const session of byId.values()) {
      try {
        sessions.push(this.enrich(session, now));
      } catch (error) {
        console.error('Perch: Claude session parse error:', error.message);
      }
    }
    return sortSessions(sessions);
  }

  scanRecent(activeIds, lastSessions) {
    const now = Date.now();
    this.refreshProjectDirs();
    const active = activeIds instanceof Set ? activeIds : new Set();
    const candidates = [];

    for (const dir of this.projectDirs) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, entry.name);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.size < 400) continue;
        if (now - stat.mtimeMs > RECENT_MAX_AGE_MS) continue;
        candidates.push({ file, stat, id: entry.name.slice(0, -'.jsonl'.length) });
      }
    }

    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    const seen = new Set();
    const recent = [];
    for (const candidate of candidates) {
      if (recent.length >= RECENT_LIMIT || seen.size >= RECENT_FILE_LIMIT) break;
      if (active.has(candidate.id) || seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      let info = null;
      try {
        info = this.readTranscript(candidate.file);
      } catch {
        // unreadable transcript
      }

      const cwd = (info && info.cwd) || '';
      const rawTitle =
        (info && (info.headTitle || info.aiTitle || info.firstPrompt)) || projectName(cwd) || 'Сессия Claude Code';
      const title = cleanText(rawTitle, 64) || 'Сессия Claude Code';
      const marker = `${candidate.file} ${cwd} ${title}`;
      if (/claude-mem-observer-sessions|claude-mem[\\/]|condense the tool payload|memory observer/i.test(marker)) continue;
      if (!cwd && !(info && (info.headTitle || info.firstPrompt))) continue;

      recent.push({
        agent: this.id,
        agentLabel: this.label,
        id: candidate.id,
        title,
        cwd,
        project: projectName(cwd),
        model: (info && info.model) || '',
        modelShort: shortModel(info && info.model),
        updatedAt: candidate.stat.mtimeMs,
        messageCount: (info && info.messageCount) || 0,
        transcriptPath: candidate.file,
      });
    }

    if (lastSessions) this.lastSessions = lastSessions;
    return recent;
  }

  findRecent(id) {
    if (!id) return null;
    return (this._recent || []).find((session) => session.id === id) || null;
  }

  setRecent(list) {
    this._recent = list;
  }

  readOauth() {
    const credentials = require('./util').readJson(this.credentialsPath);
    return (credentials && credentials.claudeAiOauth) || null;
  }

  readPlan(oauth) {
    let raw = oauth && oauth.subscriptionType;
    let tier = (oauth && oauth.rateLimitTier) || '';
    if (!raw) {
      const global = require('./util').readJson(this.globalConfigPath);
      const account = (global && global.oauthAccount) || {};
      raw = account.organizationType || account.userRateLimitTier || '';
      tier = tier || account.organizationRateLimitTier || '';
    }
    return { plan: require('./util').formatPlan(raw), planRaw: String(raw || ''), tier };
  }

  executable() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const candidates = [
      path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
      path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
    ];
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
    return 'claude';
  }

  resumeCommand(session) {
    return { executable: this.executable(), args: ['--resume', session.id], label: `claude --resume ${session.id}` };
  }
}

module.exports = { ClaudeAgent, promptFromMessage };
