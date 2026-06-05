'use strict';

const {
  ArrayIsArray,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Number,
  ObjectKeys,
  Promise,
  PromisePrototypeThen,
  PromiseReject,
  RegExpPrototypeExec,
  SafeSet,
  SetPrototypeAdd,
  SetPrototypeDelete,
  SetPrototypeGetSize,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
  StringPrototypeToLowerCase,
  StringPrototypeTrimStart,
  SymbolAsyncDispose,
  SymbolIterator,
} = primordials;

const { Buffer } = require('buffer');
const {
  WebHTTPConnection,
  WebHTTPServerHandle,
} = internalBinding('web_http_server');
const {
  ErrnoException,
  codes: {
    ERR_HTTP_HEADERS_SENT,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_RETURN_VALUE,
    ERR_INVALID_STATE,
    ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE,
    ERR_SERVER_ALREADY_LISTEN,
  },
} = require('internal/errors');
const { getOptionValue } = require('internal/options');
const {
  HTTP_CONNECT,
  HTTP1RequestParser,
} = require('internal/http/llhttp_parser');
const {
  validateHeaderName,
  validateHeaderValue,
  validateStatusCode,
} = require('internal/http/validators');
const {
  validateFunction,
  validateInteger,
  validateObject,
  validateString,
} = require('internal/validators');
const { kEmptyObject } = require('internal/util');
const { isPromise, isUint8Array } = require('internal/util/types');
const { clearTimeout, setTimeout } = require('timers');

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HEADERS_TIMEOUT = 60_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 72_000;
const DEFAULT_REQUEST_TIMEOUT = 0;
const CHUNK_TRAILER = '0\r\n\r\n';
const CRLF_CHUNK = '\r\n';
const CHUNK_HEADER_CACHE_LIMIT = 16 * 1024;
const chunkHeaderCache = [];

const STATUS_TEXT = {
  __proto__: null,
  200: 'OK',
  204: 'No Content',
  205: 'Reset Content',
  304: 'Not Modified',
  400: 'Bad Request',
  408: 'Request Timeout',
  413: 'Payload Too Large',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  505: 'HTTP Version Not Supported',
};

const STATUS_LINES = {
  __proto__: null,
  200: 'HTTP/1.1 200 OK\r\n',
  204: 'HTTP/1.1 204 No Content\r\n',
  205: 'HTTP/1.1 205 Reset Content\r\n',
  304: 'HTTP/1.1 304 Not Modified\r\n',
  400: 'HTTP/1.1 400 Bad Request\r\n',
  408: 'HTTP/1.1 408 Request Timeout\r\n',
  413: 'HTTP/1.1 413 Payload Too Large\r\n',
  431: 'HTTP/1.1 431 Request Header Fields Too Large\r\n',
  500: 'HTTP/1.1 500 Internal Server Error\r\n',
  501: 'HTTP/1.1 501 Not Implemented\r\n',
  505: 'HTTP/1.1 505 HTTP Version Not Supported\r\n',
};

let WebHeaders;
let WebRequest;
let WebResponse;

function initializeWebConstructors() {
  if (WebHeaders !== undefined) {
    return;
  }

  // Cache constructors, not instances. Headers objects are mutable and carry
  // per-request/per-response protocol state.
  ({
    Headers: WebHeaders,
    Request: WebRequest,
    Response: WebResponse,
  } = require('internal/deps/undici/undici'));
}

function normalizeOptions(options) {
  validateObject(options, 'options');

  const normalized = {
    __proto__: null,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    headersTimeout: options.headersTimeout ?? DEFAULT_HEADERS_TIMEOUT,
    keepAliveTimeout: options.keepAliveTimeout ?? DEFAULT_KEEP_ALIVE_TIMEOUT,
    maxHeaderSize: options.maxHeaderSize ?? getOptionValue('--max-http-header-size'),
    requestTimeout: options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
  };

  validateInteger(normalized.bodyLimit, 'options.bodyLimit', 0);
  validateInteger(normalized.headersTimeout, 'options.headersTimeout', 0);
  validateInteger(normalized.keepAliveTimeout, 'options.keepAliveTimeout', 0);
  validateInteger(normalized.maxHeaderSize, 'options.maxHeaderSize', 0);
  validateInteger(normalized.requestTimeout, 'options.requestTimeout', 0);

  if (
    normalized.requestTimeout > 0 &&
    normalized.headersTimeout > 0 &&
    normalized.headersTimeout > normalized.requestTimeout
  ) {
    throw new ERR_OUT_OF_RANGE(
      'options.headersTimeout',
      '<= options.requestTimeout',
      normalized.headersTimeout,
    );
  }

  return normalized;
}

