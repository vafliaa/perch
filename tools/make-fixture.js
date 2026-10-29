'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(process.env.TEMP || process.env.TMP, 'perch-fixture');
const claude = path.join(root, '.claude');
const sessionsDir = path.join(claude, 'sessions');
const projectDir = path.join(claude, 'projects', 'D--FAI');
const pid = Number(process.argv[2]) || process.pid;
const now = Date.now();

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

const activeId = '11111111-1111-4111-8111-111111111111';
const recentId = '22222222-2222-4222-8222-222222222222';
const recentCwd = 'C:\\Users\\Vaflia\\Documents\\Проект по умолчанию\\lumio-windows';

const activeLines = [
  {
    type: 'user',
    cwd: 'D:\\FAI',
    sessionId: activeId,
    timestamp: new Date(now - 120000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'Проверь сборку и тесты проекта' }] },
  },
  {
    type: 'ai-title',
    aiTitle: 'Проверка сборки и тестов',
    sessionId: activeId,
  },
  {
    type: 'assistant',
    cwd: 'D:\\FAI',
    sessionId: activeId,
    timestamp: new Date(now - 20000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }],
      usage: {
        input_tokens: 2200,
        cache_read_input_tokens: 154000,
        cache_creation_input_tokens: 3000,
      },
    },
  },
  {
    type: 'system',
    subtype: 'turn_duration',
    durationMs: 48000,
    messageCount: 18,
    timestamp: new Date(now - 15000).toISOString(),
  },
];

const recentLines = [
  {
    type: 'user',
    cwd: recentCwd,
    sessionId: recentId,
    timestamp: new Date(now - 3900000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'Добавь быстрый запуск последних сессий' }] },
  },
  {
    type: 'ai-title',
    aiTitle: 'Быстрый запуск последних сессий',
    sessionId: recentId,
  },
  {
    type: 'assistant',
    cwd: recentCwd,
    sessionId: recentId,
    timestamp: new Date(now - 3600000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Готово. Добавил блок «Недавние».' }],
      usage: { input_tokens: 900, cache_read_input_tokens: 32000 },
    },
  },
];

const writeLines = (file, lines) => {
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
};

writeLines(path.join(projectDir, `${activeId}.jsonl`), activeLines);
writeLines(path.join(projectDir, `${recentId}.jsonl`), recentLines);

fs.writeFileSync(
  path.join(sessionsDir, 'active.json'),
  JSON.stringify(
    {
      sessionId: activeId,
      pid,
      cwd: 'D:\\FAI',
      status: 'busy',
      startedAt: now - 125000,
      updatedAt: now,
      name: '',
      kind: 'interactive',
      version: '2.1.312',
    },
    null,
    2,
  ),
  'utf8',
);

const recentFile = path.join(projectDir, `${recentId}.jsonl`);
const old = new Date(now - 3600000);
fs.utimesSync(recentFile, old, old);

console.log(JSON.stringify({ root, claude, pid }, null, 2));
