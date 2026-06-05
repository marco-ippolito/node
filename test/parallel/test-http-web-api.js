// Flags: --experimental-web-http-server --no-warnings
'use strict';

const common = require('../common');
const assert = require('node:assert');
const { test } = require('node:test');

const { createServer } = require('node:http/web');

test('createServer validates handler and options', () => {
  assert.throws(() => createServer(), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
  assert.throws(() => createServer({}, 'handler'), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
  assert.throws(() => createServer({ bodyLimit: -1 }, common.mustNotCall()), {
    code: 'ERR_OUT_OF_RANGE',
  });
  assert.throws(() => {
    createServer({
      headersTimeout: 2,
      requestTimeout: 1,
    }, common.mustNotCall());
  }, {
    code: 'ERR_OUT_OF_RANGE',
  });
});

test('createServer exposes promise lifecycle without EventEmitter API', async () => {
  const server = createServer(common.mustCall(() => new Response('ok')));

  assert.strictEqual(server.on, undefined);
  assert.strictEqual(server.emit, undefined);
  assert.strictEqual(server.address(), null);
  await server.close();

  const response = await server.inject(new Request('http://example.test/'));
  assert.strictEqual(await response.text(), 'ok');

  await server[Symbol.asyncDispose]();

  const explicit = createServer(null, common.mustCall(() => 'body'));
  const explicitResponse = await explicit.inject(new Request('http://example.test/'));
  assert.strictEqual(await explicitResponse.text(), 'body');
});
