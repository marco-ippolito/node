'use strict';

const { createServer } = require('node:http/web');

const fixed = 'C'.repeat(20 * 1024);
const storedBytes = Object.create(null);
const storedBuffer = Object.create(null);

function pathnameFromURL(url) {
  const scheme = url.indexOf('://');
  if (scheme === -1) {
    return url;
  }
  const pathStart = url.indexOf('/', scheme + 3);
  return pathStart === -1 ? '/' : url.slice(pathStart);
}

function chunkBody(body, chunks) {
  if (chunks <= 1) {
    return body;
  }

  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const step = Math.floor(buffer.length / chunks) || 1;
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < chunks - 1; i++) {
        controller.enqueue(buffer.subarray(i * step, i * step + step));
      }
      controller.enqueue(buffer.subarray((chunks - 1) * step));
      controller.close();
    },
  });
}

module.exports = createServer((ctx) => {
  const { request } = ctx;
  // Keep this fixture close to benchmark/fixtures/simple-http-server.js. This
  // benchmark is intended to measure the server path, not WHATWG URL parsing.
  const params = pathnameFromURL(request.url).split('/');
  const command = params[1];
  const arg = params[2];
  const chunks = Number.parseInt(params[3], 10);
  const resHow = params.length >= 5 ? params[4] : 'normal';
  const chunkedEnc = !(params.length >= 6 && params[5] === '0');
  let body = '';
  let status = 200;

  if (command === 'bytes') {
    const n = arg | 0;
    if (storedBytes[n] === undefined) {
      storedBytes[n] = 'C'.repeat(n);
    }
    body = storedBytes[n];
  } else if (command === 'buffer') {
    const n = arg | 0;
    if (storedBuffer[n] === undefined) {
      storedBuffer[n] = Buffer.allocUnsafe(n).fill('C');
    }
    body = storedBuffer[n];
  } else if (command === 'fixed') {
    body = fixed;
  } else if (command === 'echo') {
    return new Response(request.body, {
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  } else {
    status = 404;
    body = 'not found\n';
  }

  const headers = {
    __proto__: null,
    'Content-Type': 'text/plain',
  };
  if (!chunkedEnc) {
    headers['Content-Length'] = body.length.toString();
  }

  if (resHow === 'setHeader' || resHow === 'setHeaderWH') {
    headers['X-Response-Mode'] = resHow;
  }

  return new Response(chunkBody(body, chunks), {
    status,
    headers,
  });
});