function makeHeaderList(headers) {
  const list = [];
  for (const { 0: key, 1: value } of headers) {
    ArrayPrototypePush(list, key, value);
  }
  return list;
}

function makeHeaders(headerList) {
  const headers = new WebHeaders();
  for (let i = 0; i < headerList.length; i += 2) {
    headers.append(headerList[i], headerList[i + 1]);
  }
  return headers;
}

function makeHeaderPairs(headerList) {
  const length = headerList.length;
  if (length === 2) {
    return [[headerList[0], headerList[1]]];
  }

  const pairs = [];
  for (let i = 0; i < length; i += 2) {
    ArrayPrototypePush(pairs, [headerList[i], headerList[i + 1]]);
  }
  return pairs;
}

function makeRequestURL(record) {
  if (
    StringPrototypeStartsWith(record.url, 'http://') ||
    StringPrototypeStartsWith(record.url, 'https://')
  ) {
    return record.url;
  }

  const { host } = record;
  if (host === undefined) {
    throw new ERR_INVALID_STATE(
      'HTTP/1.1 requests require a Host header',
    );
  }
  return 'http://' + host + (record.url || '/');
}

function makeRequest(record) {
  const { method } = record;
  const init = {
    __proto__: null,
    method,
    headers: makeHeaderPairs(record.headerList),
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = record.body;
    init.duplex = 'half';
  }

  return new WebRequest(makeRequestURL(record), init);
}

function normalizeResponse(value) {
  if (value instanceof WebResponse) {
    return value;
  }
  if (value === undefined || value === null) {
    throw new ERR_INVALID_RETURN_VALUE(
      'a Response or a value coercible to a Response',
      'handler',
      value,
    );
  }
  return new WebResponse(value);
}

function responseHasBody(status, method) {
  return method !== 'HEAD' &&
         status !== 204 &&
         status !== 205 &&
         status !== 304;
}

function statusLine(status, statusText = '') {
  if (statusText === '') {
    const line = STATUS_LINES[status];
    if (line !== undefined) {
      return line;
    }
  }
  const reason = statusText || STATUS_TEXT[status] || '';
  return `HTTP/1.1 ${status}${reason ? ` ${reason}` : ''}\r\n`;
}

function serializeHeaders(headers) {
  let serialized = '';
  let hasConnection = false;
  let hasContentLength = false;
  let hasTransferEncoding = false;

  for (const { 0: name, 1: value } of headers) {
    const lowerName = StringPrototypeToLowerCase(name);
    if (lowerName === 'connection') {
      hasConnection = true;
    } else if (lowerName === 'content-length') {
      hasContentLength = true;
    } else if (lowerName === 'transfer-encoding') {
      hasTransferEncoding = true;
    } else if (lowerName === 'set-cookie') {
      // `Headers` may expose Set-Cookie through getSetCookie(); serialize those
      // below so multiple cookies remain distinct header lines.
      continue;
    }
    serialized += `${name}: ${value}\r\n`;
  }

  const cookies = headers.getSetCookie();
  for (let i = 0; i < cookies.length; i++) {
    serialized += `Set-Cookie: ${cookies[i]}\r\n`;
  }

  return {
    __proto__: null,
    hasConnection,
    hasContentLength,
    hasTransferEncoding,
    serialized,
  };
}

