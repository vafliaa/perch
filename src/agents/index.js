'use strict';

const { ClaudeAgent } = require('./claude');
const { OpencodeAgent } = require('./opencode');
const { CursorAgent } = require('./cursor');
const { CodexAgent } = require('./codex');
const { GeminiAgent } = require('./gemini');

/**
 * Реестр адаптеров агентов. Каждый адаптер умеет:
 *   detect()            — установлен ли агент на этой машине
 *   readSessions()      — активные сессии в общем формате
 *   scanRecent(ids)     — недавние сессии для возобновления
 *   findRecent(id)      — найти недавнюю сессию по id
 *   resumeCommand(s)    — { executable, args, label } или null
 */
function createAgents() {
  return [new ClaudeAgent(), new OpencodeAgent(), new CursorAgent(), new CodexAgent(), new GeminiAgent()];
}

class AgentRegistry {
  constructor(agents = createAgents()) {
    this.agents = agents;
    this.active = new Set();
    this.refreshAvailability();
  }

  refreshAvailability() {
    this.active = new Set();
    for (const agent of this.agents) {
      try {
        if (agent.detect()) this.active.add(agent.id);
      } catch (error) {
        console.warn(`Perch: agent "${agent.id}" detect failed:`, error.message);
      }
    }
    return this.active;
  }

  list() {
    return this.agents;
  }

  enabled() {
    return this.agents.filter((agent) => this.active.has(agent.id));
  }

  get(id) {
    return this.agents.find((agent) => agent.id === id) || null;
  }

  status() {
    return this.agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      accent: agent.accent,
      installed: this.active.has(agent.id),
      installHint: agent.installHint || '',
      usage: Boolean(agent.supportsUsage),
    }));
  }

  readSessions() {
    const sessions = [];
    for (const agent of this.enabled()) {
      try {
        sessions.push(...agent.readSessions());
      } catch (error) {
        console.error(`Perch: ${agent.id} readSessions failed:`, error.message);
      }
    }
    return sessions;
  }

  scanRecent(activeIds) {
    const recent = [];
    for (const agent of this.enabled()) {
      try {
        const list = agent.scanRecent(activeIds) || [];
        if (typeof agent.setRecent === 'function') agent.setRecent(list);
        recent.push(...list);
      } catch (error) {
        console.error(`Perch: ${agent.id} scanRecent failed:`, error.message);
      }
    }
    recent.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return recent.slice(0, 8);
  }

  findRecent(id) {
    if (!id) return null;
    for (const agent of this.enabled()) {
      try {
        const found = agent.findRecent(id);
        if (found) return found;
      } catch {
        // keep looking
      }
    }
    return null;
  }

  agentFor(session) {
    if (!session) return null;
    if (session.agent) {
      const agent = this.get(session.agent);
      if (agent) return agent;
    }
    // старый формат без поля agent — пробуем найти владельца по id
    for (const agent of this.enabled()) {
      try {
        if (agent.findRecent && agent.findRecent(session.id)) return agent;
      } catch {
        // ignore
      }
    }
    return null;
  }

  resumeCommand(session) {
    const agent = this.agentFor(session);
    if (!agent || typeof agent.resumeCommand !== 'function') return null;
    try {
      return agent.resumeCommand(session);
    } catch (error) {
      console.warn(`Perch: ${agent.id} resumeCommand failed:`, error.message);
      return null;
    }
  }

  claudeDir() {
    const claude = this.get('claude');
    return claude ? claude.claudeDir : '';
  }
}

module.exports = { AgentRegistry, createAgents };
