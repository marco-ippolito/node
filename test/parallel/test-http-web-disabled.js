'use strict';

require('../common');
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSyncAndAssert } = require('../common/child_process');

test('node:http/web is hidden without the flag', async () => {
  assert.throws(
    () => require('node:http/web'),
    { code: 'ERR_UNKNOWN_BUILTIN_MODULE' },
  );

  await assert.rejects(
    import('node:http/web'),
    { code: 'ERR_UNKNOWN_BUILTIN_MODULE' },
  );
});

test('node:http/web is visible only with the flag', () => {
  spawnSyncAndAssert(process.execPath, [
    '--experimental-web-http-server',
    '--no-warnings',
    '-e',
    'const { createServer } = require("node:http/web"); console.log(typeof createServer);',
  ], { stdout: 'function\n' });

  spawnSyncAndAssert(process.execPath, [
    '--experimental-web-http-server',
    '--no-warnings',
    '-p',
    'require("node:module").builtinModules.includes("node:http/web")',
  ], { stdout: 'true\n' });

  spawnSyncAndAssert(process.execPath, [
    '--experimental-web-http-server',
    '--no-warnings',
    '-e',
    'require("http/web")',
  ], { status: 1, stderr: /Cannot find module 'http\/web'/ });

  spawnSyncAndAssert(process.execPath, [
    '--no-experimental-web-http-server',
    '-p',
    'require("node:module").builtinModules.includes("node:http/web")',
  ], { stdout: 'false\n' });
});
