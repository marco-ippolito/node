// Flags: --experimental-web-http-server --no-warnings

import {
  mustCall,
  mustNotCall,
  platformTimeout,
  spawnPromisified,
} from '../common/index.mjs';
import assert from 'node:assert';
import { once } from 'node:events';
import { builtinModules } from 'node:module';
import net from 'node:net';
import test from 'node:test';
import {
  setImmediate,
  setTimeout as sleep,
} from 'node:timers/promises';
import { createServer } from 'node:http/web';

// Consume a hijack().body async iterable into one Buffer, exercising the plain
// `for await` consumption path.
async function collectBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function countResponses(data) {
  return (data.match(/HTTP\/1\.1 /g) ?? []).length;
}

async function rawRequestChunks(port, payloads, responses = 1) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const chunks = [];
  const errors = [];
  const payload = payloads.join('');
  let data = '';
  socket.setTimeout(platformTimeout(2000), () => {
    socket.destroy(new Error('Timed out waiting for raw HTTP response'));
  });
  socket.on('error', (err) => {
    errors.push(err);
  });
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    data = Buffer.concat(chunks).toString('latin1');
    if (countResponses(data) >= responses &&
        payload.includes('Connection: close')) {
      socket.end();
    }
  });
  await once(socket, 'connect');
  for (let i = 0; i < payloads.length; i++) {
    socket.write(payloads[i], 'latin1');
    await setImmediate();
  }
  await once(socket, 'close');
  if (errors.length !== 0) throw errors[0];
  return Buffer.concat(chunks).toString('latin1');
}

async function rawRequest(port, payload, responses = 1) {
  return rawRequestChunks(port, [payload], responses);
}

async function rawSequentialRequests(port, first, second) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const chunks = [];
  let data = '';
  let sentSecond = false;
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    data = Buffer.concat(chunks).toString('latin1');
    const seen = countResponses(data);
    if (seen === 1 && !sentSecond) {
      sentSecond = true;
      socket.write(second);
    } else if (seen >= 2) {
      socket.end();
    }
  });
  await once(socket, 'connect');
  socket.write(first);
  await once(socket, 'close');
  return Buffer.concat(chunks).toString('latin1');
}

function responseComplete(data) {
  const headerEnd = data.indexOf('\r\n\r\n');
  if (headerEnd === -1) return false;
  const head = data.slice(0, headerEnd);
  const match = /\r\ncontent-length:\s*(\d+)/i.exec(head);
  if (match === null) return true;
  return data.length >= headerEnd + 4 + Number(match[1]);
}

async function readOneResponse(port, payload) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const chunks = [];
  const errors = [];
  let data = '';
  socket.on('error', (err) => {
    errors.push(err);
  });
  const response = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      data = Buffer.concat(chunks).toString('latin1');
      if (responseComplete(data)) {
        resolve(data);
        socket.end();
      }
    });
  });
  await once(socket, 'connect');
  socket.write(payload);
  const timeout = sleep(platformTimeout(2000)).then(() => {
    socket.destroy();
    throw new Error('Timed out waiting for one HTTP response');
  });
  const result = await Promise.race([response, timeout]);
  await once(socket, 'close');
  if (errors.length !== 0) throw errors[0];
  return result;
}

test('node:http/web is gated behind --experimental-web-http-server', async () => {
  {
    const { code, stderr } = await spawnPromisified(process.execPath, [
      '-e',
      'require("node:http/web")',
    ]);
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /No such built-in module: node:http\/web/);
  }

  {
    const { code, stdout } = await spawnPromisified(process.execPath, [
      '--experimental-web-http-server',
      '--no-warnings',
      '-e',
      'const { builtinModules } = require("node:module"); ' +
        'console.log(builtinModules.includes("node:http/web")); ' +
        'require("node:http/web");',
    ]);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout.trim(), 'true');
  }
});

test('createServer returns a Web Response (fixed body with content-length)', async () => {
  const server = createServer(() => new Response('hello', {
    headers: [['content-length', '5']],
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /content-length: 5/i);
    assert.match(response, /hello$/);
  } finally {
    await server.close();
  }
});

test('createServer streams a ReadableStream Web Response body with chunked encoding', async () => {
  // Undici auto-adds content-length for string/buffer bodies; use a genuine
  // ReadableStream to exercise the chunked streaming code path.
  const encoder = new TextEncoder();
  const server = createServer(() => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('hello'));
        controller.close();
      },
    });
    return new Response(stream);
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /transfer-encoding: chunked/i);
    assert.doesNotMatch(response, /content-length/i);
    assert.match(response, /hello/);
    assert.ok(response.includes('0\r\n\r\n'));
  } finally {
    await server.close();
  }
});

test('hijack exposes metadata and writev', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.strictEqual(h.method, 'GET');
    assert.strictEqual(h.url, '/hijack');
    assert.deepStrictEqual(h.headers[0], ['Host', 'example.test']);
    h.writeHead(201, [['x-web-http', 'yes']]);
    h.writev([Buffer.from('a'), Buffer.from('b')]);
    const data = Buffer.from('c');
    h.write(new DataView(data.buffer, data.byteOffset, data.byteLength));
    h.end();
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET /hijack HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 201 Created/);
    assert.match(response, /x-web-http: yes/i);
    assert.match(response, /abc$/);
  } finally {
    await server.close();
  }
});

