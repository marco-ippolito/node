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

test('network request creates Web Request with URL, headers, and body', async () => {
  const server = createServer(common.mustCall(async function(ctx) {
    const { request } = ctx;
    assert.strictEqual(arguments.length, 1);
    assert.strictEqual(typeof ctx.hijack, 'function');
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.url, 'http://example.test/submit?x=1');
    assert.strictEqual(request.headers.get('x-repeat'), 'one, two');
    assert.strictEqual(await request.text(), 'hello');

    return new Response('ok');
  }));

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'POST /submit?x=1 HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'X-Repeat: one\r\n' +
                                 'X-Repeat: two\r\n' +
                                 'Content-Length: 5\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n' +
                                 'hello');

    assert.match(raw, /^HTTP\/1\.1 200 OK\r\n/);
    assert.strictEqual(responseBody(raw), '2\r\nok\r\n0\r\n\r\n');
  }));
});
