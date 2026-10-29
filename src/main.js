'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  shell,
  Notification,
} = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { loadConfig, saveConfig, sanitize } = require('./config');
const { Monitor } = require('./monitor');
const { StatuslineManager } = require('./statusline');

const APP_NAME = 'Perch';
app.setName(APP_NAME);
app.setAppUserModelId('com.perch.windows');

const CAPSULE_W = 224;
const CAPSULE_H = 46;
const MARGIN_X = 14;
const MARGIN_TOP = 12;
const MIN_PANEL_H = 340;
const HOTKEY = 'Alt+Shift+P';

let win = null;
let tray = null;
let monitor = null;
let statusline = null;
let config = null;
let lastState = {
  sessions: [],
  recent: [],
  usage: null,
  usageError: null,
  agents: [],
  vpn: { enabled: false, status: 'checking', reason: 'Проверяю VPN…' },
};
let isOpen = false;
let isPinned = false;
let isClosing = false;
let closeToken = 0;
let rendererReady = false;
let isQuitting = false;
let trayMenuKey = '';
let dragOrigin = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function activeDisplay() {
  if (win && !win.isDestroyed()) {
    const bounds = win.getBounds();
    return screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + 10),
    });
  }
  return screen.getPrimaryDisplay();
}

function workArea() {
  return activeDisplay().workArea;
}

function panelWidth() {
  return Math.round(Math.min(560, Math.max(380, config.panelWidth || 432)));
}

function panelHeight(wa = workArea()) {
  const max = Math.max(MIN_PANEL_H, wa.height - MARGIN_TOP - 10);
  return Math.round(Math.max(MIN_PANEL_H, Math.min(max, wa.height * config.heightPct)));
}

// Позиция «по умолчанию» у края экрана — без учёта пользовательского сдвига.
function baseBounds(open) {
  const wa = workArea();
  const width = open ? panelWidth() : CAPSULE_W;
  const height = open ? panelHeight(wa) : CAPSULE_H;
  const x = config.side === 'left' ? wa.x + MARGIN_X : wa.x + wa.width - width - MARGIN_X;
  const y = wa.y + MARGIN_TOP;
  return { x, y, width, height };
}

function clampX(x, width) {
  const wa = workArea();
  return Math.min(Math.max(x, wa.x - 60), wa.x + wa.width - Math.min(width, 120));
}

function clampY(y) {
  const wa = workArea();
  return Math.min(Math.max(y, wa.y - 10), wa.y + wa.height - 60);
}

function windowBounds(open) {
  const base = baseBounds(open);
  let x = base.x + (Number.isFinite(config.offsetX) ? config.offsetX : 0);
  let y = base.y + (Number.isFinite(config.offsetY) ? config.offsetY : 0);
  return {
    x: Math.round(clampX(x, base.width)),
    y: Math.round(clampY(y)),
    width: Math.round(base.width),
    height: Math.round(base.height),
  };
}

function getLayout() {
  const wa = workArea();
  return {
    open: isOpen,
    side: config.side,
    panelWidth: panelWidth(),
    panelHeight: panelHeight(wa),
    capsuleWidth: CAPSULE_W,
    capsuleHeight: CAPSULE_H,
    workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height },
    minPanelHeight: MIN_PANEL_H,
    moved: Number.isFinite(config.offsetX) || Number.isFinite(config.offsetY),
  };
}

function sendLayout() {
  if (rendererReady && win && !win.isDestroyed()) {
    win.webContents.send('layout', getLayout());
  }
}

function applyWindowState({ silent = false } = {}) {
  if (!win || win.isDestroyed() || dragOrigin) return;
  win.setBounds(windowBounds(isOpen), false);
  win.setAlwaysOnTop(Boolean(config.alwaysOnTop), config.alwaysOnTop ? 'floating' : 'normal');
  if (!silent) sendLayout();
}

