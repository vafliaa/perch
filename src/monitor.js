'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { detectVpn } = require('./vpn');
const { AgentRegistry } = require('./agents');
const { clamp, parseTime, severityFor, formatPlan } = require('./agents/util');

const SESSION_POLL_MS = 1500;
const USAGE_POLL_MS = 60 * 1000;
const VPN_POLL_MS = 20 * 1000;
const VPN_FRESH_MS = 15 * 1000;
const RECENT_SCAN_MS = 15 * 1000;
const NOTIFY_THROTTLE_MS = 2 * 60 * 1000;

class Monitor extends EventEmitter {
  constructor({ appDataPath, statusline = null }) {
    super();
    this.agents = new AgentRegistry();
    this.claudeDir = this.agents.claudeDir();
    this.usageCachePath = path.join(appDataPath, 'usage-cache.json');
    this.statusline = statusline;

    this.sessionTimer = null;
    this.usageTimer = null;
    this.vpnTimer = null;
    this.sessionTickRunning = false;
    this.usageRunning = false;
    this.vpnRunning = false;
    this.lastSessions = [];
    this.recentSessions = [];
    this.recentScannedAt = 0;
    this.lastUsage = null;
    this.usageError = null;
    this.usageSource = 'cache';
    this.usageFetchedAt = 0;
    this.usageRetryAt = 0;
    this.usageFailures = 0;
    this.statuslineMtime = 0;
    this.knownStatus = new Map();
    this.notifiedAt = new Map();
    this.lastPublishedKey = '';
    this.started = false;
    this.agentsAt = 0;
    this.vpn = {
      enabled: false,
      status: 'checking',
      reason: 'Проверяю VPN…',
      detail: null,
      checkedAt: 0,
    };

    this.loadUsageCache();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.syncStatuslineUsage();
    this.tick();
    this.ensureVpn(true).then((vpn) => {
      if (vpn && vpn.enabled) this.refreshUsage(true);
      else this.publish();
    });
    this.sessionTimer = setInterval(() => this.tick(), SESSION_POLL_MS);
    this.usageTimer = setInterval(() => this.refreshUsage(false), USAGE_POLL_MS);
    this.vpnTimer = setInterval(() => this.checkVpn(false), VPN_POLL_MS);
  }

