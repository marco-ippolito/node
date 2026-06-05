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

test('missing HTTP/1.1 Host is rejected before user handler', async () => {
  const server = createServer(common.mustNotCall());

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'GET / HTTP/1.1\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n');

    assert.match(raw, /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});

test('duplicate HTTP/1.1 Host is rejected before user handler', async () => {
  const server = createServer(common.mustNotCall());

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'GET / HTTP/1.1\r\n' +
                                 'Host: first.example\r\n' +
                                 'Host: second.example\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n');

    assert.match(raw, /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});

test('HTTP versions older than 1.1 are rejected before user handler', async () => {
  const server = createServer(common.mustNotCall());

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'GET / HTTP/1.0\r\n' +
                                 '\r\n');

    assert.match(raw, /^HTTP\/1\.1 505 HTTP Version Not Supported\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});

test('rejected headers stop parsing pipelined bytes', async () => {
  const server = createServer(common.mustNotCall());

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'GET /bad HTTP/1.0\r\n' +
                                 '\r\n' +
                                 'GET /should-not-run HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n');

    assert.match(raw, /^HTTP\/1\.1 505 HTTP Version Not Supported\r\n/);
    assert.doesNotMatch(raw, /200 OK/);
  }));
});

test('malformed request line and header overflow close with HTTP errors', async () => {
  {
    const server = createServer(common.mustNotCall());
    await withWebServer(server, common.mustCall(async (running) => {
      const raw = await rawRequest(running,
                                   'GET / HTTP/1.1\r\n' +
                                   'Bad Header\r\n' +
                                   'Host: example.test\r\n' +
                                   '\r\n');

      assert.match(raw, /^HTTP\/1\.1 400 Bad Request\r\n/);
      assert.match(raw, /Connection: close\r\n/i);
    }));
  }

  {
    const server = createServer({
      maxHeaderSize: 16,
    }, common.mustNotCall());
    await withWebServer(server, common.mustCall(async (running) => {
      const raw = await rawRequest(running,
                                   'GET /overflow HTTP/1.1\r\n' +
                                   'Host: example.test\r\n' +
                                   '\r\n');

      assert.match(raw, /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/);
      assert.match(raw, /Connection: close\r\n/i);
    }));
  }
});

test('conflicting content length and transfer encoding is rejected', async () => {
  const server = createServer(common.mustNotCall());

  await withWebServer(server, common.mustCall(async (running) => {
    const raw = await rawRequest(running,
                                 'POST /conflict HTTP/1.1\r\n' +
                                 'Host: example.test\r\n' +
                                 'Content-Length: 1\r\n' +
                                 'Transfer-Encoding: chunked\r\n' +
                                 'Connection: close\r\n' +
                                 '\r\n' +
                                 '0\r\n' +
                                 '\r\n');

    assert.match(raw, /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.match(raw, /Connection: close\r\n/i);
  }));
});