test('hijack writeHead validates response headers', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.throws(
      () => h.writeHead(200, [['bad name', 'no']]),
      { code: 'ERR_INVALID_HTTP_TOKEN' });
    assert.throws(
      () => h.writeHead(200, [['x-web-http', { valueOf() { return 'no'; } }]]),
      { code: 'ERR_INVALID_ARG_TYPE' });
    h.writeHead(200, [['content-length', 2]]);
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET /headers HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Connection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /content-length: 2/i);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('legacy test-http-write-head*: hijack accepts flat raw header arrays', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.throws(
      () => h.writeHead(200, ['invalid', 'headers', 'args']),
      { code: 'ERR_INVALID_ARG_VALUE' });
    h.writeHead(220, [
      'test', '1',
      'set-cookie', 'a',
      'set-cookie', 'b',
    ]);
    assert.throws(
      () => h.writeHead(200, ['test2', '2']),
      { code: 'ERR_INVALID_STATE' });
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET /write-head HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 220 /);
    assert.match(response, /\r\ntest: 1\r\n/i);
    assert.strictEqual((response.match(/\r\nset-cookie: /gi) ?? []).length, 2);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('legacy test-http-header-validators: response header checks match strict mode', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.throws(
      () => h.writeHead(200, [[':', 'bad']]),
      { code: 'ERR_INVALID_HTTP_TOKEN' });
    assert.throws(
      () => h.writeHead(200, [['x-bad', 'bad\rvalue']]),
      { code: 'ERR_INVALID_CHAR' });
    assert.throws(
      () => h.writeHead(200, [['x-bad', '中文呢']]),
      { code: 'ERR_INVALID_CHAR' });
    h.writeHead(200, [
      ['TCN', 'ok'],
      ['foo`bar^', 'ok'],
      ['x-tab', 'foo\tbar'],
      ['x-obs', '\x80\x81\xff'],
    ]);
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET /header-validators HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /\r\nfoo`bar\^: ok\r\n/);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('legacy response writer state and status validation', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.throws(
      () => h.writeHead(99),
      { code: 'ERR_HTTP_INVALID_STATUS_CODE' });
    h.write('');
    h.write(Buffer.alloc(0));
    h.end('done');
    assert.throws(
      () => h.write('again'),
      { code: 'ERR_INVALID_STATE' });
    assert.throws(
      () => h.end(),
      { code: 'ERR_INVALID_STATE' });
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET /writer-state HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /content-length: 4/i);
    assert.match(response, /done$/);
  } finally {
    await server.close();
  }
});

test('hijack adds content-length for buffered keep-alive responses', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await readOneResponse(
      port,
      'GET /framed HTTP/1.1\r\nHost: example.test\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /content-length: 2/i);
    assert.doesNotMatch(response, /Connection: close/i);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('hijack body resolves the whole body via bytes()', async () => {
  const server = createServer(async (ctx) => {
    const h = ctx.hijack();
    const body = await h.body.bytes();
    h.writeHead(200, [['content-length', body.byteLength]]);
    h.end(body);
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'POST /echo HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Content-Length: 4\r\n' +
        'Connection: close\r\n\r\n' +
        'pong');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /pong$/);
  } finally {
    await server.close();
  }
});

test('hijack body is an async iterable of Uint8Array chunks', async () => {
  const server = createServer(mustCall(async (ctx) => {
    const h = ctx.hijack();
    const chunks = [];
    for await (const chunk of h.body) {
      assert.ok(chunk instanceof Uint8Array);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    h.writeHead(200, [['content-length', body.byteLength]]);
    h.end(body);
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'POST /echo HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Content-Length: 4\r\n' +
        'Connection: close\r\n\r\n' +
        'pong');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /pong$/);
  } finally {
    await server.close();
  }
});

test('hijack body throws if consumed twice', async () => {
  const server = createServer(mustCall(async (ctx) => {
    const h = ctx.hijack();
    await h.body.bytes();
    await assert.rejects(h.body.bytes(), { code: 'ERR_INVALID_STATE' });
    h.writeHead(200, [['content-length', '2']]);
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();
    const response = await rawRequest(
      port,
      'POST / HTTP/1.1\r\nHost: example.test\r\n' +
        'Content-Length: 4\r\nConnection: close\r\n\r\nbody');
    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('hijack body supports chunked request bodies', async () => {
  const server = createServer(async (ctx) => {
    const h = ctx.hijack();
    const body = await collectBody(h.body);
    h.writeHead(200, [['content-length', body.byteLength]]);
    h.end(body);
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'POST /chunked HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        'Connection: close\r\n\r\n' +
        '2\r\npo\r\n2\r\nng\r\n0\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /pong$/);
  } finally {
    await server.close();
  }
});

test('legacy test-http-chunked*: chunk extensions parse and trailers reject', async () => {
  {
    const server = createServer(async (ctx) => {
      const h = ctx.hijack();
      const body = await collectBody(h.body);
      h.writeHead(200, [['content-length', body.byteLength]]);
      h.end(body);
    });
    try {
      await server.listen(0);
      const { port } = server.address();

      const response = await rawRequest(
        port,
        'POST /chunk-extension HTTP/1.1\r\n' +
          'Host: example.test\r\n' +
          'Transfer-Encoding: chunked\r\n' +
          'Connection: close\r\n\r\n' +
          '1;foo=bar\r\nA\r\n1;answer=42\r\nB\r\n0\r\n\r\n');

      assert.match(response, /^HTTP\/1\.1 200 OK/);
      assert.match(response, /AB$/);
    } finally {
      await server.close();
    }
  }

  {
    const server = createServer(mustNotCall());
    try {
      await server.listen(0);
      const { port } = server.address();

      const response = await rawRequest(
        port,
        'POST /trailers HTTP/1.1\r\n' +
          'Host: example.test\r\n' +
          'Transfer-Encoding: chunked\r\n' +
          'Connection: close\r\n\r\n' +
          '1\r\nA\r\n0\r\nX-Trailer: yes\r\n\r\n');

      assert.match(response, /^HTTP\/1\.1 501 Not Implemented/);
    } finally {
      await server.close();
    }
  }
});

test('ctx.request.body exposes the request body as a Web ReadableStream', async () => {
  const server = createServer(mustCall(async (ctx) => {
    // ctx.request is a Web Request; .body is a ReadableStream<Uint8Array>.
    const reader = ctx.request.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      assert.ok(value instanceof Uint8Array);
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    return new Response(body, {
      headers: [['content-length', body.byteLength]],
    });
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'POST /echo HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Content-Length: 4\r\n' +
        'Connection: close\r\n\r\n' +
        'pong');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /pong$/);
  } finally {
    await server.close();
  }
});

test('ctx.request.text() reads the request body one-shot', async () => {
  const server = createServer(async (ctx) => {
    const text = await ctx.request.text();
    return new Response(text, {
      headers: [['content-length', Buffer.byteLength(text)]],
    });
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'POST /echo HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Content-Length: 5\r\n' +
        'Connection: close\r\n\r\n' +
        'hello');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /hello$/);
  } finally {
    await server.close();
  }
});

test('hijack body survives fragmented header tokens', async () => {
  const server = createServer(async (ctx) => {
    const h = ctx.hijack();
    const body = await collectBody(h.body);
    h.writeHead(200, [['content-length', body.byteLength]]);
    h.end(body);
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequestChunks(port, [
      'POST /fragmented-body HTTP/1.1\r\nHost: example.test\r\nContent-Len',
      'gth: 4\r\nConnection: close\r\n\r\npong',
    ]);

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /pong$/);
  } finally {
    await server.close();
  }
});

test('milo parser preserves fragmented header spans', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.strictEqual(h.url, '/split');
    assert.deepStrictEqual(h.headers[0], ['Host', 'example.test']);
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequestChunks(port, [
      'GET /split HTTP/1.1\r\nHo',
      'st: example.test\r\nConnection: close\r\n\r\n',
    ]);

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('milo parser trims header OWS and preserves blank header values', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.deepStrictEqual(h.headers, [
      ['Host', 'example.test'],
      ['Cookie', ''],
      ['Connection', 'close'],
    ]);
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequestChunks(port, [
      'GET /ows HTTP/1.1\r\nHost:\t ',
      'example.test \t\r\nCookie:\r\nConnection: close\r\n\r\n',
    ]);

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('legacy request headers: raw order, duplicates, OWS, and obs-text', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    assert.deepStrictEqual(h.headers, [
      ['Host', 'example.test'],
      ['Cookie', ''],
      ['X-Obs', 'Düsseldorf'],
      ['X-Dup', 'one'],
      ['x-dup', 'two'],
      ['Connection', 'close'],
    ]);
    assert.strictEqual(ctx.request.headers.get('cookie'), '');
    assert.strictEqual(ctx.request.headers.get('x-obs'), 'Düsseldorf');
    assert.strictEqual(ctx.request.headers.get('x-dup'), 'one, two');
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequestChunks(port, [
      'GET /legacy-headers HTTP/1.1\r\nHo',
      'st:\t example.test \t\r\n' +
        'Cookie:\r\n' +
        'X-Obs: Düsseldorf\r\n' +
        'X-Dup: one\r\n' +
        'x-dup: two\r\n' +
        'Connection: close\r\n\r\n',
    ]);

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('milo parser rejects malformed requests before handler dispatch', async () => {
  const server = createServer(mustNotCall());
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET / HTTP/1.0\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
  } finally {
    await server.close();
  }
});

test('milo parser rejects malformed header and host cases', async () => {
  const cases = [
    'GET / HTTP/1.1\r\nConnection: close\r\n\r\n',
    'GET / HTTP/1.1\r\n' +
      'Host: example.test\r\nContent-Length : 5\r\nConnection: close\r\n\r\n' +
      'hello',
    'GET / HTTP/1.1\r\n' +
      'Host: example.test\r\nDummy: x\rContent-Length: 23\r\n\r\n',
    'GET / HTTP/1.1\r\n' +
      'Host: example.test\r\nDummy: x\nContent-Length: 23\r\n\r\n',
    'POST / HTTP/1.1\r\n' +
      'Host: example.test\r\nx:x\rTransfer-Encoding: chunked\r\n\r\n' +
      '1\r\nA\r\n0\r\n\r\n',
    'POST / HTTP/1.1\r\n' +
      'Host: example.test\r\nx:x\nTransfer-Encoding: chunked\r\n\r\n' +
      '1\r\nA\r\n0\r\n\r\n',
  ];
  const server = createServer(mustNotCall());
  try {
    await server.listen(0);
    const { port } = server.address();

    for (let i = 0; i < cases.length; i++) {
      const response = await rawRequest(port, cases[i]);
      assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    }
  } finally {
    await server.close();
  }
});

test('milo parser rejects duplicate Host, Upgrade, and bad expectations', async () => {
  const cases = [
    [
      'GET / HTTP/1.1\r\n' +
        'Host: a.example\r\nHost: b.example\r\nConnection: close\r\n\r\n',
      /^HTTP\/1\.1 400 Bad Request/,
    ],
    [
      'GET / HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: close\r\n\r\n',
      /^HTTP\/1\.1 501 Not Implemented/,
    ],
    [
      // An unsupported expectation is answered with 417, not 501.
      'POST / HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Expect: payment-required\r\n' +
        'Content-Length: 1\r\n' +
        'Connection: close\r\n\r\nA',
      /^HTTP\/1\.1 417 Expectation Failed/,
    ],
  ];
  const server = createServer(mustNotCall());
  try {
    await server.listen(0);
    const { port } = server.address();

    for (let i = 0; i < cases.length; i++) {
      const { 0: payload, 1: expected } = cases[i];
      const response = await rawRequest(port, payload);
      assert.match(response, expected);
    }
  } finally {
    await server.close();
  }
});

test('Expect: 100-continue is honored (body sent with headers)', async () => {
  const server = createServer(mustCall(async (ctx) => {
    const h = ctx.hijack();
    const body = await h.body.bytes();
    h.writeHead(200, [['content-length', body.byteLength]]);
    h.end(body);
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    // Client sends the body together with the headers; the server should still
    // accept it and respond (a 100 may be omitted since the body is present).
    const response = await rawRequest(
      port,
      'POST /echo HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Expect: 100-continue\r\n' +
        'Content-Length: 4\r\n' +
        'Connection: close\r\n\r\npong');

    assert.match(response, /^HTTP\/1\.1 (?:100 Continue\r\n\r\nHTTP\/1\.1 )?200 OK/);
    assert.match(response, /pong$/);
  } finally {
    await server.close();
  }
});

test('Expect: 100-continue sends interim 100 to a waiting client', async () => {
  const server = createServer(mustCall(async (ctx) => {
    const h = ctx.hijack();
    const body = await h.body.bytes();
    h.writeHead(200, [['content-length', body.byteLength]]);
    h.end(body);
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const socket = net.connect({ port, host: '127.0.0.1' });
    const chunks = [];
    socket.setTimeout(platformTimeout(2000), () => {
      socket.destroy(new Error('Timed out waiting for 100-continue'));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    await once(socket, 'connect');

    // Send only the headers and wait for the interim 100 before the body.
    socket.write(
      'POST /echo HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Expect: 100-continue\r\n' +
        'Content-Length: 4\r\n' +
        'Connection: close\r\n\r\n');

    await new Promise((resolve) => {
      const check = () => {
        if (Buffer.concat(chunks).toString('latin1').includes('100 Continue')) {
          resolve();
        } else {
          socket.once('data', check);
        }
      };
      check();
    });

    // Interim 100 received; now send the body.
    socket.write('pong');
    await once(socket, 'close');

    const response = Buffer.concat(chunks).toString('latin1');
    assert.match(response, /^HTTP\/1\.1 100 Continue\r\n\r\n/);
    assert.match(response, /HTTP\/1\.1 200 OK/);
    assert.match(response, /pong$/);
  } finally {
    await server.close();
  }
});

test('maxHeaderSize rejects oversized request headers', async () => {
  const server = createServer(mustNotCall(), { maxHeaderSize: 80 });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET / HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        `X-Large: ${'A'.repeat(80)}\r\n` +
        'Connection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 431 Request Header Fields Too Large/);

    const fragmented = await rawRequestChunks(port, [
      'GET / HTTP/1.1\r\nHost: example.test\r\nX-Large: ',
      `${'A'.repeat(80)}\r\nConnection: close\r\n\r\n`,
    ]);

    assert.match(fragmented, /^HTTP\/1\.1 431 Request Header Fields Too Large/);
  } finally {
    await server.close();
  }
});

test('milo parser rejects request smuggling length and transfer cases', async () => {
  const cases = [
    'POST / HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Content-Length: 1\r\n' +
      'Content-Length: 2\r\n' +
      'Connection: close\r\n\r\nA',
    'POST / HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Content-Length: 1\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      'Connection: close\r\n\r\n1\r\nA\r\n0\r\n\r\n',
    'POST / HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      'Transfer-Encoding: chunked-false\r\n' +
      'Connection: close\r\n\r\n1\r\nA\r\n0\r\n\r\n',
    'POST / HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Transfer-Encoding: gzip\r\n' +
      'Connection: close\r\n\r\nabc',
    'POST / HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Content-Length: 10\r\n' +
      'Transfer-Encoding: eee, chunked\r\n' +
      'Connection: close\r\n\r\nHELLOWORLD',
  ];
  const server = createServer(mustNotCall());
  try {
    await server.listen(0);
    const { port } = server.address();

    for (let i = 0; i < cases.length; i++) {
      const response = await rawRequest(port, cases[i]);
      assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    }
  } finally {
    await server.close();
  }
});

test('request body limit rejects fixed and chunked bodies', async () => {
  const cases = [
    'POST /fixed HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Content-Length: 3\r\n' +
      'Connection: close\r\n\r\nabc',
    'POST /chunked HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      'Connection: close\r\n\r\n2\r\nab\r\n1\r\nc\r\n0\r\n\r\n',
  ];
  const server = createServer(mustNotCall(), { bodyLimit: 2 });
  try {
    await server.listen(0);
    const { port } = server.address();

    for (let i = 0; i < cases.length; i++) {
      const response = await rawRequest(port, cases[i]);
      assert.match(response, /^HTTP\/1\.1 413 Payload Too Large/);
    }
  } finally {
    await server.close();
  }
});

test('Web Response omits bodies for HEAD and no-body statuses', async () => {
  const server = createServer((ctx) => {
    if (ctx.request.method === 'HEAD') {
      return new Response('hidden', {
        headers: [['content-length', 6]],
      });
    }
    if (ctx.request.url.endsWith('/204')) {
      return new Response(null, { status: 204 });
    }
    return new Response(null, {
      status: 304,
      headers: [['content-length', 11]],
    });
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const head = await rawRequest(
      port,
      'HEAD /head HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');
    assert.match(head, /^HTTP\/1\.1 200 OK/);
    assert.match(head, /content-length: 6/i);
    assert.doesNotMatch(head, /hidden$/);

    const noContent = await rawRequest(
      port,
      'GET /204 HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');
    assert.match(noContent, /^HTTP\/1\.1 204 No Content/);

    const notModified = await rawRequest(
      port,
      'GET /304 HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');
    assert.match(notModified, /^HTTP\/1\.1 304 Not Modified/);
    assert.match(notModified, /content-length: 11/i);
  } finally {
    await server.close();
  }
});

test('Web Response serializes default and custom status text', async () => {
  const server = createServer((ctx) => {
    if (ctx.request.url.endsWith('/custom')) {
      return new Response('custom', {
        status: 202,
        statusText: 'Custom Accepted',
      });
    }
    return new Response('default', { status: 202 });
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const defaultStatus = await rawRequest(
      port,
      'GET /default HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');
    assert.match(defaultStatus, /^HTTP\/1\.1 202 Accepted/);

    const customStatus = await rawRequest(
      port,
      'GET /custom HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');
    assert.match(customStatus, /^HTTP\/1\.1 202 Custom Accepted/);
  } finally {
    await server.close();
  }
});

test('handler errors send 500, close, and surface via uncaughtException', async () => {
  // A handler that throws gets the client a 500 + close, and the error is
  // surfaced through process.on('uncaughtException') rather than swallowed.
  // Run in a child so the uncaught error does not fail the test runner; the
  // child installs a handler so the process survives and the 500 can be read.
  const child = `
    const { createServer } = require('node:http/web');
    const net = require('node:net');
    const caught = [];
    process.on('uncaughtException', (err) => caught.push(err.message));
    const server = createServer(() => { throw new Error('boom'); });
    server.listen(0).then(() => {
      const { port } = server.address();
      const sock = net.connect({ port });
      let data = '';
      sock.on('data', (c) => { data += c.toString('latin1'); });
      sock.on('close', () => {
        console.log(JSON.stringify({ head: data.split('\\r\\n')[0],
          close: /connection: close/i.test(data), caught }));
        server.close();
      });
      sock.write('GET /error HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n');
    });
  `;
  const { code, stdout, stderr } = await spawnPromisified(process.execPath, [
    '--experimental-web-http-server', '--no-warnings', '-e', child,
  ]);
  assert.strictEqual(code, 0, `child exited ${code}: ${stderr}`);
  const result = JSON.parse(stdout.trim());
  assert.strictEqual(result.head, 'HTTP/1.1 500 Internal Server Error');
  assert.strictEqual(result.close, true);
  assert.deepStrictEqual(result.caught, ['boom']);
});

test('handler errors crash the process when uncaughtException is unhandled', async () => {
  // Without a process handler, the surfaced error is fatal and the stack is printed.
  const child = `
    const { createServer } = require('node:http/web');
    const net = require('node:net');
    const server = createServer(() => { throw new Error('boom'); });
    server.listen(0).then(() => {
      const { port } = server.address();
      net.connect({ port })
        .write('GET / HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n');
    });
  `;
  const { code, stderr } = await spawnPromisified(process.execPath, [
    '--experimental-web-http-server', '--no-warnings', '-e', child,
  ]);
  assert.notStrictEqual(code, 0);
  assert.match(stderr, /Error: boom/);
});

test('responses flush in request order for HTTP/1.1 pipelining', async () => {
  const server = createServer(mustCall((ctx) => {
    return new Response(ctx.request.url.endsWith('/one') ? 'one' : 'two');
  }, 2));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET /one HTTP/1.1\r\nHost: example.test\r\n\r\n' +
        'GET /two HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n',
      2);

    assert.strictEqual(
      (response.match(/HTTP\/1\.1 200 OK/g) ?? []).length, 2);
    assert.ok(response.indexOf('one') < response.indexOf('two'));
  } finally {
    await server.close();
  }
});

test('keep-alive handles sequential requests on one connection', async () => {
  const server = createServer(mustCall((ctx) => {
    return new Response(ctx.request.url.endsWith('/one') ? 'one' : 'two');
  }, 2));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawSequentialRequests(
      port,
      'GET /one HTTP/1.1\r\nHost: example.test\r\n\r\n',
      'GET /two HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.strictEqual(countResponses(response), 2);
    assert.ok(response.indexOf('one') < response.indexOf('two'));
  } finally {
    await server.close();
  }
});

test('timeouts cover headers, request bodies, and keep-alive idle', async () => {
  const timeout = platformTimeout(50);

  {
    const server = createServer(mustNotCall(), {
      headersTimeout: timeout,
      keepAliveTimeout: 0,
    });
    try {
      await server.listen(0);
      const { port } = server.address();
      const response = await rawRequest(port, 'GET / HTTP/1.1\r\nHo');
      assert.match(response, /^HTTP\/1\.1 408 Request Timeout/);
      assert.match(response, /Connection: close/i);
    } finally {
      await server.close();
    }
  }

  {
    const server = createServer(mustNotCall(), {
      requestTimeout: timeout,
      keepAliveTimeout: 0,
    });
    try {
      await server.listen(0);
      const { port } = server.address();
      const response = await rawRequest(
        port,
        'POST / HTTP/1.1\r\n' +
          'Host: example.test\r\n' +
          'Content-Length: 2\r\n\r\nA');
      assert.match(response, /^HTTP\/1\.1 408 Request Timeout/);
      assert.match(response, /Connection: close/i);
    } finally {
      await server.close();
    }
  }

  {
    const server = createServer(() => new Response('ok', {
      headers: [['content-length', '2']],
    }), {
      keepAliveTimeout: timeout,
    });
    try {
      await server.listen(0);
      const { port } = server.address();
      const socket = net.connect({ port, host: '127.0.0.1' });
      const chunks = [];
      const errors = [];
      socket.setTimeout(platformTimeout(2000), () => {
        socket.destroy(new Error('Timed out waiting for keep-alive close'));
      });
      socket.on('error', (err) => {
        errors.push(err);
      });
      socket.on('data', (chunk) => chunks.push(chunk));
      await once(socket, 'connect');
      socket.write('GET / HTTP/1.1\r\nHost: example.test\r\n\r\n');
      await once(socket, 'close');
      if (errors.length !== 0) throw errors[0];
      const response = Buffer.concat(chunks).toString('latin1');
      assert.match(response, /^HTTP\/1\.1 200 OK/);
      assert.match(response, /content-length: 2/i);
    } finally {
      await server.close();
    }
  }
});

test('server lifecycle mirrors applicable legacy listen behavior', async () => {
  const server = createServer(mustNotCall());
  assert.strictEqual(server.address(), null);
  await assert.rejects(server.listen(-1), {
    code: 'ERR_SOCKET_BAD_PORT',
  });
  await server.listen(0);
  assert.notStrictEqual(server.address(), null);
  await assert.rejects(server.listen(0), {
    code: 'ERR_INVALID_STATE',
  });
  await server.close();
  assert.strictEqual(server.address(), null);
  assert.strictEqual(server.close(), undefined);
});

test('server closes automatically with await using', async () => {
  let server;
  {
    await using disposable = createServer(mustNotCall());
    server = disposable;
    await server.listen(0);
    assert.notStrictEqual(server.address(), null);
  }

  assert.strictEqual(server.address(), null);
  assert.strictEqual(server.close(), undefined);
});

test('legacy test-http-server-timeouts-validation maps to constructor options', () => {
  assert.throws(
    () => createServer(mustNotCall(), { bodyLimit: -1 }),
    { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(
    () => createServer(mustNotCall(), { headersTimeout: -1 }),
    { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(
    () => createServer(mustNotCall(), { requestTimeout: 2 ** 31 }),
    { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(
    () => createServer(mustNotCall(), { keepAliveTimeout: 2 ** 31 }),
    { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(
    () => createServer(mustNotCall(), {
      headersTimeout: 2,
      requestTimeout: 1,
    }),
    { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(
    () => createServer(mustNotCall(), { maxHeaderSize: -1 }),
    { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(
    () => createServer(mustNotCall(), { maxInflightRequests: 0 }),
    { code: 'ERR_OUT_OF_RANGE' });
});

test('server.inject accepts Web Request and returns Web Response', async () => {
  const server = createServer(mustCall((ctx) => {
    assert.strictEqual(ctx.request.url, 'http://example.test/injected');
    return new Response(ctx.request.method);
  }));

  const response = await server.inject(
    new Request('http://example.test/injected'));
  assert.strictEqual(await response.text(), 'GET');

  await assert.rejects(server.inject({}), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
});

test('server.inject captures completed hijack responses', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    h.writeHead(202, [['x-injected', 'yes']]);
    h.end('ok');
  }));

  const response = await server.inject(
    new Request('http://example.test/hijack'));
  assert.strictEqual(response.status, 202);
  assert.strictEqual(response.headers.get('x-injected'), 'yes');
  assert.strictEqual(response.headers.get('content-length'), '2');
  assert.strictEqual(await response.text(), 'ok');

  const unterminated = createServer(mustCall((ctx) => {
    ctx.hijack();
  }));
  await assert.rejects(
    unterminated.inject(new Request('http://example.test/hijack')),
    { code: 'ERR_INVALID_STATE' });
});

test('streamed Web Response uses chunked encoding and sends body correctly', async () => {
  const encoder = new TextEncoder();
  const server = createServer(() => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('chunk1'));
        controller.enqueue(encoder.encode('chunk2'));
        controller.close();
      },
    });
    return new Response(stream);
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /transfer-encoding: chunked/i);
    assert.match(response, /chunk1/);
    assert.match(response, /chunk2/);
    assert.ok(response.includes('0\r\n\r\n'));
  } finally {
    await server.close();
  }
});

test('streamed Web Response preserves pipelining order', async () => {
  // Use a Promise-controlled stream so that the slow response can be released
  // from outside the handler after both requests are in flight.
  let releaseSlowBody;
  const slowBodyReady = new Promise((resolve) => { releaseSlowBody = resolve; });
  const encoder = new TextEncoder();

  const server = createServer(mustCall((ctx) => {
    if (ctx.request.url.endsWith('/slow')) {
      const stream = new ReadableStream({
        async start(controller) {
          await slowBodyReady;
          controller.enqueue(encoder.encode('slow'));
          controller.close();
        },
      });
      return new Response(stream);
    }
    return new Response('fast', { headers: [['content-length', '4']] });
  }, 2));
  try {
    await server.listen(0);
    const { port } = server.address();

    const socket = net.connect({ port, host: '127.0.0.1' });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    await once(socket, 'connect');

    socket.write(
      'GET /slow HTTP/1.1\r\nHost: example.test\r\n\r\n' +
        'GET /fast HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    // Give both handlers a chance to start before releasing the slow stream.
    await setImmediate();
    await setImmediate();
    releaseSlowBody();

    await once(socket, 'close');
    const response = Buffer.concat(chunks).toString('latin1');
    // 'slow' must appear before 'fast' despite slow being a stream.
    assert.ok(response.indexOf('slow') < response.indexOf('fast'));
  } finally {
    await server.close();
  }
});

test('hijack suppresses body bytes for HEAD requests', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    h.writeHead(200, [['content-length', 5]]);
    h.write('hello');
    h.end();
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'HEAD / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /content-length: 5/i);
    assert.doesNotMatch(response, /hello/);
  } finally {
    await server.close();
  }
});

test('hijack suppresses body bytes for 1xx and other no-body status codes', async () => {
  // Web Response cannot carry a 1xx status (Fetch spec forbids status < 200),
  // so use the hijack path to verify that the server correctly suppresses body
  // bytes for informational and other no-body statuses.
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    const url = ctx.request.url;
    if (url.endsWith('/100')) {
      h.writeHead(100);
      h.write('should-be-suppressed');
      h.end();
    } else if (url.endsWith('/204')) {
      h.writeHead(204);
      h.write('should-be-suppressed');
      h.end();
    } else {
      h.writeHead(200, [['content-length', '2']]);
      h.end('ok');
    }
  }, 3));
  try {
    await server.listen(0);
    const { port } = server.address();

    const r100 = await rawRequest(
      port,
      'GET /100 HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
    assert.match(r100, /^HTTP\/1\.1 100 Continue/);
    assert.doesNotMatch(r100, /should-be-suppressed/);

    const r204 = await rawRequest(
      port,
      'GET /204 HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
    assert.match(r204, /^HTTP\/1\.1 204 No Content/);
    assert.doesNotMatch(r204, /should-be-suppressed/);

    const rok = await rawRequest(
      port,
      'GET /ok HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
    assert.match(rok, /^HTTP\/1\.1 200 OK/);
    assert.match(rok, /ok$/);
  } finally {
    await server.close();
  }
});

test('kStatusText covers common status codes for Web Response path', async () => {
  const codes = [301, 302, 303, 307, 308, 401, 403, 405, 409, 410, 429, 503];
  const server = createServer((ctx) => {
    // ctx.request.url is the full URL; take the path to get the status code.
    const code = new URL(ctx.request.url).pathname.slice(1);
    return new Response(null, { status: code });
  });
  try {
    await server.listen(0);
    const { port } = server.address();
    for (const code of codes) {
      const response = await rawRequest(
        port,
        `GET /${code} HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n`);
      // Must be the requested status followed by a non-empty reason phrase.
      assert.match(response, new RegExp(`^HTTP/1\\.1 ${code} \\S`));
    }
  } finally {
    await server.close();
  }
});

test('ctx.hijack() throws if ctx.request body was already consumed', async () => {
  // Accessing ctx.request for a POST with a body claims body ownership.
  // A subsequent ctx.hijack() call must throw ERR_INVALID_STATE.
  const server = createServer(mustCall(async (ctx) => {
    // Accessing ctx.request claims body ownership for the request path.
    assert.ok(ctx.request);
    assert.throws(() => ctx.hijack(), { code: 'ERR_INVALID_STATE' });
    return new Response('ok', { headers: [['content-length', '2']] });
  }));
  try {
    await server.listen(0);
    const { port } = server.address();
    const response = await rawRequest(
      port,
      'POST / HTTP/1.1\r\nHost: example.test\r\n' +
        'Content-Length: 4\r\nConnection: close\r\n\r\nbody');
    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /ok$/);
  } finally {
    await server.close();
  }
});

test('OPTIONS * returns 501 Not Implemented', async () => {
  const server = createServer(mustNotCall());
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'OPTIONS * HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 501 Not Implemented/);
  } finally {
    await server.close();
  }
});

test('server.inject suppresses HEAD body in hijack path', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    h.writeHead(200, [['content-length', 5]]);
    h.write('hello');
    h.end();
  }));

  const response = await server.inject(
    new Request('http://example.test/', { method: 'HEAD' }));
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get('content-length'), '5');
  assert.strictEqual(await response.text(), '');
});

test('all responses include a Date header', async () => {
  const server = createServer(mustCall((ctx) => {
    const h = ctx.hijack();
    h.writeHead(200, [['content-length', '2']]);
    h.end('ok');
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /\r\nDate: /i);
  } finally {
    await server.close();
  }
});

test('server.closeAllConnections() force-closes active connections', async () => {
  const server = createServer(() =>
    new Response('ok', { headers: [['content-length', '2']] }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const socket = net.connect({ port, host: '127.0.0.1' });
    await once(socket, 'connect');
    // Leave connection open (keep-alive).
    socket.write('GET / HTTP/1.1\r\nHost: example.test\r\n\r\n');

    // Wait for a response to confirm the connection is live.
    await new Promise((resolve) => {
      socket.once('data', resolve);
    });

    // Force-close all connections while they are idle.
    server.closeAllConnections();

    await once(socket, 'close');
    // The socket should close without error (forced by server).
  } finally {
    server.close();
  }
});

test('listen resolves hostnames via DNS before binding', async () => {
  const server = createServer(() =>
    new Response('ok', { headers: [['content-length', '2']] }));
  try {
    await server.listen(0, 'localhost');
    const addr = server.address();
    assert.ok(addr !== null);
    assert.ok(addr.port > 0);
    // DNS resolution should have yielded a numeric IPv4 or IPv6 address.
    assert.ok(
      /^\d+\.\d+\.\d+\.\d+$/.test(addr.address) || addr.address.includes(':'),
      `expected numeric IP, got ${addr.address}`);
  } finally {
    await server.close();
  }
});

test('protocols option accepts h1 and rejects unsupported versions', async () => {
  // Explicit ['h1'] is accepted.
  const handler = () =>
    new Response('ok', { headers: [['content-length', '2']] });
  const server = createServer(handler, { protocols: ['h1'] });
  try {
    await server.listen(0);
    const { port } = server.address();
    const response = await rawRequest(
      port,
      'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 200 OK/);
  } finally {
    await server.close();
  }

  // Not-yet-implemented versions and malformed values are rejected.
  assert.throws(
    () => createServer(mustNotCall(), { protocols: ['h2'] }),
    { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(
    () => createServer(mustNotCall(), { protocols: ['h1', 'h3'] }),
    { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(
    () => createServer(mustNotCall(), { protocols: [] }),
    { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(
    () => createServer(mustNotCall(), { protocols: 'h1' }),
    { code: 'ERR_INVALID_ARG_VALUE' });
});

test('sustained concurrent keep-alive requests do not leak or reorder', async () => {
  // Stability: drive many concurrent connections, each issuing several
  // pipelined keep-alive requests, then a final Connection: close. Verifies
  // every connection drains in order and the server closes them all cleanly
  // (no leaked connections, no out-of-order responses under load).
  let served = 0;
  // Plain handler: the exact call count is asserted manually below, so this
  // must not be wrapped in mustCall (which would assert a fixed count).
  const server = createServer((ctx) => {
    served++;
    const n = new URL(ctx.request.url).pathname.slice(1);
    return new Response(n, { headers: [['content-length', n.length]] });
  });

  const CONNECTIONS = 24;
  const REQUESTS_PER_CONN = 8;

  function runConnection(port, id) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const chunks = [];
      socket.setTimeout(platformTimeout(4000), () => {
        socket.destroy(new Error(`connection ${id} timed out`));
      });
      socket.on('error', reject);
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
      socket.on('connect', () => {
        let payload = '';
        for (let i = 0; i < REQUESTS_PER_CONN; i++) {
          const path = `/${id}_${i}`;
          const connHeader = i === REQUESTS_PER_CONN - 1 ?
            'Connection: close\r\n' : '';
          payload +=
            `GET ${path} HTTP/1.1\r\nHost: example.test\r\n${connHeader}\r\n`;
        }
        socket.write(payload);
      });
    });
  }

  try {
    await server.listen(0);
    const { port } = server.address();

    const promises = [];
    for (let id = 0; id < CONNECTIONS; id++) {
      promises.push(runConnection(port, id));
    }
    const responses = await Promise.all(promises);

    // Every connection must have produced exactly REQUESTS_PER_CONN responses,
    // and the bodies must appear in request order.
    for (let id = 0; id < CONNECTIONS; id++) {
      const data = responses[id];
      assert.strictEqual(
        countResponses(data), REQUESTS_PER_CONN,
        `connection ${id} returned ${countResponses(data)} responses`);
      let lastIndex = -1;
      for (let i = 0; i < REQUESTS_PER_CONN; i++) {
        const pos = data.indexOf(`${id}_${i}`);
        assert.ok(pos > lastIndex, `connection ${id} response ${i} out of order`);
        lastIndex = pos;
      }
    }

    assert.strictEqual(served, CONNECTIONS * REQUESTS_PER_CONN);
  } finally {
    await server.close();
  }
});

test('CONNECT requests are rejected with 501 and do not hang', async () => {
  const server = createServer(mustNotCall());
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'CONNECT example.test:443 HTTP/1.1\r\n' +
        'Host: example.test\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 501 Not Implemented/);
  } finally {
    await server.close();
  }
});

test('absolute-form request target is accepted (RFC 9112 section 3.2.2)', async () => {
  const server = createServer(mustCall((ctx) => {
    // The authority in the request-target overrides the Host header, and the
    // server uses the origin-form path+query.
    const url = ctx.request.url;
    return new Response(url, {
      headers: [['content-length', Buffer.byteLength(url)]],
    });
  }));
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET http://origin.example/abs?x=1 HTTP/1.1\r\n' +
        'Host: ignored.example\r\nConnection: close\r\n\r\n');

    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /http:\/\/origin\.example\/abs\?x=1$/);
  } finally {
    await server.close();
  }
});

test('maxInflightRequests caps concurrent in-flight handlers', async () => {
  // With a small cap, a single connection pipelining many async requests must
  // never run more than `cap` handlers at once, and every request must still be
  // answered in order (no deadlock, no leak).
  const CAP = 2;
  const N = 12;
  let inflight = 0;
  let maxObserved = 0;
  let served = 0;
  const server = createServer(async (ctx) => {
    inflight++;
    if (inflight > maxObserved) maxObserved = inflight;
    const n = new URL(ctx.request.url).pathname.slice(1);
    await sleep(platformTimeout(5));
    served++;
    inflight--;
    return new Response(`[${n}]`, {
      headers: [['content-length', `[${n}]`.length]],
    });
  }, { maxInflightRequests: CAP });
  try {
    await server.listen(0);
    const { port } = server.address();

    let payload = '';
    for (let i = 0; i < N; i++) {
      const connHeader = i === N - 1 ? 'Connection: close\r\n' : '';
      payload += `GET /${i} HTTP/1.1\r\nHost: example.test\r\n${connHeader}\r\n`;
    }
    const response = await rawRequest(port, payload, N);

    assert.strictEqual(countResponses(response), N);
    assert.strictEqual(served, N);
    assert.ok(
      maxObserved <= CAP,
      `observed ${maxObserved} concurrent handlers, cap was ${CAP}`);
    // Bodies appear in request order.
    let last = -1;
    for (let i = 0; i < N; i++) {
      const pos = response.indexOf(`[${i}]`);
      assert.ok(pos > last, `response [${i}] out of order`);
      last = pos;
    }
  } finally {
    await server.close();
  }
});

test('queued error after an in-flight request is still delivered', async () => {
  // A malformed request pipelined behind an in-flight async request must still
  // receive its error response before the connection closes, in order, rather
  // than being silently dropped when the connection is marked closing.
  const server = createServer(async () => {
    await sleep(platformTimeout(20));
    return new Response('ok', { headers: [['content-length', '2']] });
  });
  try {
    await server.listen(0);
    const { port } = server.address();

    const response = await rawRequest(
      port,
      'GET /a HTTP/1.1\r\nHost: example.test\r\n\r\n' +
        'GET / HTTP/1.0\r\nHost: example.test\r\n\r\n',
      2);

    assert.match(response, /HTTP\/1\.1 200 OK/);
    assert.match(response, /HTTP\/1\.1 400 Bad Request/);
    assert.ok(
      response.indexOf('200 OK') < response.indexOf('400 Bad Request'),
      'the in-flight 200 must precede the queued 400');
  } finally {
    await server.close();
  }
});

assert.ok(builtinModules.includes('node:http/web'));
