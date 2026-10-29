'use strict';

const api = window.perch;
const $ = (id) => document.getElementById(id);

const RING_LENGTH = 2 * Math.PI * 38;
const AVATAR_COLORS = ['#E89463', '#8FB8E8', '#8BD49C', '#E8A6C2', '#B79CE8', '#E8C46B'];
const FOLDER_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4l1 1.2h7v7.8H2z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.8 4.2 11.6 8l-5.8 3.8z" fill="currentColor"/></svg>`;
const ARROW_ICON = `<svg class="recent-action" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h8M8.8 5.2 11.6 8l-2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let config = {};
let layout = {};
let state = {
  sessions: [],
  recent: [],
  agents: [],
  usage: null,
  usageError: null,
  usageSource: '',
  usageFetchedAt: 0,
  vpn: null,
};
let initData = null;
let statuslineInfo = null;
let drawerOpen = false;
let isPinned = false;
let settingsOpen = false;
let isResizing = false;
let hasState = false;
let lastSessionsKey = '';
let lastRecentKey = '';
let lastAgentsKey = '';
let closeTimer = null;
let refreshStartedAt = 0;
let widthDebounce = null;
let recentHintTimer = null;

const drawer = $('drawer');
const sessionsEl = $('sessions');
const recentBlock = $('recentBlock');
const recentEl = $('recent');
const recentHint = $('recentHint');
const usageErrorEl = $('usageError');
const usageErrorText = $('usageErrorText');
const livePill = document.querySelector('.live-pill');
const pinBtn = $('pinBtn');
const settingsBtn = $('settingsBtn');
const viewMain = $('viewMain');
const viewSettings = $('viewSettings');
const heightRange = $('heightRange');
const widthRange = $('widthRange');
const heightValue = $('heightValue');
const widthValue = $('widthValue');
let agentsMeta = [];
let dragMoved = false;
let fontDebounce = null;

function agentMeta(id) {
  return agentsMeta.find((item) => item.id === id) || null;
}

function agentLabel(id) {
  const meta = agentMeta(id);
  if (meta && meta.label) return meta.label;
  return id && id !== 'unknown' ? String(id).charAt(0).toUpperCase() + String(id).slice(1) : '';
}

function agentAccent(id) {
  const meta = agentMeta(id);
  return (meta && meta.accent) || '#8f96a3';
}

function applyAgents(list) {
  agentsMeta = Array.isArray(list) ? list : [];
  renderAgentList();
  updateVersionLine();
}

function renderAgentList() {
  const host = $('agentList');
  if (!host) return;
  if (!agentsMeta.length) {
    host.innerHTML = '<div class="agent-empty">Ищу агентов…</div>';
    return;
  }
  host.innerHTML = agentsMeta
    .map((agent) => {
      const name = `${escapeHtml(agent.label)}${agent.usage ? '<i class="agent-tag">лимиты</i>' : ''}`;
      const hint = agent.installed ? 'найден на этом компьютере' : escapeHtml(agent.installHint || 'не найден');
      return `<div class="agent-row ${agent.installed ? 'installed' : ''}">
        <span class="agent-dot" style="--agent-accent:${escapeAttr(agent.accent || '#8f96a3')}"></span>
        <span class="agent-copy">
          <span class="agent-name">${name}</span>
          <span class="agent-hint">${hint}</span>
        </span>
        <span class="agent-state">${agent.installed ? 'готов' : 'нет'}</span>
      </div>`;
    })
    .join('');
}

function updateVersionLine() {
  const element = $('versionAgents');
  if (!element) return;
  const installed = agentsMeta.filter((agent) => agent.installed);
  element.textContent = installed.length ? installed.map((agent) => agent.label).join(' · ') : 'агенты не найдены';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hashString(value) {
  let hash = 2166136261;
  const string = String(value || 'perch');
  for (let i = 0; i < string.length; i += 1) {
    hash ^= string.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixHex(hex, target, amount) {
  const parse = (value) => {
    const clean = value.replace('#', '');
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(target);
  const mix = (a, b) => Math.round(a + (b - a) * amount);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}

function rgbaFromHex(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function pixelAvatar(seed, accent) {
  const rand = mulberry32(hashString(seed));
  const light = mixHex(accent, '#ffffff', 0.28);
  const dark = mixHex(accent, '#000000', 0.28);
  const shades = [accent, light, dark];
  const cells = [];

  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if (rand() > 0.46) {
        const tone = rand() > 0.66 ? 1 : rand() > 0.2 ? 0 : 2;
        cells.push([x, y, tone]);
        if (x < 2) cells.push([4 - x, y, tone]);
      }
    }
  }

  if (!cells.length) {
    cells.push([1, 1, 0], [3, 1, 0], [2, 2, 1], [1, 3, 0], [2, 3, 0], [3, 3, 0]);
  }

  const rects = cells
    .map(([x, y, tone]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${shades[tone]}"/>`)
    .join('');

  return `<svg viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

function emptyArt() {
  return `<svg class="empty-art" viewBox="0 0 66 36" shape-rendering="crispEdges" aria-hidden="true">
    <ellipse cx="37" cy="21" rx="16" ry="11" fill="#E89463" opacity="0.07"/>
    <rect x="4" y="30" width="58" height="1" fill="#332B24"/>
    <rect x="7" y="8" width="1" height="1" fill="#FFD0A8" opacity="0.65"/>
    <rect x="54" y="7" width="1" height="1" fill="#FFD0A8" opacity="0.4"/>
    <rect x="46" y="4" width="1" height="1" fill="#FFD0A8" opacity="0.3"/>
    <rect x="12" y="6" width="1" height="1" fill="#FFD0A8" opacity="0.22"/>
    <rect x="14" y="24" width="34" height="2" fill="#4C382B"/>
    <rect x="15" y="26" width="1" height="5" fill="#3A2B22"/>
    <rect x="46" y="26" width="1" height="5" fill="#3A2B22"/>
    <rect x="30" y="12" width="15" height="11" fill="#241C17"/>
    <rect x="32" y="14" width="11" height="7" fill="#E89463" opacity="0.17"/>
    <rect x="33" y="15" width="6" height="1" fill="#E89463" opacity="0.8"/>
    <rect x="33" y="17" width="8" height="1" fill="#E89463" opacity="0.5"/>
    <rect x="33" y="19" width="4" height="1" fill="#E89463" opacity="0.35"/>
    <rect x="36" y="23" width="3" height="1" fill="#3A2C23"/>
    <rect x="34" y="24" width="7" height="1" fill="#3A2C23"/>
    <rect x="19" y="21" width="1" height="5" fill="#3A2B22"/>
    <rect x="20" y="18" width="2" height="5" fill="#3A2C23"/>
    <rect x="21" y="15" width="6" height="5" fill="#8FB8E8"/>
    <rect x="22" y="18" width="4" height="1" fill="#7AA2D0" opacity="0.7"/>
    <rect x="21" y="20" width="2" height="3" fill="#2E3742"/>
    <rect x="25" y="20" width="2" height="3" fill="#2E3742"/>
    <rect x="21" y="11" width="5" height="4" fill="#E8B98F"/>
    <rect x="21" y="10" width="5" height="1" fill="#6B4A34"/>
    <rect x="22" y="12" width="1" height="1" fill="#2A201A"/>
    <rect x="24" y="12" width="1" height="1" fill="#2A201A"/>
    <rect x="27" y="16" width="3" height="1" fill="#E8B98F"/>
    <rect x="43" y="22" width="2" height="2" fill="#C9B8A6"/>
    <rect x="44" y="20" width="1" height="1" fill="#C9B8A6" opacity="0.35"/>
    <rect x="53" y="24" width="5" height="3" fill="#6E4C38"/>
    <rect x="54" y="21" width="1" height="4" fill="#6C9A6A"/>
    <rect x="55" y="20" width="1" height="4" fill="#7FB47C"/>
    <rect x="56" y="22" width="1" height="3" fill="#6C9A6A"/>
    <rect x="55" y="23" width="1" height="1" fill="#8FC98B"/>
  </svg>`;
}

function statusLabel(session) {
  if (session.attention) return session.stalled ? 'ждёт ответа' : 'нужен ответ';
  if (session.status === 'busy') return 'работает';
  if (session.status === 'idle') return 'готово';
  return 'ожидает';
}

function formatTimer(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function formatDurationLong(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин`;
  return `${total} с`;
}

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'только что';
  if (seconds < 60) return `${seconds} с назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

function formatReset(timestamp) {
  if (!timestamp) return 'нет данных';
  const now = Date.now();
  const diff = timestamp - now;
  if (diff <= 0) return 'сброс сейчас';
  if (diff < 90 * 60 * 1000) {
    const minutes = Math.max(1, Math.ceil(diff / 60000));
    return `сброс через ${minutes} мин`;
  }
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  if (sameDay) {
    return `сброс в ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const diffHours = diff / 3600000;
  if (diffHours < 48) {
    return `сброс через ${Math.ceil(diffHours)} ч`;
  }
  return `сброс ${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;
}

function pluralSessions(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сессия';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'сессии';
  return 'сессий';
}

function applyLayout(next) {
  if (!next) return;
  layout = next;
  const root = document.documentElement;
  root.style.setProperty('--panel-w', `${next.panelWidth}px`);
  root.style.setProperty('--panel-h', `${next.panelHeight}px`);
  root.style.setProperty('--capsule-w', `${next.capsuleWidth}px`);
  root.style.setProperty('--capsule-h', `${next.capsuleHeight}px`);
  document.body.dataset.side = next.side || 'right';
  updateSettingsOutputs();
}

function applyConfig(nextConfig) {
  if (!nextConfig) return;
  const previous = config;
  config = nextConfig;
  document.body.dataset.side = config.side || 'right';

  const sideButtons = document.querySelectorAll('#sideControl button');
  sideButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.value === config.side);
  });

  $('toggleAlwaysOnTop').checked = Boolean(config.alwaysOnTop);
  $('toggleAutoHide').checked = Boolean(config.autoHide);
  $('toggleOpenOnAttention').checked = Boolean(config.openOnAttention);
  $('toggleNotifications').checked = Boolean(config.notifications);
  $('toggleAutostart').checked = Boolean(config.launchAtLogin);
  $('toggleContext').checked = Boolean(config.showContext);
  $('toggleStatusline').checked = Boolean(config.statusline);
  renderStatusline(statuslineInfo, true);

  heightRange.value = Math.round((config.heightPct || 0.76) * 100);
  widthRange.value = config.panelWidth || 432;
  applyAppearance();
  updateSettingsOutputs();

  if (previous && previous.showContext !== config.showContext) {
    lastSessionsKey = '';
    renderSessions(state.sessions || []);
  }

  renderVpn();
}

function applyAppearance() {
  const theme = config.theme || 'perch';
  if (document.body.dataset.theme !== theme) document.body.dataset.theme = theme;

  const scale = clamp(Number(config.fontSize) || 1.25, 1, 1.6);
  document.documentElement.style.setProperty('--fs', String(scale));

  const fontRange = $('fontRange');
  if (fontRange) fontRange.value = String(scale);
  const fontValue = $('fontValue');
  if (fontValue) fontValue.textContent = `${Math.round(scale * 100)}%`;

  document.querySelectorAll('#themeGrid .theme-swatch').forEach((button) => {
    button.classList.toggle('active', button.dataset.theme === theme);
  });
}

function updateSettingsOutputs() {
  const wa = layout.workArea || { height: 900 };
  const panelHeight = layout.panelHeight || Math.round(wa.height * (config.heightPct || 0.76));
  const pct = Math.round((panelHeight / wa.height) * 100);
  heightValue.textContent = `${panelHeight} px · ${pct}%`;
  widthValue.textContent = `${layout.panelWidth || config.panelWidth || 408} px`;
}

function renderStatusline(info, force) {
  if (info && (force || JSON.stringify(info) !== JSON.stringify(statuslineInfo))) {
    statuslineInfo = info;
  }
  const element = $('statuslineState');
  const openButton = $('statuslineOpen');
  const current = statuslineInfo || {};
  const enabled = Boolean(config.statusline);

  let text = 'Выключено. Лимиты идут напрямую из API Anthropic — нужен VPN.';
  let tone = 'off';
  let showLink = false;

  if (enabled) {
    if (current.state === 'installed') {
      text = 'Подключено. Claude Code передаёт проценты лимитов локально.';
      tone = 'ok';
    } else if (current.state === 'foreign') {
      text = 'В Claude Code уже настроена своя строка статуса — Perch не меняет её.';
      tone = 'warn';
      showLink = true;
    } else if (current.state === 'error') {
      text = `Не удалось подключиться: ${current.detail || 'неизвестная ошибка'}`;
      tone = 'error';
      showLink = true;
    } else {
      text = 'Включаю мост…';
      tone = 'warn';
    }
  }

  element.classList.remove('off', 'warn', 'error');
  if (tone !== 'ok') element.classList.add(tone);
  if (element.textContent !== text) element.textContent = text;
  openButton.hidden = !showLink;
}

function statuslineActive() {
  return Boolean(config.statusline && statuslineInfo && statuslineInfo.active);
}

function vpnStateInfo() {
  const vpn = state.vpn || { status: 'checking', reason: 'Проверяю VPN…' };
  const status = vpn.status || (vpn.enabled ? 'on' : 'checking');
  const active = statuslineActive();
  const hasUsage = Boolean(state.usage);
  let main = '';

  if (status === 'on') {
    main = 'VPN подключён · лимиты обновляются';
  } else if (status === 'checking') {
    main = 'Проверяю VPN…';
  } else {
    const suffix = active ? 'лимиты из Claude Code' : hasUsage ? 'показываем кеш' : 'лимиты не обновляются';
    main = `${status === 'unknown' ? 'Не удалось проверить VPN' : 'VPN выключен'} · ${suffix}`;
  }

  return { status, main, reason: vpn.reason || '' };
}

function renderVpn() {
  const info = vpnStateInfo();
  const note = $('vpnNote');
  note.hidden = info.status === 'on';
  note.classList.toggle('unknown', info.status === 'unknown');
  note.title = info.reason;
  $('vpnNoteText').textContent = info.main;

  const network = $('networkState');
  network.className = `network-state ${info.status}`;
  network.title = info.reason;
  $('networkText').textContent = info.main;
}

function usageStampText() {
  const usage = state.usage;
  const source = state.usageSource || (usage && usage.source) || '';
  const vpnBlocked = Boolean(state.vpn && state.vpn.status !== 'on');
  if (state.usageError && !usage) return 'лимиты недоступны';
  if (!state.usageFetchedAt) return vpnBlocked ? 'нет данных' : 'обновление…';

  const ago = timeAgo(state.usageFetchedAt);
  if (vpnBlocked && source !== 'statusline') return `кеш · ${ago}`;
  if (source === 'statusline') return `Claude Code · ${ago}`;
  if (source === 'cache') return `кэш · ${ago}`;
  return `обновлено ${ago}`;
}

function renderRecent(sessions) {
  const list = Array.isArray(sessions) ? sessions.slice(0, 6) : [];
  recentBlock.hidden = !list.length;
  if (!list.length) {
    lastRecentKey = '';
    recentEl.innerHTML = '';
    return;
  }

  const key = JSON.stringify(
    list.map((item) => [
      item.id,
      item.agent,
      item.title,
      item.project,
      item.modelShort,
      Math.floor((Date.now() - (item.updatedAt || 0)) / 60000),
    ]),
  );
  if (key === lastRecentKey) return;
  lastRecentKey = key;

  recentEl.innerHTML = list
    .map((item) => {
      const meta = [agentLabel(item.agent), item.project || 'Без папки', timeAgo(item.updatedAt)];
      if (item.modelShort) meta.push(item.modelShort);
      return `<button class="recent-item" type="button" data-session-id="${escapeAttr(item.id)}" title="Продолжить: ${escapeAttr(
        item.title,
      )}">
        <span class="recent-icon" style="--agent-accent:${escapeAttr(agentAccent(item.agent))}">${PLAY_ICON}</span>
        <span class="recent-copy">
          <span class="recent-title">${escapeHtml(item.title)}</span>
          <span class="recent-meta">${meta.filter(Boolean).map((part) => escapeHtml(part)).join(' · ')}</span>
        </span>
        ${ARROW_ICON}
      </button>`;
    })
    .join('');
}

function setRecentHint(text, isError = false) {
  if (!recentHint) return;
  recentHint.textContent = text || 'продолжить';
  recentHint.classList.toggle('error', Boolean(isError));
  clearTimeout(recentHintTimer);
  recentHintTimer = setTimeout(() => {
    recentHint.textContent = 'продолжить';
    recentHint.classList.remove('error');
  }, isError ? 5200 : 2200);
}

function renderSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const key = JSON.stringify(
    list.map((s) => [s.id, s.agent, s.title, s.status, s.attention, s.contextPct, s.contextTokens, s.lastAction, s.modelShort, s.startedAt, s.kind]),
  );
  if (key === lastSessionsKey) {
    updateFooter(list);
    return;
  }
  lastSessionsKey = key;

  $('sessionCount').textContent = String(list.length);

  if (!list.length) {
    const installed = agentsMeta.filter((agent) => agent.installed);
    let message;
    if (!hasState) {
      message = 'Ищу активные сессии агентов…';
    } else if (installed.length) {
      message = `Запустите ${installed.map((agent) => agent.label).join(', ')} в терминале — сессия появится здесь сама.`;
    } else {
      message = 'Агенты не найдены. Установите Claude Code, opencode, Cursor CLI, Codex или Gemini CLI и запустите их.';
    }
    sessionsEl.innerHTML = `<div class="empty">
      ${emptyArt()}
      <h3>${hasState ? 'Пока тихо' : 'Подключаюсь'}</h3>
      <p>${escapeHtml(message)}</p>
    </div>`;
    updateFooter(list);
    return;
  }

  const now = Date.now();
  sessionsEl.innerHTML = list
    .map((session, index) => {
      const accent = AVATAR_COLORS[hashString(session.id) % AVATAR_COLORS.length];
      const elapsed = now - (session.startedAt || now);
      const memory =
        config.showContext && session.contextTokens
          ? `<div class="s-memory" title="Контекст: ${Math.round(session.contextTokens / 1000)}K из ${Math.round(
              session.contextLimit / 1000,
            )}K токенов">
              <span class="s-memory-track"><i class="s-memory-fill" style="width:${clamp(session.contextPct, 0, 100)}%"></i></span>
              <span class="s-memory-label">контекст ${Math.round(session.contextPct)}%</span>
            </div>`
          : '<div class="s-memory" hidden></div>';

      return `<article class="session ${escapeHtml(session.status)} ${session.attention ? 'attention' : ''} ${
        session.contextPct >= 80 ? 'high-context' : ''
      }" style="--accent:${accent};--avatar-tint:${rgbaFromHex(accent, 0.16)}" data-id="${escapeAttr(session.id)}">
        <div class="avatar">${pixelAvatar(session.id, accent)}<span class="status-pip"></span></div>
        <div class="session-info">
          <div class="s-row1">
            <span class="s-title" title="${escapeAttr(session.title)}">${escapeHtml(session.title)}</span>
            <span class="s-time" data-start="${session.startedAt || now}" title="Работает ${escapeAttr(
              formatDurationLong(elapsed),
            )}">${formatTimer(elapsed)}</span>
          </div>
          <div class="s-row2">
            <span class="s-agent" style="--agent-accent:${escapeAttr(agentAccent(session.agent))}">${escapeHtml(
              session.agentLabel || agentLabel(session.agent),
            )}</span>
            <span class="s-status"><i></i>${escapeHtml(statusLabel(session))}</span>
            <span class="s-project" title="${escapeAttr(session.cwd || '')}">${escapeHtml(session.project)}</span>
            ${session.modelShort ? `<span class="s-model">${escapeHtml(session.modelShort)}</span>` : ''}
            ${session.kind === 'bg' ? '<span class="s-model">фон</span>' : ''}
          </div>
          <div class="s-action-row">
            <span class="s-action" title="${escapeAttr(session.lastAction)}">${escapeHtml(session.lastAction)}</span>
            ${
              session.cwd
                ? `<button type="button" class="folder-btn" data-folder="${escapeAttr(session.cwd)}" title="Открыть папку проекта" aria-label="Открыть папку проекта">${FOLDER_ICON}</button>`
                : ''
            }
          </div>
          ${memory}
        </div>
      </article>`;
    })
    .join('');

  updateFooter(list);
}

function updateFooter(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const waiting = list.filter((s) => s.attention).length;
  const busy = list.filter((s) => s.status === 'busy' && !s.attention).length;
  const idle = list.filter((s) => s.status === 'idle').length;
  const footerState = document.querySelector('.footer-state');
  footerState.classList.remove('busy', 'waiting', 'idle');
  let text = 'Нет активных сессий';
  if (waiting) {
    footerState.classList.add('waiting');
    text = `${waiting} ${pluralSessions(waiting)} ждёт ответа`;
  } else if (busy) {
    footerState.classList.add('busy');
    text = `${busy} ${pluralSessions(busy)} работает`;
  } else if (idle) {
    footerState.classList.add('idle');
    text = `${idle} ${pluralSessions(idle)} готово`;
  }
  $('footerText').textContent = text;

  const summary = waiting
    ? `${waiting} ждёт`
    : busy
      ? `${busy} работает`
      : idle
        ? 'все готовы'
        : '—';
  $('sessionSummary').textContent = summary;
  updateCapsule(list);
}

function updateCapsule(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const waiting = list.filter((s) => s.attention).length;
  const busy = list.filter((s) => s.status === 'busy' && !s.attention).length;
  const idle = list.filter((s) => s.status === 'idle').length;
  $('capsuleCount').textContent = String(list.length);
  $('capsuleBusy').classList.toggle('visible', busy > 0);
  $('capsuleWaiting').classList.toggle('visible', waiting > 0);
  $('capsuleIdle').classList.toggle('visible', idle > 0);
  drawer.classList.toggle('attention', waiting > 0);
}

function pickLimit(usage, kind) {
  if (!usage) return null;
  if (kind === 'session') {
    if (usage.fiveHour) return usage.fiveHour;
    const limit = (usage.limits || []).find((item) => item.kind === 'session');
    return limit ? { pct: limit.pct, resetsAt: limit.resetsAt, severity: limit.severity } : null;
  }
  if (usage.weekly) return usage.weekly;
  const limit = (usage.limits || []).find((item) => item.kind === 'weekly_all');
  return limit ? { pct: limit.pct, resetsAt: limit.resetsAt, severity: limit.severity } : null;
}

function setGauge(gaugeId, ringId, pct, fallbackSeverity) {
  const gauge = $(gaugeId);
  const ring = $(ringId);
  const hasValue = Number.isFinite(pct);
  gauge.classList.remove('warning', 'critical');
  if (!hasValue) {
    ring.style.strokeDashoffset = String(RING_LENGTH);
    return;
  }
  const value = clamp(pct, 0, 100);
  ring.style.strokeDashoffset = String(RING_LENGTH * (1 - value / 100));
  const severity = pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : fallbackSeverity || 'normal';
  if (severity === 'critical') gauge.classList.add('critical');
  else if (severity === 'warning') gauge.classList.add('warning');
}

function renderUsage() {
  const usage = state.usage;
  const five = pickLimit(usage, 'session');
  const week = pickLimit(usage, 'weekly');

  $('planBadge').textContent = usage && usage.plan ? usage.plan : '—';

  const fivePct = five && Number.isFinite(five.pct) ? five.pct : null;
  const weekPct = week && Number.isFinite(week.pct) ? week.pct : null;

  $('pct5h').textContent = fivePct == null ? '—' : String(Math.round(fivePct));
  $('pct7d').textContent = weekPct == null ? '—' : String(Math.round(weekPct));
  setGauge('gauge5h', 'ring5h', fivePct, 'normal');
  setGauge('gauge7d', 'ring7d', weekPct, 'normal');

  const reset5h = $('reset5h');
  const reset7d = $('reset7d');
  if (five && five.resetsAt) {
    reset5h.dataset.reset = String(five.resetsAt);
    reset5h.textContent = formatReset(five.resetsAt);
  } else {
    delete reset5h.dataset.reset;
    reset5h.textContent = 'нет данных';
  }
  if (week && week.resetsAt) {
    reset7d.dataset.reset = String(week.resetsAt);
    reset7d.textContent = formatReset(week.resetsAt);
  } else {
    delete reset7d.dataset.reset;
    reset7d.textContent = 'нет данных';
  }

  const vpnBlocked = Boolean(state.vpn && state.vpn.status !== 'on');
  const stale = Boolean(state.usageError) || Boolean(usage && usage.stale) || vpnBlocked;
  livePill.classList.toggle('stale', stale);
  livePill.classList.toggle('error', Boolean(state.usageError && !usage));
  $('usageUpdated').textContent = usageStampText();
  livePill.title = (state.usageError && state.usageError.detail) || (state.vpn && state.vpn.reason) || '';

  const errorVisible = Boolean(state.usageError && !usage);
  usageErrorEl.hidden = !errorVisible;
  if (errorVisible) {
    usageErrorText.textContent = state.usageError.message || 'Не удалось обновить лимиты';
    usageErrorText.title = state.usageError.detail || '';
  }

  const criticalFive = fivePct != null && fivePct >= 90;
  const criticalWeek = weekPct != null && weekPct >= 90;
  const note = $('criticalNote');
  note.hidden = !(criticalFive || criticalWeek);
  if (criticalFive) {
    $('criticalText').textContent = `5-часовой лимит почти исчерпан · ${Math.round(fivePct)}%`;
  } else if (criticalWeek) {
    $('criticalText').textContent = `Недельный лимит почти исчерпан · ${Math.round(weekPct)}%`;
  }

  if (refreshStartedAt && state.usageFetchedAt >= refreshStartedAt) {
    refreshStartedAt = 0;
    $('refreshUsage').classList.remove('spinning');
  }
}

function tickTimers() {
  const now = Date.now();
  document.querySelectorAll('.s-time[data-start]').forEach((element) => {
    const started = Number(element.dataset.start);
    if (started) {
      element.textContent = formatTimer(now - started);
      const session = (state.sessions || []).find((item) => item.id === element.closest('.session')?.dataset.id);
      if (session) element.title = `Работает ${formatDurationLong(now - session.startedAt)}`;
    }
  });
  document.querySelectorAll('[data-reset]').forEach((element) => {
    element.textContent = formatReset(Number(element.dataset.reset));
  });
  $('usageUpdated').textContent = usageStampText();
}

function applyState(nextState) {
  if (!nextState) return;
  state = nextState;
  hasState = true;

  const agentsKey = JSON.stringify((nextState.agents || []).map((agent) => [agent.id, agent.installed]));
  if (agentsKey !== lastAgentsKey) {
    lastAgentsKey = agentsKey;
    applyAgents(nextState.agents || []);
    lastSessionsKey = '';
    lastRecentKey = '';
  }

  if (refreshStartedAt && (nextState.generatedAt || 0) >= refreshStartedAt) {
    refreshStartedAt = 0;
    $('refreshUsage').classList.remove('spinning');
  }
  if (nextState.statusline) renderStatusline(nextState.statusline, false);
  renderVpn();
  renderUsage();
  renderSessions(state.sessions || []);
  renderRecent(state.recent || []);
  updateCapsule(state.sessions || []);
}

function setSettings(open) {
  settingsOpen = Boolean(open);
  viewMain.hidden = settingsOpen;
  viewSettings.hidden = !settingsOpen;
  settingsBtn.classList.toggle('active', settingsOpen);
  if (settingsOpen) {
    api.setPinned(true);
    document.querySelector('.settings-scroll').scrollTop = 0;
  }
}

function scheduleClose() {
  if (!config.autoHide) return;
  if (!drawerOpen || isPinned || settingsOpen || isResizing) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!isPinned && !settingsOpen && !isResizing) api.close(false);
  }, 620);
}

function clearCloseTimer() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
}

function wireEvents() {
  drawer.addEventListener('mouseenter', () => {
    clearCloseTimer();
    if (!drawerOpen) api.open(false);
  });
  drawer.addEventListener('mouseleave', scheduleClose);

  document.querySelector('.brand').addEventListener('click', () => {
    if (dragMoved) return;
    if (!isPinned) api.setPinned(true);
    api.open(true);
  });
  document.querySelector('.capsule-meta').addEventListener('click', () => {
    if (dragMoved) return;
    if (!isPinned) api.setPinned(true);
    api.open(true);
  });

  pinBtn.addEventListener('click', () => {
    api.setPinned(!isPinned);
  });

  $('closeBtn').addEventListener('click', () => api.close(true));

  settingsBtn.addEventListener('click', () => {
    if (settingsOpen) setSettings(false);
    else setSettings(true);
  });
  $('settingsBack').addEventListener('click', () => setSettings(false));

  document.querySelectorAll('#themeGrid .theme-swatch').forEach((button) => {
    button.addEventListener('click', () => api.setConfig({ theme: button.dataset.theme }));
  });

  $('fontRange').addEventListener('input', () => {
    const scale = clamp(Number($('fontRange').value) || 1.25, 1, 1.6);
    config.fontSize = scale;
    document.documentElement.style.setProperty('--fs', String(scale));
    $('fontValue').textContent = `${Math.round(scale * 100)}%`;
    clearTimeout(fontDebounce);
    fontDebounce = setTimeout(() => api.setConfig({ fontSize: scale }), 160);
  });

  $('resetPositionBtn').addEventListener('click', () => api.resetPosition());

  document.querySelectorAll('#sideControl button').forEach((button) => {
    button.addEventListener('click', () => {
      api.setConfig({ side: button.dataset.value });
    });
  });

  heightRange.addEventListener('input', () => {
    const pct = clamp(Number(heightRange.value) / 100, 0.4, 0.96);
    applyHeightPct(pct);
    api.setHeightLive(pct);
  });

  heightRange.addEventListener('change', async () => {
    const pct = clamp(Number(heightRange.value) / 100, 0.4, 0.96);
    await api.commitHeight(pct);
  });

  widthRange.addEventListener('input', () => {
    const width = clamp(Number(widthRange.value), 360, 480);
    document.documentElement.style.setProperty('--panel-w', `${width}px`);
    widthValue.textContent = `${width} px`;
    clearTimeout(widthDebounce);
    widthDebounce = setTimeout(() => api.setConfig({ panelWidth: width }), 140);
  });

  $('toggleAlwaysOnTop').addEventListener('change', (event) => api.setConfig({ alwaysOnTop: event.target.checked }));
  $('toggleAutoHide').addEventListener('change', (event) => api.setConfig({ autoHide: event.target.checked }));
  $('toggleOpenOnAttention').addEventListener('change', (event) =>
    api.setConfig({ openOnAttention: event.target.checked }),
  );
  $('toggleNotifications').addEventListener('change', (event) => api.setConfig({ notifications: event.target.checked }));
  $('toggleAutostart').addEventListener('change', (event) => api.setConfig({ launchAtLogin: event.target.checked }));
  $('toggleContext').addEventListener('change', (event) => api.setConfig({ showContext: event.target.checked }));
  $('toggleStatusline').addEventListener('change', (event) => {
    const enabled = event.target.checked;
    api.setConfig({ statusline: enabled });
    renderStatusline(null, false);
  });

  $('refreshUsage').addEventListener('click', requestUsageRefresh);
  $('usageRetry').addEventListener('click', requestUsageRefresh);
  $('vpnRecheck').addEventListener('click', requestUsageRefresh);
  $('vpnSettingsRecheck').addEventListener('click', requestUsageRefresh);

  recentEl.addEventListener('click', async (event) => {
    const item = event.target.closest('[data-session-id]');
    if (!item) return;
    const id = item.dataset.sessionId;
    item.classList.add('opening');
    setRecentHint('открываю…');

    try {
      const result = await api.resumeSession(id);
      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'Не удалось открыть сессию');
      }
      setRecentHint('открыто');
      api.setPinned(false);
      setTimeout(() => api.close(true), 140);
    } catch (error) {
      item.classList.remove('opening');
      setRecentHint((error && error.message) || 'Не удалось открыть сессию', true);
    }
  });

  $('statuslineOpen').addEventListener('click', () => {
    api.openFolder((initData && initData.paths && initData.paths.statuslineSettings) || '');
  });

  $('dataPathBtn').addEventListener('click', () => {
    api.openFolder((initData && initData.paths && (initData.paths.userData || initData.paths.claude)) || '');
  });

  sessionsEl.addEventListener('click', (event) => {
    const folder = event.target.closest('[data-folder]');
    if (folder) {
      event.stopPropagation();
      api.openFolder(folder.dataset.folder);
    }
  });

  const grip = $('resizeGrip');
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    isResizing = true;
    api.setPinned(true);
    document.body.classList.add('resizing');
    const startY = event.screenY;
    const startHeight = layout.panelHeight || heightRange.value / 100 * (layout.workArea?.height || 900);
    const maxHeight = Math.max(340, (layout.workArea?.height || 900) - 22);
    grip.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const height = clamp(startHeight + (moveEvent.screenY - startY), 340, maxHeight);
      const pct = clamp(height / (layout.workArea?.height || 900), 0.4, 0.96);
      applyHeightPct(pct);
      api.setHeightLive(pct);
    };

    const finish = async () => {
      isResizing = false;
      document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      const pct = clamp(Number(heightRange.value) / 100, 0.4, 0.96);
      await api.commitHeight(pct);
    };

    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (settingsOpen) setSettings(false);
      else api.close(true);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearCloseTimer();
  });

  wireWindowDrag();
}

// Перетаскивание окна за верхнюю панель: тащим мышью, позицию запоминает main-процесс.
function wireWindowDrag() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;

  topbar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button, input, textarea, select, a')) return;

    const startX = event.screenX;
    const startY = event.screenY;
    let dragging = false;

    const onMove = (moveEvent) => {
      const dx = moveEvent.screenX - startX;
      const dy = moveEvent.screenY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 4) return;
        dragging = true;
        dragMoved = true;
        api.dragBegin();
      }
      api.dragMove(dx, dy);
    };

    const finish = () => {
      topbar.removeEventListener('pointermove', onMove);
      topbar.removeEventListener('pointerup', finish);
      topbar.removeEventListener('pointercancel', finish);
      if (topbar.hasPointerCapture(event.pointerId)) topbar.releasePointerCapture(event.pointerId);
      if (dragging) {
        api.dragEnd();
        setTimeout(() => {
          dragMoved = false;
        }, 60);
      }
    };

    topbar.setPointerCapture(event.pointerId);
    topbar.addEventListener('pointermove', onMove);
    topbar.addEventListener('pointerup', finish);
    topbar.addEventListener('pointercancel', finish);
  });
}

function applyHeightPct(pct) {
  const waHeight = (layout.workArea && layout.workArea.height) || 900;
  const height = Math.round(clamp(waHeight * pct, 340, waHeight - 22));
  layout.panelHeight = height;
  document.documentElement.style.setProperty('--panel-h', `${height}px`);
  heightRange.value = Math.round(pct * 100);
  heightValue.textContent = `${height} px · ${Math.round(pct * 100)}%`;
}

function requestUsageRefresh() {
  refreshStartedAt = Date.now();
  $('refreshUsage').classList.add('spinning');
  api.refreshUsage();
  setTimeout(() => {
    if (refreshStartedAt && Date.now() - refreshStartedAt > 6000) {
      refreshStartedAt = 0;
      $('refreshUsage').classList.remove('spinning');
    }
  }, 6500);
}

async function boot() {
  initData = await api.init();
  statuslineInfo = initData.statusline || null;
  config = initData.config || {};
  applyLayout(initData.layout);
  applyConfig(config);
  $('versionText').textContent = `Perch ${initData.version || '1.0'}`;
  $('heightRange').value = Math.round((config.heightPct || 0.76) * 100);
  $('widthRange').value = config.panelWidth || 408;
  updateSettingsOutputs();

  if (initData.state) applyState(initData.state);
  else renderSessions([]);

  wireEvents();
  setInterval(tickTimers, 1000);

  api.onState(applyState);
  api.onConfig(applyConfig);
  api.onLayout(applyLayout);
  api.onStatusline((info) => renderStatusline(info));
  api.onPin((value) => {
    isPinned = Boolean(value);
    pinBtn.classList.toggle('pinned', isPinned);
    drawer.classList.toggle('pinned', isPinned);
    if (!isPinned && !drawer.matches(':hover')) scheduleClose();
  });
  api.onOpen((payload) => {
    const wasOpen = drawerOpen;
    drawerOpen = true;
    drawer.classList.add('open');
    if (payload && typeof payload.pinned === 'boolean') {
      isPinned = payload.pinned;
      pinBtn.classList.toggle('pinned', isPinned);
      drawer.classList.toggle('pinned', isPinned);
    }
    if (!wasOpen) setSettings(false);
    clearCloseTimer();
  });
  api.onClosing(() => {
    drawerOpen = false;
    drawer.classList.remove('open');
    clearCloseTimer();
  });
}

boot().catch((error) => {
  console.error('Perch renderer failed to start', error);
  sessionsEl.innerHTML = `<div class="empty"><h3>Не удалось запустить Perch</h3><p>${escapeHtml(
    error && error.message ? error.message : 'Неизвестная ошибка',
  )}</p></div>`;
});
