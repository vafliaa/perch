'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_LABELS = [
  [/opus-5/i, 'Opus 5'],
  [/opus-4[-.]7/i, 'Opus 4.7'],
  [/opus-4[-.]6/i, 'Opus 4.6'],
  [/opus-4[-.]5/i, 'Opus 4.5'],
  [/sonnet-5/i, 'Sonnet 5'],
  [/sonnet-4[-.]6/i, 'Sonnet 4.6'],
  [/sonnet-4[-.]5/i, 'Sonnet 4.5'],
  [/haiku-4[-.]5/i, 'Haiku 4.5'],
  [/gpt-5/i, 'GPT-5'],
  [/o[34]-mini/i, 'o4-mini'],
  [/codex/i, 'Codex'],
  [/gemini-3/i, 'Gemini 3'],
  [/gemini-2\.5/i, 'Gemini 2.5'],
  [/gemini/i, 'Gemini'],
  [/deepseek/i, 'DeepSeek'],
  [/glm/i, 'GLM'],
  [/qwen/i, 'Qwen'],
  [/kimi/i, 'Kimi'],
  [/grok/i, 'Grok'],
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function cleanText(value, max = 110) {
  if (!value) return '';
  let text = String(value)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<[^>]{1,120}>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

function projectName(cwd) {
  if (!cwd) return 'Без папки';
  const normalized = String(cwd).replace(/[\\/]+$/, '');
  return path.basename(normalized) || normalized;
}

function shortModel(model) {
  if (!model) return '';
  const raw = String(model);
  for (const [re, label] of MODEL_LABELS) {
    if (re.test(raw)) return label;
  }
  return cleanText(
    raw
      .replace(/^claude-/i, '')
      .replace(/-\d{8}$/i, '')
      .replace(/[-_]/g, ' '),
    22,
  ).replace(/\b\w/g, (c) => c.toUpperCase());
}

function modelContextLimit(model, used) {
  const name = String(model || '').toLowerCase();
  if (name.includes('[1m]') || /opus-5|sonnet-5|claude-5/.test(name)) return 1_000_000;
  if (/gemini-3|gemini-2\.5/.test(name)) return 1_000_000;
  if (/gpt-5|codex/.test(name)) return 400_000;
  if (used && used > 210_000) return 1_000_000;
  return 200_000;
}

function parseTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeStatus(raw) {
  const status = String(raw || '').toLowerCase();
  if (['waiting', 'needs_attention', 'needs-attention', 'attention', 'permission', 'prompt', 'blocked'].includes(status)) {
    return 'waiting';
  }
  if (['busy', 'working', 'running', 'thinking', 'active', 'streaming'].includes(status)) return 'busy';
  return 'idle';
}

const SEVERITY_ORDER = ['normal', 'warning', 'critical'];

function severityFor(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return 'normal';
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warning';
  return 'normal';
}

function formatPlan(raw) {
  const value = String(raw || '').toLowerCase().replace(/^claude_/, '');
  if (value === 'max') return 'MAX';
  if (value === 'pro') return 'PRO';
  if (value === 'team') return 'TEAM';
  if (value === 'enterprise') return 'ENT';
  if (value === 'free') return 'FREE';
  return value ? value.toUpperCase() : '';
}

function readTail(file, maxBytes) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  if (!length) return { text: '', stat };
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (stat.size > length) {
    const firstBreak = text.indexOf('\n');
    text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  }
  return { text, stat };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sortSessions(sessions) {
  const rank = (s) => (s.attention ? 0 : s.status === 'busy' ? 1 : s.status === 'idle' ? 2 : 3);
  return sessions.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Приводит «сырую» сессию любого агента к единому виду, который понимает интерфейс.
 */
function buildSession(input) {
  const now = Date.now();
  const status = normalizeStatus(input.status);
  const lastActivityAt = input.lastActivityAt || input.updatedAt || input.startedAt || now;
  const contextTokens = Number(input.contextTokens) || 0;
  const contextLimit = input.contextLimit || modelContextLimit(input.model, contextTokens);
  const contextPct = contextTokens
    ? clamp(Math.round((contextTokens / contextLimit) * 100), 0, 100)
    : 0;

  return {
    agent: input.agent || 'unknown',
    agentLabel: input.agentLabel || '',
    id: String(input.id),
    pid: input.pid || 0,
    title: cleanText(input.title, 78) || input.agentLabel || 'Сессия',
    cwd: input.cwd || '',
    project: input.project || projectName(input.cwd),
    kind: input.kind === 'bg' ? 'bg' : 'interactive',
    status,
    attention: Boolean(input.attention),
    stalled: Boolean(input.stalled),
    startedAt: input.startedAt || now,
    updatedAt: input.updatedAt || input.startedAt || now,
    lastActivityAt,
    model: input.model || '',
    modelShort: input.modelShort || shortModel(input.model),
    contextTokens,
    contextLimit,
    contextPct,
    lastAction: input.lastAction || (status === 'busy' ? 'Работает…' : 'Ожидает следующей задачи'),
    lastText: input.lastText || '',
    lastTool: input.lastTool || '',
    turnMs: input.turnMs || 0,
    messageCount: input.messageCount || 0,
    version: input.version || '',
    transcriptPath: input.transcriptPath || '',
  };
}

module.exports = {
  MODEL_LABELS,
  SEVERITY_ORDER,
  clamp,
  expandHome,
  exists,
  isDir,
  isPidAlive,
  cleanText,
  projectName,
  shortModel,
  modelContextLimit,
  parseTime,
  normalizeStatus,
  severityFor,
  formatPlan,
  readTail,
  readJson,
  sortSessions,
  buildSession,
};
