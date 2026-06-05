// Flags: --experimental-web-http-server --no-warnings --permission --allow-net --allow-fs-read=*
'use strict';

const common = require('../common');
const assert = require('node:assert');
const net = require('node:net');
const { once } = require('node:events');
const { test } = require('node:test');
const {
  listen,
} = require('../common/http-web');

const { createServer } = require('node:http/web');

test('headersTimeout sends 408 and closes incomplete requests', async () => {
  const server = createServer({
    headersTimeout: 30,
  }, common.mustNotCall());

  await listen(server);
  try {
    const socket = net.connect(server.address().port, '127.0.0.1');
    socket.setEncoding('utf8');
    await once(socket, 'connect');

    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk;
    });

    socket.write('GET /slow HTTP/1.1\r\n');
    await once(socket, 'end');

    assert.match(raw, /^HTTP\/1\.1 408 Request Timeout\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  } finally {
    await server.close();
  }
});

test('headersTimeout applies to the next keep-alive request', async () => {
  const server = createServer({
    headersTimeout: 30,
    keepAliveTimeout: 1_000,
  }, common.mustCall(() => new Response('first')));

  await listen(server);
  try {
    const socket = net.connect(server.address().port, '127.0.0.1');
    socket.setEncoding('utf8');
    await once(socket, 'connect');

    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk;
    });

    const firstResponse = once(socket, 'data');
    socket.write('GET /first HTTP/1.1\r\n' +
                 'Host: example.test\r\n' +
                 'Connection: keep-alive\r\n' +
                 '\r\n');
    await firstResponse;

    assert.match(raw, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(raw, /first/);

    socket.write('GET /slow HTTP/1.1\r\n');
    await once(socket, 'end');

    assert.match(raw, /HTTP\/1\.1 408 Request Timeout\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  } finally {
    await server.close();
  }
});
