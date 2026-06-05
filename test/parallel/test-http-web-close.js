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

test('close destroys active accepted connections before resolving', async () => {
  const server = createServer(common.mustNotCall());

  await listen(server);

  const socket = net.connect(server.address().port, '127.0.0.1');
  await once(socket, 'connect');

  const closePromise = server.close();
  assert.strictEqual(typeof closePromise.then, 'function');

  await Promise.all([
    once(socket, 'close'),
    closePromise,
  ]);
  assert.strictEqual(server.address(), null);
});

test('close destroys idle keep-alive connections before resolving', async () => {
  const server = createServer(common.mustCall(() => new Response('close-me')));

  await listen(server);

  const socket = net.connect(server.address().port, '127.0.0.1');
  socket.setEncoding('utf8');
  await once(socket, 'connect');

  let raw = '';
  socket.on('data', (chunk) => {
    raw += chunk;
  });

  socket.write('GET / HTTP/1.1\r\n' +
               'Host: example.test\r\n' +
               'Connection: keep-alive\r\n' +
               '\r\n');

  while (!raw.includes('close-me')) {
    await once(socket, 'data');
  }

  const closePromise = server.close();
  assert.strictEqual(typeof closePromise.then, 'function');

  await Promise.all([
    once(socket, 'close'),
    closePromise,
  ]);
  assert.match(raw, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(raw, /close-me/);
  assert.strictEqual(server.address(), null);
});

test('close tolerates pending handler completion after connection close', async () => {
  let resolveHandler;
  let markHandlerCalled;
  const handlerCalled = new Promise((resolve) => {
    markHandlerCalled = resolve;
  });
  const handlerResult = new Promise((resolve) => {
    resolveHandler = resolve;
  });
  const server = createServer(common.mustCall(() => {
    markHandlerCalled();
    return handlerResult;
  }));

  await listen(server);

  const socket = net.connect(server.address().port, '127.0.0.1');
  socket.setEncoding('utf8');
  await once(socket, 'connect');

  let raw = '';
  socket.on('data', (chunk) => {
    raw += chunk;
  });

  socket.write('GET /pending HTTP/1.1\r\n' +
               'Host: example.test\r\n' +
               'Connection: keep-alive\r\n' +
               '\r\n');
  await handlerCalled;

  const closePromise = server.close();
  assert.strictEqual(typeof closePromise.then, 'function');

  await Promise.all([
    once(socket, 'close'),
    closePromise,
  ]);

  resolveHandler(new Response('late'));
  await Promise.resolve();
  assert.strictEqual(raw, '');
});
