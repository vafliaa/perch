'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const THEMES = ['perch', 'midnight', 'graphite', 'daylight'];

const DEFAULTS = {
  side: 'right',
  heightPct: 0.76,
  panelWidth: 432,
  alwaysOnTop: true,
  autoHide: true,
  notifications: true,
  launchAtLogin: false,
  openOnAttention: false,
  showContext: true,
  statusline: false,
  onboarded: false,
  theme: 'perch',
  fontSize: 1.25,
  offsetX: null,
  offsetY: null,
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitize(config) {
  const next = { ...DEFAULTS, ...(config || {}) };
  next.side = next.side === 'left' ? 'left' : 'right';
  next.heightPct = clampNumber(next.heightPct, 0.4, 0.96, DEFAULTS.heightPct);
  next.panelWidth = Math.round(clampNumber(next.panelWidth, 380, 560, DEFAULTS.panelWidth));
  next.alwaysOnTop = Boolean(next.alwaysOnTop);
  next.autoHide = Boolean(next.autoHide);
  next.notifications = Boolean(next.notifications);
  next.launchAtLogin = Boolean(next.launchAtLogin);
  next.openOnAttention = Boolean(next.openOnAttention);
  next.showContext = Boolean(next.showContext);
  next.statusline = Boolean(next.statusline);
  next.onboarded = Boolean(next.onboarded);

  next.theme = THEMES.includes(next.theme) ? next.theme : DEFAULTS.theme;
  next.fontSize = Number(clampNumber(next.fontSize, 1, 1.6, DEFAULTS.fontSize).toFixed(2));

  const offsetX = Number(next.offsetX);
  const offsetY = Number(next.offsetY);
  next.offsetX = Number.isFinite(offsetX) ? clampNumber(offsetX, -3000, 3000, 0) : null;
  next.offsetY = Number.isFinite(offsetY) ? clampNumber(offsetY, -3000, 3000, 0) : null;
  return next;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return sanitize(JSON.parse(raw));
  } catch {
    return sanitize({});
  }
}

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(sanitize(config), null, 2), 'utf8');
  } catch (error) {
    console.error('Could not save Perch config:', error.message);
  }
}

module.exports = { THEMES, DEFAULTS, configPath, loadConfig, saveConfig, sanitize };
