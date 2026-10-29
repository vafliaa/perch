'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Claude Code renders its status line with a JSON payload on stdin. That
 * payload includes the same rate-limit windows the /usage screen shows, so a
 * tiny bridge script lets Perch read them without calling Anthropic's API.
 */
const BRIDGE_SOURCE = `$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataFile = Join-Path $root 'statusline.json'
try {
  [IO.File]::WriteAllText($dataFile, $raw, (New-Object System.Text.UTF8Encoding($false)))
} catch {}

$d = $null
try { $d = $raw | ConvertFrom-Json } catch { exit 0 }

$parts = New-Object System.Collections.Generic.List[string]
if ($d.model.display_name) { $parts.Add([string]$d.model.display_name) }
$five = $d.rate_limits.five_hour.used_percentage
$week = $d.rate_limits.seven_day.used_percentage
$ctx = $d.context_window.used_percentage
if ($null -ne $five) { $parts.Add(('5h {0}%' -f [math]::Round([double]$five))) }
if ($null -ne $week) { $parts.Add(('7d {0}%' -f [math]::Round([double]$week))) }
if ($null -ne $ctx) { $parts.Add(('ctx {0}%' -f [math]::Round([double]$ctx))) }
if ($parts.Count -eq 0) { $parts.Add('Claude Code') }
[Console]::Out.Write(($parts -join ' | '))
`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function toForwardSlashes(value) {
  return String(value).replace(/\\/g, '/');
}

class StatuslineManager {
  constructor({ claudeDir, userDataPath }) {
    this.claudeDir = claudeDir;
    this.settingsPath = path.join(claudeDir, 'settings.json');
    this.scriptPath = path.join(userDataPath, 'statusline.ps1');
    this.dataPath = path.join(userDataPath, 'statusline.json');
    this.state = 'off';
    this.detail = '';
    this.installedAt = 0;
  }

  ensureScript() {
    try {
      fs.mkdirSync(path.dirname(this.scriptPath), { recursive: true });
      let current = '';
      try {
        current = fs.readFileSync(this.scriptPath, 'utf8');
      } catch {
        // first run
      }
      if (current !== BRIDGE_SOURCE) {
        fs.writeFileSync(this.scriptPath, BRIDGE_SOURCE, 'utf8');
      }
      return true;
    } catch (error) {
      console.error('Perch statusline script error:', error.message);
      return false;
    }
  }

  command() {
    const script = toForwardSlashes(this.scriptPath);
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
  }

  isOurs(statusLine) {
    if (!statusLine) return false;
    const command = typeof statusLine === 'string' ? statusLine : statusLine.command;
    return typeof command === 'string' && command.includes('statusline.ps1');
  }

  readSettings() {
    const raw = readJson(this.settingsPath);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    return {};
  }

  writeSettings(settings) {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  apply(enabled) {
    if (!enabled) {
      this.remove();
      return this.info();
    }

    if (!this.ensureScript()) {
      this.state = 'error';
      this.detail = 'Не удалось записать скрипт моста';
      return this.info();
    }

    try {
      const settings = this.readSettings();
      const current = settings.statusLine;

      if (current && !this.isOurs(current)) {
        this.state = 'foreign';
        this.detail =
          typeof current === 'string' ? current : current.command || 'Своя команда status line';
        return this.info();
      }

      const command = this.command();
      const next =
        current && typeof current === 'object'
          ? { ...current, type: 'command', command }
          : { type: 'command', command, padding: 0 };

      const changed = !current || JSON.stringify(current) !== JSON.stringify(next);
      if (changed) {
        settings.statusLine = next;
        this.writeSettings(settings);
      }
      this.installedAt = Date.now();
      this.state = 'installed';
      this.detail = this.scriptPath;
      console.log('Perch: status line bridge is active');
    } catch (error) {
      this.state = 'error';
      this.detail = error.message;
      console.error('Perch statusline install error:', error.message);
    }
    return this.info();
  }

  remove() {
    try {
      if (!fs.existsSync(this.settingsPath)) {
        this.state = 'off';
        return;
      }
      const settings = this.readSettings();
      if (this.isOurs(settings.statusLine)) {
        delete settings.statusLine;
        this.writeSettings(settings);
      }
      this.state = 'off';
      this.detail = '';
    } catch (error) {
      this.state = 'error';
      this.detail = error.message;
      console.error('Perch statusline remove error:', error.message);
    }
  }

  read() {
    try {
      const stat = fs.statSync(this.dataPath);
      if (!stat.size) return null;
      const parsed = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
      return { data: parsed, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  info() {
    return {
      state: this.state,
      detail: this.detail,
      settingsPath: this.settingsPath,
      dataPath: this.dataPath,
      active: this.state === 'installed',
    };
  }
}

module.exports = { StatuslineManager };
