// Flags: --experimental-web-http-server --no-warnings
'use strict';

const common = require('../common');
const assert = require('node:assert');
const { test } = require('node:test');

const { createServer } = require('node:http/web');

test('hijack exposes protocol writer without exposing sockets', async () => {
  let handled = 0;
  const server = createServer(common.mustCall(async function(ctx) {
    assert.strictEqual(arguments.length, 1);
    handled++;
    const protocol = ctx.hijack();

    assert.strictEqual('headers' in protocol, true);
    assert.strictEqual('body' in protocol, true);
    assert.strictEqual('socket' in protocol, false);
    assert.strictEqual(Object.hasOwn(protocol, 'method'), false);
    assert.strictEqual(Object.hasOwn(protocol, 'url'), false);
    assert.strictEqual(protocol.method, 'POST');
    assert.strictEqual(protocol.url, 'http://example.test/raw');
    assert.strictEqual(protocol.headers.get('x-test'), 'yes');

    const body = await new Response(protocol.body).text();

    protocol.writeHead(201, {
      'Content-Type': 'text/plain',
      'X-Hijacked': 'yes',
    });
    protocol.write(body);
    protocol.end();
  }));

  const response = await server.inject(new Request('http://example.test/raw', {
    method: 'POST',
    headers: {
      'X-Test': 'yes',
    },
    body: 'raw body',
  }));

  assert.strictEqual(response.status, 201);
  assert.strictEqual(response.headers.get('x-hijacked'), 'yes');
  assert.strictEqual(await response.text(), 'raw body');
  assert.strictEqual(handled, 1);
});

test('hijack can only be used once per exchange', async () => {
  const server = createServer(common.mustCall((ctx) => {
    ctx.hijack();
    assert.throws(() => ctx.hijack(), {
      code: 'ERR_INVALID_STATE',
    });
    return new Response('ignored');
  }));

  const response = await server.inject(new Request('http://example.test/double'));

  assert.strictEqual(response.status, 200);
  assert.strictEqual(await response.text(), '');
});

test('handler errors after hijack preserve protocol writer output', async () => {
  const server = createServer(common.mustCall((ctx) => {
    const protocol = ctx.hijack();
    protocol.writeHead(209, {
      'X-After-Hijack': 'yes',
    });
    protocol.end('manual');
    throw new Error('ignored after hijack');
  }));

  const response = await server.inject(new Request('http://example.test/error'));

  assert.strictEqual(response.status, 209);
  assert.strictEqual(response.headers.get('x-after-hijack'), 'yes');
  assert.strictEqual(await response.text(), 'manual');
});

test('hijack writeHead validates status and headers before writing', async () => {
  const server = createServer(common.mustCall((ctx) => {
    const protocol = ctx.hijack();

    assert.throws(() => protocol.writeHead(99), {
      code: 'ERR_HTTP_INVALID_STATUS_CODE',
    });
    assert.throws(() => protocol.writeHead(200, {
      'bad header': 'value',
    }), {
      code: 'ERR_INVALID_HTTP_TOKEN',
    });
    assert.throws(() => protocol.writeHead(200, {
      Good: 'bad\nvalue',
    }), {
      code: 'ERR_INVALID_CHAR',
    });
    assert.throws(() => protocol.writeHead(200, ['Odd', 'value', 'Missing']), {
      code: 'ERR_INVALID_ARG_VALUE',
    });

    protocol.writeHead(202, ['X-Flat', 'yes']);
    protocol.end('validated');
  }));

  const response = await server.inject(new Request('http://example.test/validate'));

  assert.strictEqual(response.status, 202);
  assert.strictEqual(response.headers.get('x-flat'), 'yes');
  assert.strictEqual(await response.text(), 'validated');
});
