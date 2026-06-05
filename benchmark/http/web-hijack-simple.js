'use strict';

const common = require('../common.js');

const bench = common.createBenchmark(main, {
  // Matches benchmark/http/simple.js while exercising the low-level hijack
  // writer instead of the high-level Web Request/Response path.
  type: ['bytes', 'buffer'],
  len: [4, 1024, 102400],
  chunks: [1, 4],
  c: [50, 500],
  chunkedEnc: [1, 0],
  duration: 5,
}, {
  flags: ['--experimental-web-http-server', '--no-warnings'],
});

function main({ type, len, chunks, c, chunkedEnc, duration }) {
  const server = require('../fixtures/simple-web-http-hijack-server.js');

  server.listen(0).then(() => {
    const path = `/${type}/${len}/${chunks}/normal/${chunkedEnc}`;

    bench.http({
      path,
      connections: c,
      duration,
      port: server.address().port,
    }, () => {
      server.close();
    });
  });
}