function bufferFromChunk(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function writableChunk(chunk) {
  return typeof chunk === 'string' || isUint8Array(chunk) ?
    chunk :
    Buffer.from(chunk);
}

function chunkHeader(length) {
  if (length < CHUNK_HEADER_CACHE_LIMIT) {
    let header = chunkHeaderCache[length];
    if (header === undefined) {
      header = `${length.toString(16)}\r\n`;
      chunkHeaderCache[length] = header;
    }
    return header;
  }
  return `${length.toString(16)}\r\n`;
}

function resolveDrain(state) {
  if (state.drainResolve !== null) {
    const resolve = state.drainResolve;
    state.drainPromise = null;
    state.drainResolve = null;
    resolve();
  }
}

function createUVError(status, syscall) {
  return new ErrnoException(status, syscall);
}

function noop() {}

function isConnectRecord(record) {
  const { methodCode } = record;
  if (methodCode !== undefined) {
    return methodCode === HTTP_CONNECT;
  }
  return record.method === 'CONNECT';
}

function appendHeaderLine(head, name, value) {
  validateHeaderName(name);
  validateHeaderValue(name, value);
  return `${head}${name}: ${value}\r\n`;
}

function writeChunk(state, chunk) {
  if (state.closed) {
    return;
  }
  if (state.connection.write(writableChunk(chunk))) {
    return;
  }
  state.drainPromise ??= new Promise((resolve) => {
    state.drainResolve = resolve;
  });
  return state.drainPromise;
}

function writeChunks(state, chunks) {
  if (state.closed) {
    return;
  }
  if (chunks.length === 1) {
    return writeChunk(state, chunks[0]);
  }
  if (state.connection.writev(chunks)) {
    return;
  }
  state.drainPromise ??= new Promise((resolve) => {
    state.drainResolve = resolve;
  });
  return state.drainPromise;
}

async function writeStream(state, body, chunked, head) {
  let pendingHead = head;
  for await (const value of body) {
    const chunk = writableChunk(value);
    if (chunked) {
      const chunks = pendingHead === null ?
        [chunkHeader(chunk.length), chunk, CRLF_CHUNK] :
        [pendingHead, chunkHeader(chunk.length), chunk, CRLF_CHUNK];
      pendingHead = null;
      const pending = writeChunks(state, chunks);
      if (isPromise(pending)) await pending;
    } else {
      const chunks = pendingHead === null ? [chunk] : [pendingHead, chunk];
      pendingHead = null;
      const pending = writeChunks(state, chunks);
      if (isPromise(pending)) await pending;
    }
  }
  if (chunked) {
    const pending = pendingHead === null ?
      writeChunk(state, CHUNK_TRAILER) :
      writeChunks(state, [pendingHead, CHUNK_TRAILER]);
    if (isPromise(pending)) await pending;
  } else if (pendingHead !== null) {
    const pending = writeChunk(state, pendingHead);
    if (isPromise(pending)) await pending;
  }
}

function writeHTTPError(state, status) {
  if (state.closed) {
    return;
  }
  state.connection.end(
    `${statusLine(status)}Connection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function parseHijackedResponse(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    const chunks = [];
    for (let i = 0; i < bytes.length; i++) {
      ArrayPrototypePush(chunks, bufferFromChunk(bytes[i]));
    }
    bytes = Buffer.concat(chunks);
  }

  const headerEnd = StringPrototypeIndexOf(`${bytes}`, '\r\n\r\n');
  if (headerEnd === -1) {
    throw new ERR_INVALID_STATE(
      'hijack() response is missing an HTTP header block',
    );
  }

  const head = bytes.subarray(0, headerEnd).toString();
  const body = bytes.subarray(headerEnd + 4);
  const lines = StringPrototypeSplit(head, '\r\n');
  const match = RegExpPrototypeExec(/^HTTP\/1\.1 ([0-9]{3})(?: (.*))?$/, lines[0]);
  if (match === null) {
    throw new ERR_INVALID_STATE(
      'hijack() response is missing an HTTP/1.1 status line',
    );
  }

  const headers = new WebHeaders();
  for (let i = 1; i < lines.length; i++) {
    const index = StringPrototypeIndexOf(lines[i], ':');
    if (index !== -1) {
      headers.append(
        StringPrototypeSlice(lines[i], 0, index),
        StringPrototypeTrimStart(StringPrototypeSlice(lines[i], index + 1)),
      );
    }
  }

  return new WebResponse(body, {
    __proto__: null,
    status: Number(match[1]),
    statusText: match[2] ?? '',
    headers,
  });
}

function createConnectionState(connection, options) {
  return {
    __proto__: null,
    activeRequests: 0,
    closed: false,
    closeAfterResponses: false,
    connection,
    drainPromise: null,
    drainResolve: null,
    flushing: false,
    headersTimer: null,
    keepAliveTimer: null,
    nextResponseSequence: 0,
    nextWriteSequence: 0,
    options,
    peerEnded: false,
    requestTimer: null,
    responseQueue: [],
    responseQueueOffset: 0,
  };
}

function clearConnectionTimer(state, name) {
  if (state[name] !== null) {
    clearTimeout(state[name]);
    state[name] = null;
  }
}

function closeConnectionWith(state, status) {
  clearConnectionTimer(state, 'headersTimer');
  clearConnectionTimer(state, 'keepAliveTimer');
  clearConnectionTimer(state, 'requestTimer');
  writeHTTPError(state, status);
  state.closed = true;
}

function destroyConnection(state) {
  clearConnectionTimer(state, 'headersTimer');
  clearConnectionTimer(state, 'keepAliveTimer');
  clearConnectionTimer(state, 'requestTimer');
  state.closed = true;
  state.connection.destroy();
}

function armHeadersTimer(state) {
  const { options } = state;
  if (state.headersTimer === null && options.headersTimeout > 0) {
    state.headersTimer = setTimeout(
      () => closeConnectionWith(state, 408),
      options.headersTimeout,
    );
    state.headersTimer.unref();
  }
}

function armKeepAliveTimer(state) {
  clearConnectionTimer(state, 'keepAliveTimer');
  const { options } = state;
  if (options.keepAliveTimeout > 0) {
    state.keepAliveTimer = setTimeout(() => {
      state.closed = true;
      state.connection.end();
    }, options.keepAliveTimeout);
    state.keepAliveTimer.unref();
  }
}

function armRequestTimer(state) {
  const { options } = state;
  if (state.requestTimer === null && options.requestTimeout > 0) {
    state.requestTimer = setTimeout(
      () => closeConnectionWith(state, 408),
      options.requestTimeout,
    );
    state.requestTimer.unref();
  }
}

class ProtocolWriter {
  #chunks = [];
  #ended = false;
  #body;
  #headers;
  #headersWritten = false;
  #pendingString = '';
  #record;

  constructor(record) {
    this.#record = record;
    this.#headers = undefined;
    this.#body = undefined;
  }

  #flushString() {
    if (this.#pendingString.length !== 0) {
      ArrayPrototypePush(this.#chunks, this.#pendingString);
      this.#pendingString = '';
    }
  }

  #pushChunk(chunk) {
    if (typeof chunk === 'string') {
      this.#pendingString += chunk;
      return;
    }

    this.#flushString();
    ArrayPrototypePush(this.#chunks, writableChunk(chunk));
  }

  get headers() {
    return this.#headers ??= makeHeaders(this.#record.headerList);
  }

  get method() {
    return this.#record.method;
  }

  get url() {
    return this.#record.url;
  }

  get body() {
    return this.#body ??= this.#record.body;
  }

  writeHead(status, headers = undefined) {
    if (this.#headersWritten) {
      throw new ERR_HTTP_HEADERS_SENT('writeHead');
    }

    status = validateStatusCode(status);
    let head = statusLine(status);

    if (headers !== undefined) {
      if (ArrayIsArray(headers) && !ArrayIsArray(headers[0])) {
        if (headers.length % 2 !== 0) {
          throw new ERR_INVALID_ARG_VALUE('headers', headers);
        }
        for (let i = 0; i < headers.length; i += 2) {
          head = appendHeaderLine(head, headers[i], headers[i + 1]);
        }
      } else if (headers?.[SymbolIterator] !== undefined) {
        for (const { 0: key, 1: value } of headers) {
          head = appendHeaderLine(head, key, value);
        }
      } else {
        const keys = ObjectKeys(headers);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          head = appendHeaderLine(head, key, headers[key]);
        }
      }
    }

    head += '\r\n';
    this.#headersWritten = true;
    this.#pushChunk(head);
  }

  write(chunk) {
    if (!this.#headersWritten) {
      this.writeHead(200);
    }
    this.#pushChunk(chunk);
    return true;
  }

  end(chunk = undefined) {
    if (chunk !== undefined) {
      this.write(chunk);
    } else if (!this.#headersWritten) {
      this.writeHead(200);
    }
    this.#ended = true;
  }

  chunks() {
    if (!this.#ended) {
      this.end();
    }
    this.#flushString();
    // The network path passes these retained strings/typed arrays directly to
    // writev. Only inject(), which is not a transport hot path, materializes
    // Buffers to parse the synthetic raw response.
    return this.#chunks;
  }
}

function createRequestContext(record, request) {
  const state = {
    __proto__: null,
    hijacked: false,
    request,
    writer: undefined,
  };

  const context = {
    __proto__: null,
    get request() {
      return state.request ??= makeRequest(record);
    },
    hijack() {
      if (state.hijacked) {
        throw new ERR_INVALID_STATE(
          'The Web HTTP exchange has already been hijacked',
        );
      }
      state.hijacked = true;
      return state.writer ??= new ProtocolWriter(record);
    },
  };

  return { __proto__: null, context, state };
}

function makeNotImplementedOutcome() {
  return {
    __proto__: null,
    close: true,
    response: new WebResponse(null, { __proto__: null, status: 501 }),
  };
}

function makeHandlerErrorOutcome(state) {
  if (state.hijacked) {
    return {
      __proto__: null,
      close: true,
      raw: state.writer.chunks(),
    };
  }

  return {
    __proto__: null,
    close: true,
    response: new WebResponse(null, { __proto__: null, status: 500 }),
  };
}

function makeHandlerOutcome(state, value) {
  if (state.hijacked) {
    return {
      __proto__: null,
      raw: state.writer.chunks(),
    };
  }

  return {
    __proto__: null,
    response: normalizeResponse(value),
  };
}

function compactResponseQueue(state) {
  if (state.responseQueueOffset === 0) {
    return;
  }
  if (state.responseQueueOffset === state.responseQueue.length) {
    state.responseQueue = [];
    state.responseQueueOffset = 0;
    return;
  }
  if (state.responseQueueOffset > 32) {
    state.responseQueue =
      ArrayPrototypeSlice(state.responseQueue, state.responseQueueOffset);
    state.responseQueueOffset = 0;
  }
}

function normalizeListenArgs(args) {
  if (args.length === 0) {
    throw new ERR_MISSING_ARGS('port');
  }

  let options;
  if (args.length === 1) {
    try {
      validateObject(args[0], 'options');
      options = args[0];
    } catch {
      options = {
        __proto__: null,
        port: args[0],
      };
    }
  } else {
    options = {
      __proto__: null,
      port: args[0],
      host: args[1],
      backlog: args[2],
    };
  }

  const port = options.port ?? 0;
  const host = options.host ?? '0.0.0.0';
  const backlog = options.backlog ?? 511;

  validateInteger(port, 'options.port', 0, 65535);
  validateString(host, 'options.host');
  validateInteger(backlog, 'options.backlog', 1);

  return { __proto__: null, port, host, backlog };
}

class WebHTTPServer {
  #handler;
  #closePromise = null;
  #closeResolve = null;
  #connections = new SafeSet();
  #listenClosePending = false;
  #options;
  #server = null;

  constructor(options, handler) {
    this.#options = normalizeOptions(options);
    this.#handler = handler;
  }

  listen(...args) {
    if (this.#server !== null) {
      throw new ERR_SERVER_ALREADY_LISTEN();
    }

    const { host, port, backlog } = normalizeListenArgs(args);

    return new Promise((resolve, reject) => {
      const server = new WebHTTPServerHandle(
        WebHTTPConnection,
        (connection) => this.#onConnection(connection),
        noop,
        () => {
          this.#listenClosePending = false;
          this.#maybeResolveClose();
        },
      );

      const err = server.listen(host, port, backlog);
      if (err !== 0) {
        server.close();
        reject(createUVError(err, 'listen'));
        return;
      }

      this.#server = server;
      resolve(this);
    });
  }

  close() {
    const server = this.#server;
    if (server === null) {
      return this.#closePromise ?? undefined;
    }
    this.#server = null;

    this.#closePromise = new Promise((resolve) => {
      this.#closeResolve = resolve;
      this.#listenClosePending = true;
      server.close();
    });
    for (const state of this.#connections) {
      destroyConnection(state);
    }
    this.#maybeResolveClose();
    return this.#closePromise;
  }

  address() {
    return this.#server?.address() ?? null;
  }

  [SymbolAsyncDispose]() {
    return this.close();
  }

  inject(request) {
    if (!(request instanceof WebRequest)) {
      return PromiseReject(new ERR_INVALID_ARG_TYPE(
        'request',
        'Request',
        request,
      ));
    }

    const headerList = makeHeaderList(request.headers);
    const record = {
      __proto__: null,
      method: request.method,
      url: request.url,
      host: undefined,
      headerList,
      body: request.body,
      httpVersionMajor: 1,
      httpVersionMinor: 1,
      shouldKeepAlive: false,
      upgrade: false,
    };

    return new Promise((resolve, reject) => {
      this.#runHandler(record, request, (outcome) => {
        try {
          if (outcome.raw !== undefined) {
            resolve(parseHijackedResponse(outcome.raw));
            return;
          }
          resolve(outcome.response);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  #onConnection(connection) {
    const options = this.#options;
    const state = createConnectionState(connection, options);
    SetPrototypeAdd(this.#connections, state);

    const parser = new HTTP1RequestParser({
      __proto__: null,
      bodyLimit: options.bodyLimit,
      maxHeaderSize: options.maxHeaderSize,
      onRequest: (record) => {
        clearConnectionTimer(state, 'headersTimer');
        clearConnectionTimer(state, 'keepAliveTimer');
        state.activeRequests++;
        armRequestTimer(state);

        if (
          record.httpVersionMajor !== 1 ||
          record.httpVersionMinor !== 1
        ) {
          // Web HTTP is intentionally HTTP/1.1-only for v1. Reject older
          // versions before materializing Web objects or invoking user code.
          closeConnectionWith(state, 505);
          return -1;
        }

        if (
          record.host === undefined
        ) {
          // RFC 9112 requires Host for HTTP/1.1 requests. Reject before the
          // user handler so the Web API never fabricates an origin.
          closeConnectionWith(state, 400);
          return -1;
        }

        const slot = {
          __proto__: null,
          record,
          outcome: null,
          ready: false,
          sequence: state.nextResponseSequence++,
        };

        ArrayPrototypePush(state.responseQueue, slot);
        this.#runHandler(record, null, (outcome) => {
          slot.outcome = outcome;
          slot.ready = true;
          this.#flushResponses(state);
        });
        return 0;
      },
      onRequestComplete: () => {
        state.activeRequests--;
        if (state.activeRequests === 0) {
          clearConnectionTimer(state, 'requestTimer');
        }
      },
    });

    connection.start([
      (chunk) => {
        if (state.closed) {
          return;
        }
        clearConnectionTimer(state, 'keepAliveTimer');
        if (state.activeRequests === 0) {
          armHeadersTimer(state);
        }
        try {
          return parser.execute(chunk);
        } catch (err) {
          closeConnectionWith(state, err.statusCode ?? 400);
          return parser.retainedBuffer === true;
        }
      },
      () => {
        // The peer ended its writable side. Parsed pipelined requests may still
        // have pending responses, so only the parser is closed here.
        state.peerEnded = true;
        clearConnectionTimer(state, 'headersTimer');
        clearConnectionTimer(state, 'keepAliveTimer');
        try {
          parser.finish();
        } catch (err) {
          closeConnectionWith(state, err.statusCode ?? 400);
          return;
        }
        parser.close();
        this.#maybeEndConnection(state);
      },
      noop,
      () => {
        resolveDrain(state);
      },
      () => {
        state.closed = true;
        resolveDrain(state);
        clearConnectionTimer(state, 'headersTimer');
        clearConnectionTimer(state, 'keepAliveTimer');
        clearConnectionTimer(state, 'requestTimer');
        parser.close();
        SetPrototypeDelete(this.#connections, state);
        this.#maybeResolveClose();
      },
    ]);

    armHeadersTimer(state);
  }

  #maybeResolveClose() {
    if (
      this.#closeResolve !== null &&
      !this.#listenClosePending &&
      SetPrototypeGetSize(this.#connections) === 0
    ) {
      const closeResolve = this.#closeResolve;
      this.#closePromise = null;
      this.#closeResolve = null;
      closeResolve();
    }
  }

  #runHandler(record, request, done) {
    if (record.upgrade || isConnectRecord(record)) {
      done(makeNotImplementedOutcome());
      return;
    }

    const { context, state } = createRequestContext(record, request);

    try {
      const value = this.#handler(context);
      if (isPromise(value)) {
        PromisePrototypeThen(
          value,
          (resolved) => {
            try {
              done(makeHandlerOutcome(state, resolved));
            } catch {
              done(makeHandlerErrorOutcome(state));
            }
          },
          () => done(makeHandlerErrorOutcome(state)),
        );
        return;
      }

      done(makeHandlerOutcome(state, value));
    } catch {
      done(makeHandlerErrorOutcome(state));
    }
  }

  #flushResponses(state) {
    if (state.flushing || state.closed) {
      return;
    }

    // Handlers may finish out of order. Slots keep the transport ordered
    // without constructing a promise chain for every pipelined request.
    const queue = state.responseQueue;
    while (state.responseQueueOffset < queue.length) {
      const slot = queue[state.responseQueueOffset];
      if (!slot.ready || slot.sequence !== state.nextWriteSequence) {
        break;
      }

      state.responseQueueOffset++;
      state.nextWriteSequence++;
      const pending = this.#writeOutcome(state, slot.record, slot.outcome);
      if (isPromise(pending)) {
        state.flushing = true;
        PromisePrototypeThen(
          pending,
          () => {
            this.#finishOutcome(state, slot.record, slot.outcome);
            state.flushing = false;
            compactResponseQueue(state);
            this.#flushResponses(state);
          },
          () => {
            state.flushing = false;
            state.closed = true;
            state.connection.destroy();
          },
        );
        return;
      }
      if (state.closed) {
        break;
      }
    }

    compactResponseQueue(state);
    this.#maybeEndConnection(state);
  }

  #writeOutcome(state, record, outcome) {
    if (state.closed) {
      return;
    }

    let pending;
    if (outcome.raw !== undefined) {
      pending = writeChunks(state, outcome.raw);
    } else {
      const keepAlive = record.shouldKeepAlive &&
                        outcome.close !== true &&
                        !state.peerEnded &&
                        !state.closeAfterResponses;
      pending = this.#writeResponse(state, record.method, outcome.response, keepAlive);
    }

    if (isPromise(pending)) {
      return pending;
    }

    this.#finishOutcome(state, record, outcome);
  }

  #finishOutcome(state, record, outcome) {
    if (
      !record.shouldKeepAlive ||
      outcome.close === true ||
      state.peerEnded
    ) {
      state.closeAfterResponses = true;
    }

    if (!state.closeAfterResponses) {
      armKeepAliveTimer(state);
    }
    this.#maybeEndConnection(state);
  }

  #maybeEndConnection(state) {
    if (
      state.closeAfterResponses &&
      !state.closed &&
      !state.flushing &&
      state.responseQueueOffset >= state.responseQueue.length
    ) {
      state.connection.end();
    }
  }

  #writeResponse(state, method, response, keepAlive) {
    const body = response.body;
    const hasBody = responseHasBody(response.status, method) && body !== null;
    const {
      hasConnection,
      hasContentLength,
      hasTransferEncoding,
      serialized,
    } = serializeHeaders(response.headers);
    let extraHeaders = '';

    if (!keepAlive && !hasConnection) {
      extraHeaders += 'Connection: close\r\n';
    }

    let chunked = false;
    if (hasBody) {
      if (
        !hasContentLength &&
        !hasTransferEncoding
      ) {
        extraHeaders += 'Transfer-Encoding: chunked\r\n';
        chunked = true;
      }
    } else if (
      !hasContentLength &&
      !hasTransferEncoding
    ) {
      extraHeaders += 'Content-Length: 0\r\n';
    }

    const headText =
      `${statusLine(response.status, response.statusText)}${serialized}${extraHeaders}\r\n`;

    if (hasBody) {
      return writeStream(state, body, chunked, headText);
    }

    return writeChunk(state, headText);
  }
}

function createServer(options, handler) {
  if (handler === undefined && options !== undefined) {
    handler = options;
    options = kEmptyObject;
  } else {
    options ??= kEmptyObject;
  }

  validateObject(options, 'options');
  validateFunction(handler, 'handler');
  // Every Web object helper is reachable only from a server created through
  // this factory, so initialize the constructors once at the entry point.
  initializeWebConstructors();
  return new WebHTTPServer(options, handler);
}

module.exports = {
  createServer,
};
