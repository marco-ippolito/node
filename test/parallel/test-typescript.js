'use strict';
const { spawnPromisified } = require('../common');
const fixtures = require('../common/fixtures');
const { strictEqual } = require('node:assert');
const { test } = require('node:test');

test('execute a typescript file', async () => {
  const {
    code,
    stderr,
    stdout,
  } = await spawnPromisified(process.execPath, [
    '--experimental-typescript',
    fixtures.path('typescript/test-typescript.ts'),
  ], { stdio: ['inherit'] });

  strictEqual(code, 0);
  strictEqual(stderr, '');
  strictEqual(stdout, 'Hello, TypeScript!\n');
});

test('execute a typescript file with imports', async () => {
  const {
    code,
    stderr,
    stdout,
  } = await spawnPromisified(process.execPath, [
    '--experimental-typescript',
    fixtures.path('typescript/b.ts'),
  ], { stdio: ['inherit'] });

  strictEqual(code, 0);
  strictEqual(stderr, '');
  strictEqual(stdout, 'foo\n');
});
