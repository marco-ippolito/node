import { spawnPromisified } from '../common/index.mjs';
import * as fixtures from '../common/fixtures.mjs';
import { match, strictEqual } from 'node:assert';
import { test } from 'node:test';

test('expect failure of a mts file with commonjs syntax', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/cts/test-cts-but-module-syntax.cts'),
  ]);

  strictEqual(result.stdout, '');
  match(result.stderr, /To load an ES module, set "type": "module" in the package\.json or use the \.mjs extension\./);
  strictEqual(result.code, 1);
});

test('execute of a cts file import cts module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/cts/test-require-commonjs.cts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a cts file importing ts export', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/cts/test-require-ts-file.cts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a cts file importing mts export', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/cts/test-require-mts-module.cts'),
  ]);

  strictEqual(result.stdout, '');
  match(result.stderr, /Error \[ERR_REQUIRE_ESM\]: require\(\) of ES Module/);
  strictEqual(result.code, 1);
});

test('execute a cts file importing mts export', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-require-module',
    fixtures.path('typescript/cts/test-require-mts-module.cts'),
  ]);

  match(result.stderr, /Support for loading ES Module in require\(\) is an experimental feature and might change at any time/);
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('expect failure of a cts with default type module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-default-type=module', // Keeps working with commonjs
    fixtures.path('typescript/cts/test-require-commonjs.cts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('expect failure of a cts with default type module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/cts/test-cts-node_modules.cts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('expect failure of a cts with default type module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/cts/test-ts-node_modules.cts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('expect failure of a cts with default type module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/cts/test-mts-node_modules.cts'),
  ]);

  strictEqual(result.stdout, '');
  match(result.stderr, /Error \[ERR_REQUIRE_ESM\]: require\(\)/);
  strictEqual(result.code, 1);
});

test('expect failure of a cts with default type module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-require-module',
    fixtures.path('typescript/cts/test-mts-node_modules.cts'),
  ]);

  match(result.stderr, /Support for loading ES Module in require\(\) is an experimental feature and might change at any time/);
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});
