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

test('network server handles basic GET and content-length POST', async () => {
  const server = createServer(common.mustCall(async (ctx) => {
    const { request } = ctx;
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.text() : '';
    return new Response(`${url.pathname}:${body}`, {
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }, 2));

  await withWebServer(server, common.mustCall(async (running) => {
    const get = await rawRequest(running,
                                 'GET /hello HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n');

    assert.match(get, /^HTTP\/1\.1 200 OK\r\n/);
    assert.strictEqual(responseBody(get), '7\r\n/hello:\r\n0\r\n\r\n');

    const post = await rawRequest(running,
                                  'POST /echo HTTP/1.1\r\n' +
                                  'Host: example.test\r\n' +
                                  'Content-Length: 5\r\n' +
                                  'Connection: close\r\n' +
                                  '\r\n' +
                                  'hello');

    assert.match(post, /^HTTP\/1\.1 200 OK\r\n/);
    assert.strictEqual(responseBody(post), 'b\r\n/echo:hello\r\n0\r\n\r\n');
  }));
});
