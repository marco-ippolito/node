'use strict';

// Server-bound throughput benchmark for node:http/web hijack mode vs legacy
// node:http. A single keep-alive connection pipelines a large batch of
// requests, so the measurement is dominated by server-side parse + dispatch +
// response work rather than client/loopback/syscall overhead (which masks
// server differences in connection-per-request benchmarkers).
//
// Run:
//   NODE_BENCHMARK_FLAGS=--experimental-web-http-server \
//     node --experimental-web-http-server benchmark/http/web-server-pipeline.js

const common = require('../common.js');
const net = require('net');

const bench = common.createBenchmark(main, {
  mode: ['legacy', 'hijack', 'web-response'],
  len: [0, 256, 4096],
  n: [100000],
}, { flags: ['--experimental-web-http-server', '--no-warnings'] });

function main({ mode, len, n }) {
  const body = 'x'.repeat(len);

  if (mode === 'legacy') {
    const http = require('http');
    const server = http.createServer((req, res) => { res.end(body); });
    server.listen(0, () => run(server.address().port, () => {
      server.close();
    }));
    return;
  }

  const { createServer } = require('node:http/web');
  let server;
  if (mode === 'hijack') {
    server = createServer((ctx) => {
      const h = ctx.hijack();
      h.writeHead(200);
      h.end(body);
    });
  } else {
    server = createServer(() =>
      new Response(body, { headers: [['content-length', len]] }));
  }
  server.listen(0).then(() => run(server.address().port, () => {
    server.close();
  }));

  function run(port, done) {
    const req = 'GET / HTTP/1.1\r\nHost: x\r\n\r\n';
    const marker = Buffer.from('HTTP/1.1 2');
    const sock = net.connect({ port, host: '127.0.0.1' });
    let responses = 0;
    let tail = Buffer.alloc(0);
    let sent = 0;
    const batch = req.repeat(1000);

    sock.on('connect', () => {
      sock.setNoDelay(true);
      bench.start();
      pump();
    });

    sock.on('data', (d) => {
      // Count status-line markers across the byte stream.
      const hay = tail.length !== 0 ? Buffer.concat([tail, d]) : d;
      let from = 0;
      let idx;
      while ((idx = hay.indexOf(marker, from)) !== -1) {
        responses++;
        from = idx + marker.length;
        if (responses >= n) {
          bench.end(n);
          sock.destroy();
          done();
          return;
        }
      }
      tail = hay.subarray(Math.max(from, hay.length - (marker.length - 1)));
    });

    function pump() {
      while (sent < n) {
        const count = Math.min(1000, n - sent);
        sent += count;
        const chunk = count === 1000 ? batch : req.repeat(count);
        if (!sock.write(chunk)) {
          sock.once('drain', pump);
          return;
        }
      }
    }
  }
}
