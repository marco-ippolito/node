// Flags: --experimental-web-http-server --no-warnings
'use strict';

const common = require('../common');
const assert = require('node:assert');
const { test } = require('node:test');

const { createServer } = require('node:http/web');

test('server.inject accepts Web Request and returns Web Response', async () => {
  assert.strictEqual(typeof createServer, 'function');
  const input = new Request('http://example.test/hello?name=node', {
    method: 'POST',
    headers: {
      'X-Test': 'yes',
    },
    body: 'hello',
  });
  let handled = 0;

  const server = createServer(common.mustCall(async function(ctx) {
    const { request } = ctx;
    assert.strictEqual(arguments.length, 1);
    handled++;
    assert.strictEqual(typeof ctx.hijack, 'function');

    assert.strictEqual(request, input);
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.headers.get('x-test'), 'yes');

    const url = new URL(request.url);
    const body = await request.text();

    return new Response(`${url.pathname}:${url.searchParams.get('name')}:${body}`, {
      status: 202,
      headers: {
        'X-Web-HTTP': 'yes',
      },
    });
  }));

  assert.strictEqual(server.on, undefined);
  assert.strictEqual(server.emit, undefined);

  await assert.rejects(server.inject('http://example.test/'), {
    code: 'ERR_INVALID_ARG_TYPE',
  });

  const response = await server.inject(input);
  assert.strictEqual(response.status, 202);
  assert.strictEqual(response.headers.get('x-web-http'), 'yes');
  assert.strictEqual(await response.text(), '/hello:node:hello');
  assert.strictEqual(handled, 1);
});

test('server.inject coerces handler return values to Web Response', async () => {
  const server = createServer(common.mustCall((ctx) => {
    const { request } = ctx;
    assert.strictEqual(request.url, 'http://example.test/coerce');
    return 'coerced body';
  }));

  const response = await server.inject(new Request('http://example.test/coerce'));

  assert.strictEqual(response.status, 200);
  assert.strictEqual(await response.text(), 'coerced body');
});

test('server.inject returns streamed Web Response bodies', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('one'));
      controller.enqueue(new TextEncoder().encode('two'));
      controller.close();
    },
  });
  const server = createServer(common.mustCall(() => {
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }));

  const response = await server.inject(new Request('http://example.test/stream'));

  assert.strictEqual(response.headers.get('content-type'), 'text/plain');
  assert.strictEqual(await response.text(), 'onetwo');
});

test('server.inject converts handler errors before hijack to 500', async () => {
  const server = createServer(common.mustCall(() => {
    throw new Error('boom');
  }));

  const response = await server.inject(new Request('http://example.test/error'));

  assert.strictEqual(response.status, 500);
  assert.strictEqual(await response.text(), '');
});
