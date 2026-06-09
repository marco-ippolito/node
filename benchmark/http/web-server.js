'use strict';
// Benchmark comparing node:http/web (hijack and Web Response paths) against
// legacy node:http for simple fixed-body responses.
//
// Run:
//   NODE_BENCHMARK_FLAGS=--experimental-web-http-server \
//     node --experimental-web-http-server benchmark/http/web-server.js
//
// Modes:
//   legacy           - node:http createServer, no explicit content-length
//   hijack           - ctx.hijack(), content-length pre-set via writeHead
//   hijack-autosize  - ctx.hijack(), server computes content-length from body
//   web-response     - ctx returns Response with explicit content-length
const common = require('../common.js');

const bench = common.createBenchmark(main, {
  mode: ['legacy', 'hijack', 'hijack-autosize', 'web-response'],
  c: [50, 500],
  len: [0, 256, 4096],
  duration: [5],
});

function main({ mode, c, len, duration }) {
  const bodyStr = 'x'.repeat(len);
  const bodyLen = Buffer.byteLength(bodyStr);

  if (mode === 'legacy') {
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.end(bodyStr);
    });
    server.listen(0, () => {
      bench.http({
        path: '/',
        connections: c,
        duration,
        port: server.address().port,
      }, () => server.close());
    });
    return;
  }

  // node:http/web modes — requires --experimental-web-http-server.
  const { createServer } = require('node:http/web');
  let server;

  if (mode === 'hijack') {
    // Pre-set content-length via writeHead; uses the regular head+body writev.
    const clHeader = ['content-length', bodyLen];
    server = createServer((ctx) => {
      const h = ctx.hijack();
      h.writeHead(200, [clHeader]);
      h.end(bodyStr);
    });
  } else if (mode === 'hijack-autosize') {
    // Let the server compute content-length: exercises the fast path that
    // combines response head + string body into one Buffer.from() call.
    server = createServer((ctx) => {
      const h = ctx.hijack();
      h.writeHead(200);
      h.end(bodyStr);
    });
  } else {
    // mode === 'web-response'
    server = createServer(() =>
      new Response(bodyStr, {
        headers: [['content-length', bodyLen]],
      }));
  }

  server.listen(0).then(() => {
    bench.http({
      path: '/',
      connections: c,
      duration,
      port: server.address().port,
    }, () => server.close());
  });
}