  stop() {
    this.started = false;
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.vpnTimer) clearInterval(this.vpnTimer);
    this.sessionTimer = null;
    this.usageTimer = null;
    this.vpnTimer = null;
  }

  loadUsageCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.usageCachePath, 'utf8'));
      if (raw && raw.usage) {
        this.lastUsage = { ...raw.usage, cached: true };
        this.usageFetchedAt = Number(raw.savedAt) || 0;
        this.usageSource = raw.source || raw.usage.source || 'cache';
      }
    } catch {
      // no cached usage yet
    }
  }

  saveUsageCache() {
    if (!this.lastUsage) return;
    try {
      fs.mkdirSync(path.dirname(this.usageCachePath), { recursive: true });
      fs.writeFileSync(
        this.usageCachePath,
        JSON.stringify({ usage: this.lastUsage, savedAt: this.usageFetchedAt, source: this.usageSource }),
        'utf8',
      );
    } catch {
      // non-fatal
    }
  }

  // Перепроверяем установленных агентов не чаще раза в минуту.
  refreshAgents() {
    if (Date.now() - this.agentsAt < 60_000 && this.agents.active.size) return;
    this.agentsAt = Date.now();
    this.agents.refreshAvailability();
  }

  tick() {
    if (this.sessionTickRunning) return;
    this.sessionTickRunning = true;
    try {
      this.syncStatuslineUsage();
      this.refreshAgents();
      this.lastSessions = this.agents.readSessions();
      this.scanRecentSessions();
      this.checkNotifications(this.lastSessions);
      this.publish();
    } catch (error) {
      console.error('Perch monitor tick error:', error);
    } finally {
      this.sessionTickRunning = false;
    }
  }

  scanRecentSessions() {
    const now = Date.now();
    if (now - this.recentScannedAt < RECENT_SCAN_MS) return this.recentSessions;
    this.recentScannedAt = now;
    const activeIds = new Set((this.lastSessions || []).map((session) => session.id));
    this.recentSessions = this.agents.scanRecent(activeIds);
    return this.recentSessions;
  }

  findRecentSession(id) {
    if (!id) return null;
    let found = this.recentSessions.find((session) => session.id === id);
    if (found) return found;
    this.recentScannedAt = 0;
    this.scanRecentSessions();
    found = this.recentSessions.find((session) => session.id === id);
    return found || null;
  }

  stateSnapshot() {
    const usage = this.lastUsage
      ? {
          ...this.lastUsage,
          stale:
            Boolean(this.lastUsage.stale) ||
            (this.usageSource !== 'statusline' && Boolean(this.usageError)) ||
            Date.now() - this.usageFetchedAt > 10 * 60 * 1000,
        }
      : null;
    return {
      sessions: this.lastSessions,
      recent: this.recentSessions,
      usage,
      usageError: this.usageError,
      usageSource: this.usageSource,
      usageFetchedAt: this.usageFetchedAt,
      vpn: { ...this.vpn },
      agents: this.agents.status(),
      statusline: this.statusline ? this.statusline.info() : null,
      claudeDir: this.claudeDir,
      generatedAt: Date.now(),
    };
  }

  // Не шлём в интерфейс одно и то же состояние каждые 1.5 секунды.
  publish(force = false) {
    const state = this.stateSnapshot();
    const key = this.stateKey(state);
    if (!force && key === this.lastPublishedKey) return;
    this.lastPublishedKey = key;
    this.emit('state', state);
  }

  stateKey(state) {
    const sessions = (state.sessions || []).map(
      (s) => `${s.id}:${s.status}:${s.attention ? 1 : 0}:${s.contextPct}:${s.lastAction}:${s.updatedAt}`,
    );
    const recent = (state.recent || []).map((s) => `${s.id}:${s.updatedAt}`);
    const agents = (state.agents || []).map((a) => `${a.id}:${a.installed ? 1 : 0}`);
    return JSON.stringify([
      sessions,
      recent,
      agents,
      state.usage && state.usage.plan,
      state.usage && state.usage.fiveHour && state.usage.fiveHour.pct,
      state.usage && state.usage.weekly && state.usage.weekly.pct,
      state.usageFetchedAt,
      state.usageSource,
      state.usageError && state.usageError.code,
      state.vpn && state.vpn.status,
      state.vpn && state.vpn.reason,
      state.statusline && state.statusline.state,
    ]);
  }

  checkNotifications(sessions) {
    const now = Date.now();
    const seen = new Set();
    for (const session of sessions) {
      seen.add(session.id);
      const previous = this.knownStatus.get(session.id);
      if (previous) {
        const becameIdle = session.status === 'idle' && previous !== 'idle' && session.kind === 'interactive';
        const becameWaiting = session.attention && previous !== 'waiting';
        if (becameIdle || becameWaiting) {
          const key = `${session.id}:${becameWaiting ? 'waiting' : 'idle'}`;
          const last = this.notifiedAt.get(key) || 0;
          if (now - last > NOTIFY_THROTTLE_MS) {
            this.notifiedAt.set(key, now);
            this.emit('notify', { kind: becameWaiting ? 'waiting' : 'done', session });
          }
        }
      }
      this.knownStatus.set(session.id, session.status);
    }
    for (const id of this.knownStatus.keys()) {
      if (!seen.has(id)) this.knownStatus.delete(id);
    }
  }

  readOauth() {
    const claude = this.agents.get('claude');
    return claude && typeof claude.readOauth === 'function' ? claude.readOauth() : null;
  }

  readPlan(oauth) {
    const claude = this.agents.get('claude');
    return claude && typeof claude.readPlan === 'function' ? claude.readPlan(oauth) : { plan: '', planRaw: '', tier: '' };
  }

  normalizeStatusline(payload, mtimeMs) {
    const mapWindow = (window) => {
      if (!window || typeof window !== 'object') return null;
      const pct = Number(window.used_percentage);
      if (!Number.isFinite(pct)) return null;
      const rawReset = Number(window.resets_at);
      const resetsAt =
        Number.isFinite(rawReset) && rawReset > 0 ? (rawReset < 10_000_000_000 ? rawReset * 1000 : rawReset) : 0;
      return { pct: clamp(pct, 0, 100), rawPct: pct, resetsAt, severity: severityFor(pct) };
    };

    const limits = (payload && payload.rate_limits) || {};
    const fiveHour = mapWindow(limits.five_hour);
    const weekly = mapWindow(limits.seven_day);
    const spend = mapWindow(limits.spend_limit);
    const plan = this.readPlan(this.readOauth());
    const rows = [];
    if (fiveHour) rows.push({ kind: 'session', group: 'session', pct: fiveHour.pct, severity: fiveHour.severity, resetsAt: fiveHour.resetsAt, active: true });
    if (weekly) rows.push({ kind: 'weekly_all', group: 'weekly', pct: weekly.pct, severity: weekly.severity, resetsAt: weekly.resetsAt, active: true });
    if (spend) rows.push({ kind: 'spend', group: 'spend_limit', pct: spend.pct, severity: spend.severity, resetsAt: spend.resetsAt, active: true });

    return {
      ok: true,
      plan: plan.plan,
      planRaw: plan.planRaw,
      tier: plan.tier,
      fiveHour,
      weekly,
      opus: null,
      sonnet: null,
      extra: null,
      limits: rows,
      fiveHourBreakdown: null,
      fetchedAt: mtimeMs,
      cached: false,
      stale: false,
      source: 'statusline',
    };
  }

  syncStatuslineUsage() {
    if (!this.statusline || !this.statusline.info().active) return false;
    const snapshot = this.statusline.read();
    if (!snapshot || !snapshot.data) return false;
    if (snapshot.mtimeMs === this.statuslineMtime) return false;
    this.statuslineMtime = snapshot.mtimeMs;

    const limits = snapshot.data.rate_limits;
    if (!limits || (!limits.five_hour && !limits.seven_day && !limits.spend_limit)) return false;

    const usage = this.normalizeStatusline(snapshot.data, snapshot.mtimeMs);
    if (!usage.fiveHour && !usage.weekly && !(usage.limits || []).length) return false;

    // An older bridge snapshot should never overwrite a fresh API response.
    if (this.usageSource === 'api' && this.usageFetchedAt > snapshot.mtimeMs + 2000) return false;

    this.lastUsage = usage;
    this.usageFetchedAt = snapshot.mtimeMs;
    this.usageSource = 'statusline';
    this.usageError = null;
    this.usageRetryAt = 0;
    this.saveUsageCache();
    return true;
  }

  async ensureVpn(force = false) {
    if (!force && this.vpn.checkedAt && Date.now() - this.vpn.checkedAt < VPN_FRESH_MS) return this.vpn;
    if (this.vpnRunning) return this.vpn;

    this.vpnRunning = true;
    const wasEnabled = this.vpn.enabled;
    const wasKey = `${this.vpn.status}:${this.vpn.reason}`;
    try {
      const next = await detectVpn();
      this.vpn = { ...next, checkedAt: Date.now(), status: next.status || (next.enabled ? 'on' : 'off') };

      if (!this.vpn.enabled) {
        this.usageError = null;
        this.usageRetryAt = 0;
      }

      const nextKey = `${this.vpn.status}:${this.vpn.reason}`;
      if (wasEnabled !== this.vpn.enabled || wasKey !== nextKey) this.publish();
      if (this.vpn.enabled && !wasEnabled) setTimeout(() => this.refreshUsage(true), 0);
      return this.vpn;
    } finally {
      this.vpnRunning = false;
    }
  }

  async checkVpn(force = false) {
    const before = this.vpn.enabled;
    await this.ensureVpn(force);
    if (before !== this.vpn.enabled) this.publish();
    return this.vpn;
  }

  async recheck() {
    await this.ensureVpn(true);
    if (this.vpn.enabled) await this.refreshUsage(true);
    else this.publish(true);
    return this.vpn;
  }

  notifyDrawerOpen() {
    if (!this.started) return;
    this.agentsAt = 0;
    this.recentScannedAt = 0;
    this.tick();
    this.ensureVpn(false).then((vpn) => {
      if (!vpn || !vpn.enabled) return;
      if (this.usageSource === 'statusline') return;
      if (Date.now() - this.usageFetchedAt > 60_000) this.refreshUsage(false);
      else this.publish();
    });
  }

  async refreshUsage(force) {
    if (this.usageRunning) return;
    const bridgeUpdated = this.syncStatuslineUsage();
    if (bridgeUpdated) this.publish();

    this.usageRunning = true;

    try {
      const vpn = await this.ensureVpn(Boolean(force));
      if (!vpn.enabled) {
        this.usageError = null;
        return;
      }

      if (!force && this.usageRetryAt && Date.now() < this.usageRetryAt) return;

      const bridgeFresh =
        this.usageSource === 'statusline' && this.statuslineMtime && Date.now() - this.statuslineMtime < 90_000;
      if (!force && bridgeFresh) return;

      const oauth = this.readOauth();
      const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
      if (!token) throw Object.assign(new Error('no-token'), { code: 'NO_TOKEN' });

      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-cli/2.1.312 (external, cli)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        let body = '';
        try {
          body = (await response.text()).replace(/\s+/g, ' ').slice(0, 240);
        } catch {
          // ignore
        }
        const error = new Error(`usage-http-${response.status}`);
        error.code = response.status === 401 ? 'EXPIRED' : 'HTTP';
        error.status = response.status;
        error.body = body;
        throw error;
      }

      const payload = await response.json();
      this.lastUsage = this.normalizeUsage(payload, oauth);
      this.usageError = null;
      this.usageSource = 'api';
      this.usageFetchedAt = Date.now();
      this.usageRetryAt = 0;
      this.usageFailures = 0;
      this.saveUsageCache();
    } catch (error) {
      const status = Number(error.status) || 0;
      const detail = status ? `HTTP ${status}${error.body ? ` · ${error.body}` : ''}` : error && error.message;
      console.warn('Perch usage fetch failed:', detail);
      this.usageFailures += 1;
      const base = status === 403 || status === 429 ? 5 * 60_000 : 2 * 60_000;
      this.usageRetryAt = Date.now() + (this.usageFailures >= 3 ? Math.min(30 * 60_000, base * 2) : base);

      const bridgeActive = Boolean(this.statusline && this.statusline.info().active);
      const bridgeHasData = this.usageSource === 'statusline' && Boolean(this.lastUsage);

      if (!bridgeHasData) {
        let message = 'Не удалось обновить лимиты';
        if (error.code === 'NO_TOKEN' || error.code === 'EXPIRED') message = 'Нужен вход в Claude Code';
        else if (error.name === 'TimeoutError') message = 'Сервер лимитов не ответил';
        else if (status === 403) {
          message = bridgeActive
            ? 'Anthropic отклонил запрос (403). Лимиты подтянутся из Claude Code после первого ответа.'
            : 'Anthropic отклонил запрос (403). Включите VPN и обновите лимиты.';
        } else if (status === 429) message = 'Слишком много запросов. Попробуем позже.';

        this.usageError = { code: error.code || 'FETCH', message, detail, status, at: Date.now() };
      }
    } finally {
      this.usageRunning = false;
      this.publish();
    }
  }

  normalizeUsage(payload, oauth) {
    const first = (value) => (Array.isArray(value) ? value[0] : value) || null;
    const mapWindow = (window) => {
      if (!window || typeof window !== 'object') return null;
      const pct = Number(window.utilization);
      return {
        pct: Number.isFinite(pct) ? clamp(pct, 0, 100) : 0,
        resetsAt: parseTime(window.resets_at),
        severity: window.severity || severityFor(pct),
        limitDollars: window.limit_dollars ?? null,
        usedDollars: window.used_dollars ?? null,
      };
    };

    const fiveHour = mapWindow(payload.five_hour);
    const weekly = mapWindow(payload.seven_day);
    const opus = mapWindow(payload.seven_day_opus);
    const sonnet = mapWindow(payload.seven_day_sonnet);
    const extraRaw = payload.extra_usage || null;
    const extra =
      extraRaw && (extraRaw.is_enabled || extraRaw.utilization != null)
        ? {
            enabled: Boolean(extraRaw.is_enabled),
            pct: Number.isFinite(Number(extraRaw.utilization)) ? clamp(Number(extraRaw.utilization), 0, 100) : null,
            monthlyLimit: extraRaw.monthly_limit ?? null,
            usedCredits: extraRaw.used_credits ?? null,
            currency: extraRaw.currency || 'USD',
          }
        : null;

    const limits = Array.isArray(payload.limits)
      ? payload.limits.map((limit) => ({
          kind: limit.kind,
          group: limit.group,
          pct: Number.isFinite(Number(limit.percent)) ? clamp(Number(limit.percent), 0, 100) : null,
          severity: limit.severity || 'normal',
          resetsAt: parseTime(limit.resets_at),
          active: Boolean(limit.is_active),
        }))
      : [];

    const planRaw = String(oauth.subscriptionType || 'claude').toLowerCase();

    return {
      ok: true,
      plan: formatPlan(planRaw),
      planRaw,
      tier: oauth.rateLimitTier || '',
      fiveHour,
      weekly,
      opus,
      sonnet,
      extra,
      limits,
      fiveHourBreakdown: first(payload.seven_day_breakdown),
      fetchedAt: Date.now(),
      cached: false,
      stale: false,
      source: 'api',
    };
  }
}

module.exports = { Monitor };
