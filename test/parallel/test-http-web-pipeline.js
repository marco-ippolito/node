// Flags: --experimental-web-http-server --no-warnings --permission --allow-net --allow-fs-read=*
'use strict';

const common = require('../common');
const assert = require('node:assert');
const { test } = require('node:test');
const {
  assertContainsInOrder,
  rawRequest,
  withWebServer,
} = require('../common/http-web');

const { createServer } = require('node:http/web');

test('pipelined responses are written in request order', async () => {
  const server = createServer(common.mustCall(async (ctx) => {
    const { request } = ctx;
    const { pathname } = new URL(request.url);
    if (pathname === '/slow') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return new Response(pathname);
  }, 2));

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'GET /slow HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: keep-alive\r\n' +
                                 '\r\n' +
                                 'GET /fast HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n');

    assert.strictEqual(raw.match(/HTTP\/1\.1 200 OK/g).length, 2);
    assertContainsInOrder(raw, ['/slow', '/fast']);
  }));
});
