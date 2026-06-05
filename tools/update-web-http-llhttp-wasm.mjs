#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM_BUILDER_CONTAINER =
  'ghcr.io/nodejs/wasm-builder@sha256:975f391d907e42a75b8c72eb77c782181e941608687d4d8694c3e9df415a0970';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WASM_SRC = join(ROOT, 'deps/llhttp');
const WASM_OUT = join(ROOT, 'lib/internal/http/llhttp-wasm.js');

const WASM_CC = process.env.WASM_CC || 'clang';
const WASM_OPT = process.env.WASM_OPT || 'wasm-opt';
const WASM_CFLAGS = [
  '--sysroot=/usr/share/wasi-sysroot',
  '-target',
  'wasm32-unknown-wasi',
  '-Ofast',
  '-fno-exceptions',
  '-fvisibility=hidden',
  '-mexec-model=reactor',
];
const WASM_LDFLAGS = [
  '-Wl,-error-limit=0',
  '-Wl,-O3',
  '-Wl,--lto-O3',
  '-Wl,--strip-all',
  '-Wl,--allow-undefined',
  '-Wl,--export-dynamic',
  '-Wl,--export-table',
  '-Wl,--export=malloc',
  '-Wl,--export=free',
  '-Wl,--no-entry',
];
const WASM_OPT_FLAGS = [
  '-O4',
  '--converge',
  '--strip-debug',
  '--strip-dwarf',
  '--strip-producers',
];

function writeWasmModule(wasm) {
  const wasmBase64 = wasm.toString('base64');
  mkdirSync(dirname(WASM_OUT), { recursive: true });
  writeFileSync(WASM_OUT, `'use strict';

const { Buffer } = require('buffer');

// eslint-disable-next-line @stylistic/js/max-len
const wasmBase64 = '${wasmBase64}';

let wasmBuffer;

module.exports = function getLLHTTPWasm() {
  return wasmBuffer ??= Buffer.from(wasmBase64, 'base64');
};
`);
}

const fromWasm = process.argv.find((arg) => arg.startsWith('--from-wasm='));
if (fromWasm !== undefined) {
  writeWasmModule(readFileSync(resolve(fromWasm.slice('--from-wasm='.length))));
  process.exit(0);
}

if (process.argv.includes('--docker')) {
  const tmp = mkdtempSync(join(tmpdir(), 'node-web-http-llhttp-'));
  const wasm = join(tmp, 'llhttp.wasm');

  try {
    execFileSync('docker', [
      'run',
      '--rm',
      '--mount',
      `type=bind,source=${WASM_SRC},target=/src,readonly`,
      '--mount',
      `type=bind,source=${tmp},target=/out`,
      '-w',
      '/out',
      WASM_BUILDER_CONTAINER,
      'sh',
      '-lc',
      [
        'clang',
        ...WASM_CFLAGS,
        ...WASM_LDFLAGS,
        '/src/src/api.c',
        '/src/src/http.c',
        '/src/src/llhttp.c',
        '-I',
        '/src/include',
        '-o',
        '/out/llhttp.wasm',
        '&&',
        'if command -v wasm-opt >/dev/null 2>&1; then',
        'wasm-opt',
        ...WASM_OPT_FLAGS,
        '-o',
        '/out/llhttp.wasm',
        '/out/llhttp.wasm;',
        'fi',
      ].join(' '),
    ], { stdio: 'inherit' });

    writeWasmModule(readFileSync(wasm));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.exit(0);
}

if (process.argv.includes('--docker-full-repo')) {
  execFileSync('docker', [
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${ROOT},target=/home/node/node`,
    '-w',
    '/home/node/node',
    WASM_BUILDER_CONTAINER,
    'node',
    'tools/update-web-http-llhttp-wasm.mjs',
  ], { stdio: 'inherit' });
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'node-web-http-llhttp-'));
const wasm = join(tmp, 'llhttp.wasm');

try {
  execFileSync(WASM_CC, [
    ...WASM_CFLAGS,
    ...WASM_LDFLAGS,
    join(WASM_SRC, 'src/api.c'),
    join(WASM_SRC, 'src/http.c'),
    join(WASM_SRC, 'src/llhttp.c'),
    '-I',
    join(WASM_SRC, 'include'),
    '-o',
    wasm,
  ], { stdio: 'inherit' });

  try {
    execFileSync(WASM_OPT, [
      ...WASM_OPT_FLAGS,
      '-o',
      wasm,
      wasm,
    ], { stdio: 'inherit' });
  } catch {
    // wasm-opt is optional; clang's output is still valid.
  }

  writeWasmModule(readFileSync(wasm));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