function sendPin() {
  if (rendererReady && win && !win.isDestroyed()) {
    win.webContents.send('pin', isPinned);
  }
}

function openDrawer({ pin = false, focus = false } = {}) {
  if (!win || win.isDestroyed()) return;
  if (pin) isPinned = true;
  const wasOpen = isOpen;
  if (!isOpen || isClosing) {
    isOpen = true;
    isClosing = false;
    applyWindowState();
    if (monitor) monitor.notifyDrawerOpen();
  }
  if (wasOpen && !isClosing) sendLayout();
  if (rendererReady) {
    win.webContents.send('drawer:open', { pinned: isPinned });
    if (pin) sendPin();
  }
  if (focus) {
    win.show();
    win.focus();
  }
}

function closeDrawer(force = false) {
  if (!win || win.isDestroyed()) return;
  if (force) {
    isPinned = false;
    sendPin();
  } else if (isPinned) {
    return;
  }
  if (!isOpen || isClosing) return;

  isClosing = true;
  closeToken += 1;
  const token = closeToken;
  if (rendererReady) win.webContents.send('drawer:closing');

  setTimeout(() => {
    if (token !== closeToken || !isClosing) return;
    isClosing = false;
    isOpen = false;
    applyWindowState();
  }, 260);
}

function toggleDrawer() {
  if (isOpen && isPinned) closeDrawer(true);
  else openDrawer({ pin: true, focus: true });
}

function setPinned(value) {
  isPinned = Boolean(value);
  sendPin();
}

function applyStatusline(enabled = config.statusline) {
  if (!statusline) return null;
  const info = statusline.apply(Boolean(enabled));
  if (rendererReady && win && !win.isDestroyed()) {
    win.webContents.send('statusline', info);
  }
  return info;
}

function setConfig(patch) {
  const previous = config;
  config = sanitize({ ...config, ...(patch || {}) });

  const changedPosition =
    !previous ||
    previous.side !== config.side ||
    previous.heightPct !== config.heightPct ||
    previous.panelWidth !== config.panelWidth ||
    previous.offsetX !== config.offsetX ||
    previous.offsetY !== config.offsetY;

  saveConfig(config);

  if (previous && previous.statusline !== config.statusline) {
    applyStatusline(config.statusline);
    if (monitor) monitor.refreshUsage(true);
  }

  if (changedPosition) applyWindowState();
  else if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(Boolean(config.alwaysOnTop), config.alwaysOnTop ? 'floating' : 'normal');
  }

  if (rendererReady && win && !win.isDestroyed()) {
    win.webContents.send('config', config);
  }
  if (previous && previous.launchAtLogin !== config.launchAtLogin) applyLoginItem();
  rebuildTrayMenu();
  return config;
}

function applyLoginItem() {
  try {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({
      openAtLogin: Boolean(config.launchAtLogin),
      openAsHidden: true,
      args: ['--hidden'],
    });
  } catch (error) {
    console.error('Perch login item error:', error.message);
  }
}

function sessionCounts(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return {
    total: list.length,
    busy: list.filter((s) => s.status === 'busy' && !s.attention).length,
    waiting: list.filter((s) => s.attention).length,
    idle: list.filter((s) => s.status === 'idle').length,
  };
}

