// Flags: --experimental-web-http-server --no-warnings --permission --allow-net --allow-fs-read=*
'use strict';

const common = require('../common');
const assert = require('node:assert');
const net = require('node:net');
const { once } = require('node:events');
const { test } = require('node:test');
const {
  assertContainsInOrder,
  listen,
  rawRequest,
  withWebServer,
} = require('../common/http-web');

const { createServer } = require('node:http/web');

test('keep-alive serves multiple requests on one connection until close', async () => {
  const server = createServer(common.mustCall((ctx) => {
    const { request } = ctx;
    const { pathname } = new URL(request.url);
    return new Response(pathname);
  }, 2));

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'GET /one HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: keep-alive\r\n' +
                                 '\r\n' +
                                 'GET /two HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n');

    assert.strictEqual(raw.match(/HTTP\/1\.1 200 OK/g).length, 2);
    assertContainsInOrder(raw, ['/one', '/two']);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});

test('keepAliveTimeout closes idle keep-alive connections', async () => {
  const server = createServer({
    keepAliveTimeout: 30,
  }, common.mustCall(() => new Response('idle')));

  await listen(server);
  try {
    const socket = net.connect(server.address().port, '127.0.0.1');
    socket.setEncoding('utf8');
    await once(socket, 'connect');

    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk;
    });

    socket.write('GET /idle HTTP/1.1\r\n' +
                 'Host: example.test\r\n' +
                 'Connection: keep-alive\r\n' +
                 '\r\n');
    await once(socket, 'end');

    assert.match(raw, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(raw, /idle/);
  } finally {
    await server.close();
  }
});
