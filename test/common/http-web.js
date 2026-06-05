'use strict';

const assert = require('node:assert');
const net = require('node:net');
const { once } = require('node:events');

async function listen(server) {
  await server.listen(0, '127.0.0.1');
  return server.address().port;
}

async function withWebServer(server, fn) {
  await listen(server);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function rawRequest(server, request) {
  const socket = net.connect(server.address().port, '127.0.0.1');
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  socket.end(request);

  let raw = '';
  for await (const chunk of socket) {
    raw += chunk;
  }
  return raw;
}

function assertContainsInOrder(haystack, needles) {
  let offset = 0;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, offset);
    assert.notStrictEqual(index, -1, `missing ${needle} in ${haystack}`);
    offset = index + needle.length;
  }
}

function responseBody(raw) {
  const index = raw.indexOf('\r\n\r\n');
  assert.notStrictEqual(index, -1, `missing header terminator in ${raw}`);
  return raw.slice(index + 4);
}

module.exports = {
  assertContainsInOrder,
  listen,
  rawRequest,
  responseBody,
  withWebServer,
};
