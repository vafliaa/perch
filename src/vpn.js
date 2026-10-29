'use strict';

const { execFile } = require('child_process');

const CHECK_TIMEOUT_MS = 9000;

const STRONG_VPN_NAME =
  /(vpn|wireguard|wintun|openvpn|nordlynx|proton\s*vpn|protonvpn|mullvad|tailscale|clash|sing[- ]?box|xray|v2ray|hysteria|outline|shadowsocks|zerotier|amnezia|cloudflare\s*warp|anyconnect|globalprotect|fortinet|pulse\s*secure|check\s*point|juniper|sangfor|hillstone)/i;
const WEAK_VPN_NAME = /(^|[^a-z])(tap|tun|tunnel)([^a-z]|$)/i;
const NORMAL_ADAPTER =
  /(teredo|isatap|6to4|loopback|bluetooth|hyper-v|vethernet|vmware|virtualbox|docker|wsl|wi-fi\s*direct|npcap|hamachi)/i;
const VPN_PROCESS =
  /^(v2raytun|xray|xraycore|sing-box|singbox|clash|clash-verge|mihomo|hysteria|wireguard|openvpn|nordlynx|protonvpn|proton-vpn|mullvad|tailscale|outline|shadowsocks|zerotier|warp-svc)/i;

const PROBE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$proxy = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue
$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { [string]$_.Status -eq 'Up' } | ForEach-Object {
  [pscustomobject]@{
    Name = [string]$_.Name
    Description = [string]$_.InterfaceDescription
    Status = [string]$_.Status
    InterfaceIndex = [int]$_.InterfaceIndex
  }
})
$processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -match '^(v2raytun|xray|xraycore|sing-box|singbox|clash|clash-verge|mihomo|hysteria|wireguard|openvpn|nordlynx|protonvpn|proton-vpn|mullvad|tailscale|outline|shadowsocks|zerotier|warp-svc)'
} | ForEach-Object { [pscustomobject]@{ ProcessName = [string]$_.ProcessName; Id = [int]$_.Id } })
$vpnConnections = @(Get-VpnConnection -ErrorAction SilentlyContinue | Where-Object { [string]$_.ConnectionStatus -eq 'Connected' } | ForEach-Object {
  [pscustomobject]@{ Name = [string]$_.Name; ServerAddress = [string]$_.ServerAddress }
})
[pscustomobject]@{
  proxy = [pscustomobject]@{
    enable = [int]$proxy.ProxyEnable
    server = [string]$proxy.ProxyServer
    autoConfigUrl = [string]$proxy.AutoConfigURL
  }
  adapters = $adapters
  processes = $processes
  vpnConnections = $vpnConnections
} | ConvertTo-Json -Depth 5 -Compress
`;

function isVpnAdapter(adapter) {
  const label = `${adapter.Name || ''} ${adapter.Description || ''}`.trim();
  if (!label) return false;
  if (STRONG_VPN_NAME.test(label)) return true;
  return WEAK_VPN_NAME.test(label) && !NORMAL_ADAPTER.test(label);
}

function isLocalProxy(server) {
  const value = String(server || '');
  return /(^|[=;,\s])(127\.0\.0\.1|localhost|\[::1\]|::1)(:|\b)/i.test(value);
}

function classifyVpn(data) {
  const adapters = Array.isArray(data && data.adapters) ? data.adapters : [];
  const processes = Array.isArray(data && data.processes) ? data.processes : [];
  const vpnConnections = Array.isArray(data && data.vpnConnections) ? data.vpnConnections : [];
  const proxy = (data && data.proxy) || {};

  const vpnAdapters = adapters.filter(isVpnAdapter);

  const proxyServer = String(proxy.server || '').trim();
  const proxyEnabled = Number(proxy.enable) === 1 && Boolean(proxyServer);
  const proxyLocal = isLocalProxy(proxyServer);
  const proxyTunnel = proxyEnabled && (!proxyLocal || processes.length > 0);
  const builtIn = vpnConnections.length > 0;

  if (vpnAdapters.length || builtIn || proxyTunnel) {
    let reason = '';
    if (vpnAdapters.length) {
      reason = `VPN-адаптер «${vpnAdapters[0].Description || vpnAdapters[0].Name}»`;
    } else if (builtIn) {
      reason = `Windows VPN «${vpnConnections[0].Name}»`;
    } else {
      reason = `Системный прокси ${proxyServer}`;
    }

    return {
      enabled: true,
      status: 'on',
      reason,
      detail: {
        adapter: vpnAdapters.length ? vpnAdapters[0].Description || vpnAdapters[0].Name : '',
        proxy: proxyEnabled ? proxyServer : '',
        processes: processes.map((item) => item.ProcessName),
        vpnConnections: vpnConnections.map((item) => item.Name),
      },
    };
  }

  let reason = 'VPN не обнаружен';
  if (proxyEnabled && proxyLocal && !processes.length) {
    reason = 'Прокси включён, но VPN-клиент не запущен';
  } else if (proxyEnabled) {
    reason = 'Прокси включён, но туннель не подтверждён';
  } else if (processes.length) {
    reason = `VPN-клиент запущен (${processes[0].ProcessName}), туннель не активен`;
  } else if (proxy.autoConfigUrl) {
    reason = 'Настроен только PAC-файл, VPN не подтверждён';
  }

  return {
    enabled: false,
    status: 'off',
    reason,
    detail: {
      adapter: '',
      proxy: proxyEnabled ? proxyServer : '',
      processes: processes.map((item) => item.ProcessName),
      vpnConnections: [],
    },
  };
}

function detectVpn() {
  return new Promise((resolve) => {
    const options = {
      windowsHide: true,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    };

    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT],
      options,
      (error, stdout) => {
        if (error) {
          resolve({
            enabled: false,
            status: 'unknown',
            reason: 'Не удалось проверить VPN',
            detail: { error: error.message, raw: String(stdout || '').slice(0, 300) },
          });
          return;
        }

        try {
          const data = JSON.parse(String(stdout || '').trim());
          resolve(classifyVpn(data));
        } catch (parseError) {
          resolve({
            enabled: false,
            status: 'unknown',
            reason: 'Не удалось проверить VPN',
            detail: { error: parseError.message, raw: String(stdout || '').slice(0, 300) },
          });
        }
      },
    );
  });
}

module.exports = { detectVpn, classifyVpn };