function pluralSessions(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сессия';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'сессии';
  return 'сессий';
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин`;
  return `${total} с`;
}

function buildTrayMenu() {
  const counts = sessionCounts(lastState.sessions);
  const agents = (lastState.agents || []).filter((a) => a.installed);
  const menuKey = JSON.stringify({
    config: [config.side, config.heightPct, config.alwaysOnTop, config.notifications, config.launchAtLogin, config.statusline, config.theme],
    counts,
    agents: agents.map((a) => a.id),
  });
  if (menuKey === trayMenuKey) return;
  trayMenuKey = menuKey;

  const heightPresets = [45, 60, 75, 90];
  const activePct = Math.round(config.heightPct * 100);

  const menu = Menu.buildFromTemplate([
    {
      label: counts.total
        ? `${counts.total} ${pluralSessions(counts.total)} · ${counts.busy} работает${counts.waiting ? ` · ${counts.waiting} ждёт` : ''}`
        : 'Нет активных сессий',
      enabled: false,
    },
    {
      label: isOpen && isPinned ? 'Закрыть Perch' : 'Открыть Perch',
      accelerator: HOTKEY,
      click: () => toggleDrawer(),
    },
    { type: 'separator' },
    {
      label: 'Положение',
      submenu: [
        { label: 'Слева', type: 'radio', checked: config.side === 'left', click: () => setConfig({ side: 'left' }) },
        { label: 'Справа', type: 'radio', checked: config.side === 'right', click: () => setConfig({ side: 'right' }) },
        { type: 'separator' },
        {
          label: 'Сбросить сдвиг',
          enabled: Number.isFinite(config.offsetX) || Number.isFinite(config.offsetY),
          click: () => setConfig({ offsetX: null, offsetY: null }),
        },
      ],
    },
    {
      label: 'Высота',
      submenu: heightPresets.map((pct) => ({
        label: `${pct}%`,
        type: 'radio',
        checked: Math.abs(activePct - pct) <= 1,
        click: () => setConfig({ heightPct: pct / 100 }),
      })),
    },
    { type: 'separator' },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => setConfig({ alwaysOnTop: item.checked }),
    },
    {
      label: 'Уведомления',
      type: 'checkbox',
      checked: config.notifications,
      click: (item) => setConfig({ notifications: item.checked }),
    },
    {
      label: 'Лимиты из Claude Code',
      type: 'checkbox',
      checked: config.statusline,
      click: (item) => setConfig({ statusline: item.checked }),
    },
    {
      label: 'Запускать при входе',
      type: 'checkbox',
      checked: config.launchAtLogin,
      click: (item) => setConfig({ launchAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: `Агенты (${agents.length || 'нет'})`,
      enabled: false,
    },
    { label: 'Открыть папку с данными', click: () => shell.openPath(app.getPath('userData')) },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
}

function trayTooltip() {
  const counts = sessionCounts(lastState.sessions);
  if (!counts.total) return 'Perch · нет активных сессий';
  const bits = [`${counts.total} ${pluralSessions(counts.total)}`];
  if (counts.busy) bits.push(`${counts.busy} работает`);
  if (counts.waiting) bits.push(`${counts.waiting} ждёт`);
  return `Perch · ${bits.join(' · ')}`;
}

function createTray() {
  const trayPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let icon = nativeImage.createFromPath(trayPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Perch · запуск');
  tray.on('click', () => toggleDrawer());
  tray.on('double-click', () => openDrawer({ pin: true, focus: true }));
  buildTrayMenu();
}

function handleNotification(event) {
  if (!config.notifications) return;
  if (isOpen) return;
  if (!Notification.isSupported()) return;
  const session = event.session;
  const title = event.kind === 'waiting' ? 'Нужен ваш ответ' : 'Сессия завершена';
  const body =
    event.kind === 'waiting'
      ? `${session.title}\n${session.lastAction}`
      : `${session.title}\nРаботала ${formatDuration(Date.now() - session.startedAt)}`;

  const notification = new Notification({
    title: `Perch · ${title}`,
    body,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    silent: false,
  });
  notification.on('click', () => openDrawer({ pin: true, focus: true }));
  notification.show();
}

function updateState(state) {
  lastState = state;
  if (win && !win.isDestroyed() && rendererReady) {
    win.webContents.send('state', state);
  }
  if (tray) {
    tray.setToolTip(trayTooltip());
    buildTrayMenu();
  }
  if (config.openOnAttention) {
    const waiting = (state.sessions || []).some((s) => s.attention);
    if (waiting && !isOpen) openDrawer({ pin: false });
  }
}

function resolveCwd(session) {
  let cwd = (session && session.cwd) || '';
  try {
    if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = os.homedir();
  } catch {
    cwd = os.homedir();
  }
  return cwd;
}

function quote(value) {
  const text = String(value || '');
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '')}"` : text;
}

