'use strict';

const common = require('../common');

const bench = common.createBenchmark(main, {
  // Matches benchmark/http/bench-parser.js. Run both files with the same
  // configuration to compare the legacy parser and Web HTTP parser wrapper.
  len: [4, 8, 16, 32],
  n: [1e5],
}, {
  flags: ['--expose-internals', '--no-warnings'],
});

function createWebParser() {
  const { HTTP1RequestParser } = require('internal/http/llhttp_parser');
  return new HTTP1RequestParser({
    __proto__: null,
    bodyLimit: 1024 * 1024,
    maxHeaderSize: 1024 * 1024,
    onRequest() {},
    onRequestComplete() {},
  });
}

function main({ len, n }) {
  const parser = createWebParser();
  let header = 'GET /hello HTTP/1.1\r\nContent-Type: text/plain\r\n';

  for (let i = 0; i < len; i++) {
    header += `X-Filler${i}: ${Math.random().toString(36).substring(2)}\r\n`;
  }
  header += '\r\n';

  const request = Buffer.from(header);

  bench.start();
  for (let i = 0; i < n; i++) {
    parser.execute(request);
    parser.reset();
  }
  bench.end(n);

  parser.close();
}
