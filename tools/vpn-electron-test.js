'use strict';

const { app } = require('electron');
const { detectVpn } = require('../src/vpn');

app.whenReady().then(async () => {
  const started = Date.now();
  const result = await detectVpn();
  console.log('Perch VPN electron probe:', Date.now() - started, 'ms', JSON.stringify(result));
  app.quit();
});