// Универсальное «продолжить сессию»: у каждого агента своя команда,
// а если её нет — просто открываем папку проекта.
function resumeSession(session) {
  if (!session) return { ok: false, error: 'Сессия не найдена' };
  const id = String(session.id || '');
  if (!/^[A-Za-z0-9_.:-]{4,120}$/.test(id)) return { ok: false, error: 'Некорректный ID сессии' };

  const cwd = resolveCwd(session);
  const command = monitor ? monitor.agents.resumeCommand(session) : null;

  if (!command) {
    if (!session.cwd || !fs.existsSync(session.cwd)) {
      return { ok: false, error: `У ${session.agentLabel || 'агента'} нет команды продолжения` };
    }
    shell.openPath(session.cwd);
    return { ok: true, cwd: session.cwd, command: '', opened: 'folder' };
  }

  const line = [command.executable, ...(command.args || [])].map(quote).join(' ');
  try {
    // windowsVerbatimArguments нужен, чтобы cmd.exe получил команду как есть:
    // иначе Node экранирует кавычки через '\"' и cmd не может разобрать путь.
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', line], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.on('error', (error) => console.warn('Perch resume failed:', error.message));
    child.unref();
  } catch (error) {
    return { ok: false, error: error.message || 'Не удалось открыть терминал' };
  }

  return { ok: true, cwd, command: command.label || line };
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    config,
    state: lastState,
    layout: getLayout(),
    version: app.getVersion(),
    hotkey: HOTKEY,
    isPackaged: app.isPackaged,
    statusline: statusline ? statusline.info() : null,
    paths: {
      userData: app.getPath('userData'),
      claude: monitor ? monitor.claudeDir : '',
      statuslineSettings: statusline ? statusline.settingsPath : '',
    },
  }));

  ipcMain.handle('config:set', (_event, patch) => setConfig(patch));

  ipcMain.on('drawer:open', (_event, pin) => openDrawer({ pin: Boolean(pin) }));
  ipcMain.on('drawer:close', (_event, force) => closeDrawer(Boolean(force)));
  ipcMain.on('drawer:pin', (_event, value) => setPinned(value));

  ipcMain.on('panel:height-live', (_event, pct) => {
    const next = Math.min(0.96, Math.max(0.4, Number(pct) || config.heightPct));
    config.heightPct = next;
    applyWindowState({ silent: true });
  });

  ipcMain.handle('panel:height-commit', (_event, pct) => {
    const next = Math.min(0.96, Math.max(0.4, Number(pct) || config.heightPct));
    config.heightPct = next;
    saveConfig(config);
    applyWindowState();
    rebuildTrayMenu();
    return config.heightPct;
  });

  // Пользователь тащит окно за верхнюю панель.
  ipcMain.on('window:drag-begin', () => {
    if (!win || win.isDestroyed()) return;
    dragOrigin = win.getBounds();
  });

  ipcMain.on('window:drag-move', (_event, payload) => {
    if (!win || win.isDestroyed() || !dragOrigin) return;
    const dx = Number(payload && payload.dx) || 0;
    const dy = Number(payload && payload.dy) || 0;
    win.setPosition(Math.round(clampX(dragOrigin.x + dx, dragOrigin.width)), Math.round(clampY(dragOrigin.y + dy)), false);
  });

  ipcMain.on('window:drag-end', () => {
    if (!win || win.isDestroyed()) {
      dragOrigin = null;
      return;
    }
    const bounds = win.getBounds();
    const base = baseBounds(isOpen);
    dragOrigin = null;
    setConfig({ offsetX: bounds.x - base.x, offsetY: bounds.y - base.y });
  });

  ipcMain.handle('window:reset-position', () => setConfig({ offsetX: null, offsetY: null }));

  ipcMain.handle('session:resume', (_event, sessionId) => {
    if (!monitor) return { ok: false, error: 'Монитор ещё не готов' };
    const session = monitor.findRecentSession(String(sessionId || ''));
    if (!session) return { ok: false, error: 'Сессия не найдена' };
    return resumeSession(session);
  });

  ipcMain.on('usage:refresh', () => monitor && monitor.recheck());
  ipcMain.on('shell:open', (_event, target) => {
    if (typeof target === 'string' && target) shell.openPath(target);
  });
}

