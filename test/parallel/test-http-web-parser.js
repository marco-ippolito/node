// Flags: --expose-internals --no-warnings
'use strict';

require('../common');
const assert = require('node:assert');
const { test } = require('node:test');

const { HTTP1RequestParser } = require('internal/http/llhttp_parser');

function createParser(options = {}) {
  const records = [];
  const completed = [];
  const parser = new HTTP1RequestParser({
    __proto__: null,
    bodyLimit: options.bodyLimit ?? 1024,
    maxHeaderSize: options.maxHeaderSize ?? 1024,
    onRequest(record) {
      records.push(record);
    },
    onRequestComplete(record) {
      completed.push(record);
    },
  });

  return { __proto__: null, completed, parser, records };
}

async function bodyText(record) {
  return new Response(record.body).text();
}

test('HTTP1RequestParser parses content-length request bodies', async () => {
  const { completed, parser, records } = createParser();

  parser.execute(Buffer.from(
    'POST /hello HTTP/1.1\r\n' +
    'Host: example.test\r\n' +
    'Content-Length: 5\r\n' +
    '\r\n' +
    'hello',
  ));

  assert.strictEqual(records.length, 1);
  assert.strictEqual(completed.length, 1);
  assert.strictEqual(records[0].method, 'POST');
  assert.strictEqual(records[0].url, '/hello');
  assert.strictEqual(records[0].headers.get('host'), 'example.test');
  assert.strictEqual(await bodyText(records[0]), 'hello');
  parser.close();
});

test('HTTP1RequestParser parses chunked request bodies', async () => {
  const { completed, parser, records } = createParser();

  parser.execute(Buffer.from(
    'POST /chunked HTTP/1.1\r\n' +
    'Host: example.test\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    '\r\n' +
    '5\r\n' +
    'hello\r\n' +
    '0\r\n' +
    '\r\n',
  ));

  assert.strictEqual(records.length, 1);
  assert.strictEqual(completed.length, 1);
  assert.strictEqual(await bodyText(records[0]), 'hello');
  parser.close();
});

test('HTTP1RequestParser handles fragmented pipelined requests', () => {
  const { completed, parser, records } = createParser();

  parser.execute(Buffer.from('GET /one HT'));
  parser.execute(Buffer.from(
    'TP/1.1\r\n' +
    'Host: example.test\r\n' +
    '\r\n' +
    'GET /two HTTP/1.1\r\n' +
    'Host: example.test\r\n' +
    '\r\n',
  ));

  assert.strictEqual(records.length, 2);
  assert.strictEqual(completed.length, 2);
  assert.strictEqual(records[0].url, '/one');
  assert.strictEqual(records[1].url, '/two');
  parser.close();
});

test('HTTP1RequestParser reports header and body limits', () => {
  {
    const { parser } = createParser({ maxHeaderSize: 8 });
    assert.throws(() => {
      parser.execute(Buffer.from(
        'GET /overflow HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        '\r\n',
      ));
    }, (err) => {
      assert.strictEqual(err.code, 'HPE_HEADER_OVERFLOW');
      assert.strictEqual(err.statusCode, 431);
      return true;
    });
    parser.close();
  }

  {
    const { parser } = createParser({ bodyLimit: 4 });
    assert.throws(() => {
      parser.execute(Buffer.from(
        'POST /overflow HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Content-Length: 5\r\n' +
        '\r\n' +
        'hello',
      ));
    }, (err) => {
      assert.strictEqual(err.code, 'ERR_WEB_HTTP_BODY_LIMIT');
      assert.strictEqual(err.statusCode, 413);
      return true;
    });
    parser.close();
  }

  {
    const { parser } = createParser({ bodyLimit: 4 });
    assert.throws(() => {
      parser.execute(Buffer.from(
        'POST /overflow HTTP/1.1\r\n' +
        'Host: example.test\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        '\r\n' +
        '3\r\n' +
        'abc\r\n' +
        '2\r\n' +
        'de\r\n',
      ));
    }, (err) => {
      assert.strictEqual(err.code, 'ERR_WEB_HTTP_BODY_LIMIT');
      assert.strictEqual(err.statusCode, 413);
      return true;
    });
    assert.strictEqual(parser.retainedBuffer, true);
    parser.close();
  }
});

test('HTTP1RequestParser rejects use after close', () => {
  const { parser } = createParser();

  parser.close();
  assert.throws(() => parser.execute(Buffer.from('GET / HTTP/1.1\r\n\r\n')), {
    code: 'ERR_INVALID_STATE',
  });
});
