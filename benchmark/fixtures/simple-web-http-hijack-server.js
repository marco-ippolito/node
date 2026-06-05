'use strict';

const { createServer } = require('node:http/web');

const fixed = 'C'.repeat(20 * 1024);
const storedBytes = Object.create(null);
const storedBuffer = Object.create(null);

function chunkBody(writer, body, chunks) {
  if (chunks <= 1) {
    writer.write(`${body.length.toString(16)}\r\n`);
    writer.write(body);
    writer.end('\r\n0\r\n\r\n');
    return;
  }

  const len = body.length;
  const step = Math.floor(len / chunks) || 1;
  for (let i = 0; i < chunks - 1; i++) {
    const chunk = body.slice(i * step, i * step + step);
    writer.write(`${chunk.length.toString(16)}\r\n`);
    writer.write(chunk);
    writer.write('\r\n');
  }
  const chunk = body.slice((chunks - 1) * step);
  writer.write(`${chunk.length.toString(16)}\r\n`);
  writer.write(chunk);
  writer.end('\r\n0\r\n\r\n');
}

function writeBody(writer, body, chunks) {
  if (chunks <= 1) {
    writer.end(body);
    return;
  }

  const len = body.length;
  const step = Math.floor(len / chunks) || 1;
  for (let i = 0; i < chunks - 1; i++) {
    writer.write(body.slice(i * step, i * step + step));
  }
  writer.end(body.slice((chunks - 1) * step));
}

module.exports = createServer((ctx) => {
  const writer = ctx.hijack();
  const params = writer.url.split('/');
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
  } else {
    status = 404;
    body = 'not found\n';
  }

  const headers = {
    __proto__: null,
    'Content-Type': 'text/plain',
  };
  if (chunkedEnc) {
    headers['Transfer-Encoding'] = 'chunked';
  } else {
    headers['Content-Length'] = body.length.toString();
  }

  if (resHow === 'setHeader' || resHow === 'setHeaderWH') {
    headers['X-Response-Mode'] = resHow;
  }

  writer.writeHead(status, headers);
  if (chunkedEnc) {
    chunkBody(writer, body, chunks);
  } else {
    writeBody(writer, body, chunks);
  }
});
