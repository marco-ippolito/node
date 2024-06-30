'use strict';
const { spawnPromisified } = require('../common');
const fixtures = require('../common/fixtures');
const { match, strictEqual } = require('node:assert');
const { test } = require('node:test');

test('execute a typescript file', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-typescript.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a typescript file with imports', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-default-type=module',
    fixtures.path('typescript/ts/test-import-foo.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a typescript with node_modules', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-default-type=module',
    fixtures.path('typescript/ts/test-typescript-node-modules.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('expect error when executing a typescript file with imports with no extensions', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-default-type=module',
    fixtures.path('typescript/ts/test-import-no-extension.ts'),
  ]);

  match(result.stderr, /Error \[ERR_MODULE_NOT_FOUND\]:/);
  strictEqual(result.stdout, '');
  strictEqual(result.code, 1);
});

test('expect error when executing a typescript file with enum', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-enums.ts'),
  ]);

  // This error should be thrown during transformation
  match(result.stderr, /TypeScript enum is not supported in strip-only mode/);
  strictEqual(result.stdout, '');
  strictEqual(result.code, 1);
});

test('expect error when executing a typescript file with experimental decorators', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-experimental-decorators.ts'),
  ]);
  // This error should be thrown during transformation
  match(result.stderr, /Decorators are not supported/);
  strictEqual(result.stdout, '');
  strictEqual(result.code, 1);
});

test('expect error when executing a typescript file with namespaces', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-namespaces.ts'),
  ]);
  // This error should be thrown during transformation
  match(result.stderr, /TypeScript namespace declaration is not supported in strip-only mode/);
  strictEqual(result.stdout, '');
  strictEqual(result.code, 1);
});

test('execute a typescript file with type definition', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-import-types.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a typescript file with commonjs syntax', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-commonjs-parsing.ts'),
  ]);
  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a ts file with module syntax', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-default-type=module',
    fixtures.path('typescript/ts/test-module-typescript.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('expect failure of a ts file requiring esm syntax', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-require-module',
    fixtures.path('typescript/ts/test-require-module.ts'),
  ]);

  match(result.stderr, /Support for loading ES Module in require\(\) is an experimental feature and might change at any time/);
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('expect stacktrace of a ts file to be corrct', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-whitespacing.ts'),
  ]);

  strictEqual(result.stdout, '');
  match(result.stderr, /test-whitespacing\.ts:5:7/);
  strictEqual(result.code, 1);
});

test('execute commonjs ts file from node_modules with require module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-default-type=module',
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-import-ts-node-modules.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a typescript file with commonjs syntax but default type module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-default-type=module',
    fixtures.path('typescript/ts/test-commonjs-parsing.ts'),
  ]);
  strictEqual(result.stdout, '');
  match(result.stderr, /require is not defined in ES module scope, you can use import instead/);
  strictEqual(result.code, 1);
});

test('execute a typescript file with commonjs syntax requiring cts', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-require-cts.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a typescript file with commonjs syntax requiring mts', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    fixtures.path('typescript/ts/test-require-mts.ts'),
  ]);

  strictEqual(result.stdout, '');
  match(result.stderr, /Error \[ERR_REQUIRE_ESM\]: require\(\) of ES Module/);
  strictEqual(result.code, 1);
});

test('execute a typescript file with commonjs syntax requiring mts with require module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-require-module',
    fixtures.path('typescript/ts/test-require-mts.ts'),
  ]);

  match(result.stderr, /Support for loading ES Module in require\(\) is an experimental feature and might change at any time/);
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});

test('execute a typescript file with commonjs syntax requiring mts with require module', async () => {
  const result = await spawnPromisified(process.execPath, [
    '--experimental-strip-types',
    '--experimental-default-type=commonjs',
    fixtures.path('typescript/ts/test-require-cts.ts'),
  ]);

  strictEqual(result.stderr, '');
  match(result.stdout, /Hello, TypeScript!/);
  strictEqual(result.code, 0);
});
