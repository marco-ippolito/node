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

test('bodyLimit closes oversized request bodies with 413', async () => {
  const server = createServer({
    bodyLimit: 4,
  }, common.mustCall(async (ctx) => {
    const { request } = ctx;
    await assert.rejects(request.text(), {
      code: 'ERR_WEB_HTTP_BODY_LIMIT',
    });
    return new Response('unreachable');
  }));

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'POST /overflow HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Content-Length: 5\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n' +
                                 'hello');

    assert.match(raw, /^HTTP\/1\.1 413 Payload Too Large\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});
