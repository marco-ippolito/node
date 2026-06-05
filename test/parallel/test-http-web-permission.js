// Flags: --experimental-web-http-server --no-warnings --permission --allow-fs-read=*
'use strict';

require('../common');
const assert = require('node:assert');
const { test } = require('node:test');

const { createServer } = require('node:http/web');

test('listen requires network permission', async () => {
  const server = createServer(() => new Response('blocked'));

  await assert.rejects(server.listen(0, '127.0.0.1'), {
    code: 'ERR_ACCESS_DENIED',
    permission: 'Net',
  });
  await server.close();
});