function createWindow() {
  const bounds = windowBounds(false);
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: Boolean(config.alwaysOnTop),
    hasShadow: false,
    show: false,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(Boolean(config.alwaysOnTop), 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    sendLayout();
    if (isOpen) win.webContents.send('drawer:open', { pinned: isPinned });
    sendPin();
  });

  win.once('ready-to-show', () => {
    win.showInactive();
    if (process.argv.includes('--open')) {
      setTimeout(() => openDrawer({ pin: true }), 700);
    }
  });

  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function captureArgument() {
  const arg = process.argv.find((value) => value.startsWith('--capture='));
  return arg ? arg.slice('--capture='.length) : '';
}

async function runCapture() {
  const target = captureArgument();
  if (!target) return;
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 8000));

  try {
    const collapsed = await win.webContents.capturePage();
    const collapsedPath = target.replace(/\.png$/i, '') + '-collapsed.png';
    fs.writeFileSync(collapsedPath, collapsed.toPNG());

    openDrawer({ pin: true });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const expanded = await win.webContents.capturePage();
    fs.writeFileSync(target, expanded.toPNG());

    if (process.argv.includes('--capture-settings')) {
      await win.webContents.executeJavaScript("document.getElementById('settingsBtn').click()");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const settingsShot = await win.webContents.capturePage();
      const settingsPath = target.replace(/\.png$/i, '') + '-settings.png';
      fs.writeFileSync(settingsPath, settingsShot.toPNG());
      console.log('Perch settings capture saved:', settingsPath);
    }

    console.log('Perch capture saved:', target);
  } catch (error) {
    console.error('Perch capture failed:', error);
  }

  if (process.argv.includes('--capture-exit')) {
    isQuitting = true;
    app.quit();
  }
}

app.on('second-instance', () => openDrawer({ pin: true, focus: true }));

app.whenReady().then(() => {
  config = loadConfig();

  statusline = new StatuslineManager({
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    userDataPath: app.getPath('userData'),
  });
  applyStatusline(config.statusline);

  monitor = new Monitor({ appDataPath: app.getPath('userData'), statusline });
  monitor.on('state', updateState);
  monitor.on('notify', handleNotification);
  monitor.start();

  registerIpc();
  createWindow();
  createTray();
  Menu.setApplicationMenu(null);
  applyLoginItem();

  const shortcutOk = globalShortcut.register(HOTKEY, toggleDrawer);
  if (!shortcutOk) console.warn('Perch: could not register global shortcut', HOTKEY);

  screen.on('display-metrics-changed', () => applyWindowState());
  screen.on('display-added', () => applyWindowState());
  screen.on('display-removed', () => applyWindowState());

  if (!config.onboarded) {
    config.onboarded = true;
    saveConfig(config);
    setTimeout(() => {
      openDrawer({ pin: false });
      setTimeout(() => {
        if (!isPinned) closeDrawer(true);
      }, 9000);
    }, 1000);
  }

  runCapture();

  setTimeout(() => {
    if (monitor) monitor.refreshUsage(true);
  }, 3000);
});

app.on('before-quit', () => {
  isQuitting = true;
  if (monitor) monitor.stop();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('activate', () => {
  if (!win) {
    createWindow();
    if (isOpen) setTimeout(() => openDrawer({ pin: isPinned }), 300);
  }
});
