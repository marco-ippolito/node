// Flags: --experimental-web-http-server --no-warnings --permission --allow-net --allow-fs-read=*
'use strict';

const common = require('../common');
const assert = require('node:assert');
const { test } = require('node:test');
const {
  rawRequest,
  responseBody,
  withWebServer,
} = require('../common/http-web');

const { createServer } = require('node:http/web');

test('network response serializes fixed and chunked Web Response bodies', async () => {
  const server = createServer(common.mustCall((ctx) => {
    const { request } = ctx;
    const { pathname } = new URL(request.url);
    if (pathname === '/fixed') {
      return new Response('fixed', {
        headers: {
          'Content-Length': '5',
          'Content-Type': 'text/plain',
        },
      });
    }
    return new Response('chunked');
  }, 2));

  await withWebServer(server, common.mustCall(async (running) => {
    const fixed = await rawRequest(running,
                                   'GET /fixed HTTP/1.1\r\n' +
                                   'Host: example.test\r\n' +
                                   'Connection: close\r\n' +
                                   '\r\n');
    assert.match(fixed, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(fixed, /Content-Length: 5\r\n/i);
    assert.strictEqual(responseBody(fixed), 'fixed');

    const chunked = await rawRequest(running,
                                     'GET /chunked HTTP/1.1\r\n' +
                                     'Host: example.test\r\n' +
                                     'Connection: close\r\n' +
                                     '\r\n');
    assert.match(chunked, /Transfer-Encoding: chunked\r\n/i);
    assert.strictEqual(responseBody(chunked), '7\r\nchunked\r\n0\r\n\r\n');
  }));
});

test('network response omits body for HEAD and no-body statuses', async () => {
  const server = createServer(common.mustCall((ctx) => {
    const { request } = ctx;
    const { pathname } = new URL(request.url);
    if (pathname === '/no-content') {
      return new Response(null, {
        status: 204,
        headers: {
          'X-No-Body': 'yes',
        },
      });
    }
    return new Response('must not be sent');
  }, 2));

  await withWebServer(server, common.mustCall(async (running) => {
    const head = await rawRequest(running,
                                  'HEAD /head HTTP/1.1\r\n' +
                                  'Host: example.test\r\n' +
                                  'Connection: close\r\n' +
                                  '\r\n');
    assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
    assert.strictEqual(responseBody(head), '');

    const noContent = await rawRequest(running,
                                       'GET /no-content HTTP/1.1\r\n' +
                                       'Host: example.test\r\n' +
                                       'Connection: close\r\n' +
                                       '\r\n');
    assert.match(noContent, /^HTTP\/1\.1 204 No Content\r\n/);
    assert.match(noContent, /X-No-Body: yes\r\n/i);
    assert.strictEqual(responseBody(noContent), '');
  }));
});
