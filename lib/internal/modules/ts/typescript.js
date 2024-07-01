'use strict';
const { transformSync } = require('internal/deps/swc/wasm-web');

let DECODER;
function stringify(body) {
  if (typeof body === 'string') { return body; }
  const { TextDecoder } = require('internal/encoding');
  DECODER ??= new TextDecoder();
  return DECODER.decode(body);
}

async function load(url, context, nextLoad) {
  const isTS = context.format === 'typescript';
  if (isTS) { context = { __proto__: context, format: 'module' }; }
  const next = await nextLoad(url, context);
  if (isTS) {
    const { code } = transformSync(stringify(next.source), {
      swcrc: false,
      jsc: {
        parser: {
          syntax: 'typescript',
        },
        target: 'esnext',
      },
    });
    return {
      __proto__: null,
      format: 'module',
      source: code,
    };
  }
  return next;
}

module.exports = { load };
