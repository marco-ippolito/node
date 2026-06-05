// Flags: --experimental-web-http-server --no-warnings --permission --allow-net --allow-fs-read=*
'use strict';

const common = require('../common');
const assert = require('node:assert');
const { test } = require('node:test');
const {
  rawRequest,
  withWebServer,
} = require('../common/http-web');

const { createServer } = require('node:http/web');

test('CONNECT is deferred and returns 501 without calling handler', async () => {
  const server = createServer(common.mustNotCall());

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'CONNECT example.test:443 HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n');

    assert.match(raw, /^HTTP\/1\.1 501 Not Implemented\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});

test('Upgrade is deferred and returns 501 without calling handler', async () => {
  const server = createServer(common.mustNotCall());

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'GET /socket HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: Upgrade\r\n' +
                                 'Upgrade: websocket\r\n' +
                                 '\r\n');

    assert.match(raw, /^HTTP\/1\.1 501 Not Implemented\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});
