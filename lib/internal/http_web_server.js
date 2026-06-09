'use strict';

const {
  ArrayBufferIsView,
  ArrayIsArray,
  ArrayPrototypePush,
  ArrayPrototypeUnshift,
  Date,
  DateNow,
  FunctionPrototypeCall,
  MathMin,
  ObjectFreeze,
  ObjectKeys,
  PromisePrototypeThen,
  PromiseWithResolvers,
  SafeMap,
  SafeSet,
  SymbolAsyncDispose,
  SymbolAsyncIterator,
  Uint8Array,
} = primordials;

const {
  WebHttpConnection,
  WebHttpServer: NativeWebHttpServer,
} = internalBinding('web_http_server');
const {
  triggerUncaughtException,
} = internalBinding('errors');

const {
  getOptionValue,
} = require('internal/options');

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_CHAR,
    ERR_INVALID_STATE,
    ERR_OUT_OF_RANGE,
  },
} = require('internal/errors');
const {
  validateFunction,
  validateInteger,
  validateObject,
  validatePort,
  validateString,
} = require('internal/validators');
const { Buffer } = require('buffer');
const {
  isAnyArrayBuffer,
  isPromise,
} = require('internal/util/types');
const {
  URL,
} = require('internal/url');
const {
  createRequestParser,
  kStatusBadRequest,
} = require('internal/http_web_server_parser');
const {
  appendHeaderPair,
  findHeader,
  getRequestHeaders,
  hasInvalidHeaderValueChar,
  isForbiddenBodyStatus,
  kStatusText,
  materializeFlatHeaderPairs,
  normalizeResponseHeaders,
  validateStatus,
} = require('internal/http_web_headers');

const { isIP } = require('internal/net');

let dnsLookup;
function lazyDnsLookup(host) {
  if (dnsLookup === undefined) {
    dnsLookup = require('dns').lookup;
  }
  const { promise, resolve, reject } = PromiseWithResolvers();
  dnsLookup(host, (err, address) => {
    if (err !== null) reject(err);
    else resolve(address);
  });
  return promise;
}

// Returns true when the string is a bare numeric IP address (IPv4 or IPv6)
// that libuv's uv_ip4_addr/uv_ip6_addr can parse directly. Reuses
// internal/net's isIP rather than re-implementing address parsing.
function isNumericAddress(host) {
  return isIP(host) !== 0;
}

let webConstructors;

function lazyWebConstructors() {
  return webConstructors ??= require('internal/deps/undici/undici');
}

const kDefaultHost = '0.0.0.0';
const kDefaultBodyLimit = 1024 * 1024;
// Secure-by-default timeouts mirroring legacy node:http (which protects against
// slow-header/slowloris attacks). headersTimeout is capped at requestTimeout the
// same way legacy does (MathMin), so an explicit small requestTimeout does not
// trip the headersTimeout <= requestTimeout invariant.
const kDefaultHeadersTimeout = 60_000;
const kDefaultRequestTimeout = 300_000;
const kDefaultKeepAliveTimeout = 72_000;
// Per-connection cap on concurrently in-flight (dispatched but not yet flushed)
// requests. Bounds the handler/slot amplification a single connection can force
// by pipelining many requests; extra parsed requests queue and dispatch as slots
// drain, and reads pause while the cap is reached.
const kDefaultMaxInflight = 1024;
const kMaxTimerDuration = 2 ** 31 - 1;
const kEmpty = Buffer.alloc(0);
const kChunkTrailer = Buffer.from('\r\n');
const kFinalChunk = Buffer.from('0\r\n\r\n');
const kContinue = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');
const kStatusRequestTimeout = 408;
const kStatusInternalServerError = 500;

// Lazily cached Date header line. Re-generated at most once per second.
// Caches the full "Date: ...\r\n" string so serializeResponseHead can append
// it without a template-literal allocation on the hot path.
let cachedDate = '';
let cachedDateLine = '';
let cachedDateTimestamp = 0;
// Per-second cache of the two-line response prefix used by the keep-alive fast
// path: "HTTP/1.1 200 OK\r\nDate: ...\r\n". This is the invariant portion of
// the most common response (status 200, no custom headers, keep-alive).
let cachedKAPrefix = '';
let cachedKAPrefixTimestamp = 0;

function getCachedDateLine() {
  const now = DateNow();
  if (now - cachedDateTimestamp >= 1000) {
    cachedDate = new Date(now).toUTCString();
    cachedDateLine = `Date: ${cachedDate}\r\n`;
    cachedDateTimestamp = now;
  }
  return cachedDateLine;
}

// Returns the per-second cached "HTTP/1.1 200 OK\r\nDate: ...\r\n" prefix.
// Rebuilt whenever the Date cache is refreshed (at most once per second).
function getCachedKAPrefix() {
  const dateLine = getCachedDateLine();  // Updates cachedDateTimestamp if stale.
  if (cachedDateTimestamp !== cachedKAPrefixTimestamp) {
    cachedKAPrefixTimestamp = cachedDateTimestamp;
    cachedKAPrefix = `${kStatusLines[200]}${dateLine}`;
  }
  return cachedKAPrefix;
}
const kTimeoutNone = 0;
const kTimeoutRequest = 1;
const kTimeoutKeepAlive = 2;

// HTTP versions this server can negotiate. Only HTTP/1.1 ('h1') is implemented
// today; 'h2'/'h3' are reserved so the constructor option exists before the
// API stabilizes and can be supported later without a breaking change.
const kDefaultProtocols = ['h1'];
const kSupportedProtocols = 'h1';

// Validate options.protocols and return the normalized protocol list. Accepts
// an array of known HTTP-version tokens; rejects unknown or not-yet-implemented
// versions with a clear error rather than silently ignoring them.
function validateProtocols(protocols) {
  if (protocols === undefined) return kDefaultProtocols;
  if (!ArrayIsArray(protocols) || protocols.length === 0) {
    throw new ERR_INVALID_ARG_VALUE('options.protocols', protocols);
  }
  for (let i = 0; i < protocols.length; i++) {
    if (protocols[i] !== kSupportedProtocols) {
      throw new ERR_INVALID_ARG_VALUE(
        'options.protocols', protocols,
        `only '${kSupportedProtocols}' is currently supported`);
    }
  }
  return protocols;
}

function validateOptions(options) {
  if (options === undefined) {
    return {
      __proto__: null,
      bodyLimit: kDefaultBodyLimit,
      headersTimeout: kDefaultHeadersTimeout,
      requestTimeout: kDefaultRequestTimeout,
      keepAliveTimeout: kDefaultKeepAliveTimeout,
      maxHeaderSize: getOptionValue('--max-http-header-size'),
      maxInflightRequests: kDefaultMaxInflight,
      protocols: kDefaultProtocols,
    };
  }

  validateObject(options, 'options');

  const bodyLimit = options.bodyLimit ?? kDefaultBodyLimit;
  validateInteger(bodyLimit, 'options.bodyLimit', 0);

  const requestTimeout = options.requestTimeout ?? kDefaultRequestTimeout;
  validateInteger(
    requestTimeout, 'options.requestTimeout', 0, kMaxTimerDuration);

  // Default headersTimeout to min(60s, requestTimeout) like legacy http, so a
  // smaller explicit requestTimeout never violates the invariant below.
  const headersTimeout = options.headersTimeout ??
    MathMin(kDefaultHeadersTimeout, requestTimeout);
  validateInteger(
    headersTimeout, 'options.headersTimeout', 0, kMaxTimerDuration);

  if (headersTimeout > 0 && requestTimeout > 0 &&
      headersTimeout > requestTimeout) {
    throw new ERR_OUT_OF_RANGE(
      'options.headersTimeout', '<= options.requestTimeout', headersTimeout);
  }

  const keepAliveTimeout = options.keepAliveTimeout ?? kDefaultKeepAliveTimeout;
  validateInteger(
    keepAliveTimeout, 'options.keepAliveTimeout', 0, kMaxTimerDuration);

  const maxHeaderSize =
    options.maxHeaderSize ?? getOptionValue('--max-http-header-size');
  validateInteger(maxHeaderSize, 'options.maxHeaderSize', 0);

  const maxInflightRequests =
    options.maxInflightRequests ?? kDefaultMaxInflight;
  validateInteger(maxInflightRequests, 'options.maxInflightRequests', 1);

  const protocols = validateProtocols(options.protocols);

  return {
    __proto__: null,
    bodyLimit,
    headersTimeout,
    requestTimeout,
    keepAliveTimeout,
    maxHeaderSize,
    maxInflightRequests,
    protocols,
  };
}

function minNonZero(a, b) {
  if (a === 0) return b;
  if (b === 0) return a;
  return a < b ? a : b;
}

// Pre-built "HTTP/1.1 NNN Reason\r\n" strings for all registered status codes.
// Avoids per-response template-literal construction for known status codes.
const kStatusLines = { __proto__: null };
{
  const codes = ObjectKeys(kStatusText);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    kStatusLines[c] = `HTTP/1.1 ${c} ${kStatusText[c]}\r\n`;
  }
}

// Build the response head as a string (no Buffer allocation) so callers that
// want to combine it with a string body can do a single Buffer.from().
function buildResponseHeadStr(status, headers, close) {
  let head = kStatusLines[status] ?? `HTTP/1.1 ${status} \r\n`;
  if (findHeader(headers, 'date') === undefined) head += getCachedDateLine();
  for (let i = 0; i < headers.length; i += 2) {
    head += `${headers[i]}: ${headers[i + 1]}\r\n`;
  }
  if (close && findHeader(headers, 'connection') === undefined) {
    head += 'Connection: close\r\n';
  }
  head += '\r\n';
  return head;
}

function serializeResponseHead(status, headers, close, statusText = '') {
  validateStatus(status);
  if (statusText !== '') {
    if (hasInvalidHeaderValueChar(statusText)) {
      throw new ERR_INVALID_CHAR('status text', statusText);
    }
    // Custom status text: build inline without kStatusLines cache.
    let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
    if (findHeader(headers, 'date') === undefined) head += getCachedDateLine();
    for (let i = 0; i < headers.length; i += 2) {
      head += `${headers[i]}: ${headers[i + 1]}\r\n`;
    }
    if (close && findHeader(headers, 'connection') === undefined) {
      head += 'Connection: close\r\n';
    }
    head += '\r\n';
    return Buffer.from(head);
  }
  return Buffer.from(buildResponseHeadStr(status, headers, close));
}

function toWriteChunk(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBufferIsView(chunk)) return chunk;
  if (isAnyArrayBuffer(chunk)) {
    return new Uint8Array(chunk);
  }
  throw new ERR_INVALID_ARG_TYPE(
    'chunk', ['string', 'ArrayBuffer', 'ArrayBufferView'], chunk);
}

// The low-level request body exposed by hijack().body. It is a single-consumer
// async iterable of Uint8Array chunks, so user code can `for await (const chunk
// of body)` and transform the bytes however it likes with no dependency on any
// particular stream library. bytes() is a convenience for consuming the whole
// body at once. The body is already fully buffered by the parser, so both forms
// resolve immediately; they stay async to keep the contract stable if a future
// pass makes the body demand-driven.
class RequestBody {
  #chunks;
  #consumed = false;

  constructor(chunks) {
    this.#chunks = chunks;
  }

  #claim() {
    if (this.#consumed) {
      throw new ERR_INVALID_STATE('Request body has already been consumed');
    }
    this.#consumed = true;
  }

  async *[SymbolAsyncIterator]() {
    this.#claim();
    const chunks = this.#chunks;
    for (let i = 0; i < chunks.length; i++) {
      yield chunks[i];
    }
  }

  // Resolve the entire request body as a single Uint8Array.
  async bytes() {
    this.#claim();
    const chunks = this.#chunks;
    if (chunks.length === 0) return kEmpty;
    if (chunks.length === 1) return chunks[0];
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
    return Buffer.concat(chunks, total);
  }
}

class ProtocolWriter {
  #state;
  #record;
  #slot;
  #headWritten = false;
  #ended = false;

  constructor(state, record, slot) {
    this.#state = state;
    this.#record = record;
    this.#slot = slot;
  }

  get method() { return this.#record.method; }
  get url() { return this.#record.url; }
  get headers() { return getRequestHeaders(this.#record); }
  get body() {
    return this.#record.bodySource ??= createRequestBody(this.#record.body);
  }

  writeHead(status, headers) {
    if (this.#ended) throw new ERR_INVALID_STATE('Response is already ended');
    if (this.#headWritten) {
      throw new ERR_INVALID_STATE('Response head is already written');
    }
    validateStatus(status);
    const pairs = normalizeResponseHeaders(headers);
    this.#slot.responseStatus = status;
    this.#slot.responseHeaders = pairs;
    this.#headWritten = true;
  }

  write(chunk) {
    if (this.#ended) throw new ERR_INVALID_STATE('Response is already ended');
    if (!this.#headWritten) this.writeHead(200);
    const view = toWriteChunk(chunk);
    if (view.byteLength !== 0) {
      // RFC 7230 section 3.3: no message body for HEAD, 1xx, 204, or 304 responses.
      const noBody = this.#record.method === 'HEAD' ||
        isForbiddenBodyStatus(this.#slot.responseStatus);
      if (!noBody) {
        this.#slot.bodyLength += view.byteLength;
        ArrayPrototypePush(this.#slot.chunks, view);
      }
    }
    return true;
  }

  writev(chunks) {
    if (!ArrayIsArray(chunks)) {
      throw new ERR_INVALID_ARG_TYPE('chunks', 'Array', chunks);
    }
    for (let i = 0; i < chunks.length; i++) {
      this.write(chunks[i]);
    }
    return true;
  }

  end(chunk) {
    if (this.#ended) throw new ERR_INVALID_STATE('Response is already ended');
    if (!this.#headWritten) this.writeHead(200);
    const noBody = this.#record.method === 'HEAD' ||
      isForbiddenBodyStatus(this.#slot.responseStatus);
    const responseHeaders = this.#slot.responseHeaders;

    // Fast path: first and only write is a string with no transfer-encoding
    // already set. Combine response head and body into a single Buffer.from()
    // call - one allocation, one writev vector - instead of separate head and
    // body Buffers. This also covers the common hijack benchmark path where
    // content-length was pre-set in writeHead(), including an empty string body.
    // Skipped for the inject path (connection === null) because inject()
    // expects chunks[0] to be head-only and chunks[1+] to be body.
    // #ended is set before the early return so the state is consistent.
    if (!noBody && typeof chunk === 'string' &&
        this.#slot.connection !== null &&
        this.#slot.chunks.length === 0 &&
        findHeader(responseHeaders, 'transfer-encoding') === undefined) {
      this.#ended = true;
      const bodyByteLen = Buffer.byteLength(chunk);
      const contentLength = findHeader(responseHeaders, 'content-length');
      let headStr;
      // Inner fast path: status 200, no custom headers, keep-alive. Build the
      // response head entirely from cached strings - no per-request string ops
      // other than the content-length line itself.
      if (this.#slot.responseStatus === 200 &&
          (responseHeaders.length === 0 ||
           (responseHeaders.length === 2 &&
            responseHeaders[0] === 'content-length'))) {
        const length = contentLength === undefined ? bodyByteLen : contentLength;
        headStr = `${getCachedKAPrefix()}content-length: ${length}\r\n`;
        if (this.#slot.closeAfterFlush) headStr += 'Connection: close\r\n';
        headStr += '\r\n';
      } else {
        if (contentLength === undefined) {
          ArrayPrototypePush(responseHeaders, 'content-length', `${bodyByteLen}`);
        }
        headStr = buildResponseHeadStr(
          this.#slot.responseStatus,
          responseHeaders,
          this.#slot.closeAfterFlush);
      }
      ArrayPrototypePush(this.#slot.chunks, Buffer.from(headStr + chunk));
      this.#slot.ready = true;
      this.#state.flushConnection(this.#slot.connection);
      return;
    }

    // Slow path: write() checks #ended, so keep it false until after the call.
    if (chunk !== undefined) this.write(chunk);
    this.#ended = true;
    if (!noBody &&
        findHeader(responseHeaders, 'content-length') === undefined &&
        findHeader(responseHeaders, 'transfer-encoding') === undefined) {
      ArrayPrototypePush(
        responseHeaders,
        'content-length',
        `${this.#slot.bodyLength}`);
    }
    ArrayPrototypeUnshift(
      this.#slot.chunks,
      serializeResponseHead(
        this.#slot.responseStatus,
        responseHeaders,
        this.#slot.closeAfterFlush));
    this.#slot.ready = true;
    this.#state.flushConnection(this.#slot.connection);
  }
}

class WebHttpContext {
  #state;
  #record;
  #slot;
  #request;
  #hijack;
  // Tracks which path has claimed body ownership to prevent double-consume.
  #bodyOwner = undefined;  // 'request' | 'hijack' | undefined

  constructor(state, record, slot) {
    this.#state = state;
    this.#record = record;
    this.#slot = slot;
  }

  get request() {
    if (this.#request !== undefined) return this.#request;
    const { Request } = lazyWebConstructors();
    const record = this.#record;
    const url = `http://${record.host}${record.url}`;
    const init = {
      __proto__: null,
      method: record.method,
      headers: getRequestHeaders(record),
    };
    if (record.body.length !== 0 &&
        record.method !== 'GET' &&
        record.method !== 'HEAD') {
      if (this.#bodyOwner === 'hijack') {
        throw new ERR_INVALID_STATE(
          'Request body is already being consumed via hijack()');
      }
      this.#bodyOwner = 'request';
      init.body = record.body.length === 1 ?
        record.body[0] :
        Buffer.concat(record.body, record.bodyLength);
      init.duplex = 'half';
    }
    return this.#request = new Request(url, init);
  }

  hijack() {
    if (this.#hijack !== undefined) return this.#hijack;
    if (this.#bodyOwner === 'request') {
      throw new ERR_INVALID_STATE(
        'Request body is already being consumed via ctx.request');
    }
    this.#bodyOwner = 'hijack';
    this.#slot.hijacked = true;
    return this.#hijack = new ProtocolWriter(
      this.#state, this.#record, this.#slot);
  }
}

function createRequestBody(chunks) {
  return new RequestBody(chunks);
}

class ConnectionState {
  constructor(state, handle) {
    this.state = state;
    this.handle = handle;
    this.buffer = kEmpty;
    this.options = state.options;
    this.parser = createRequestParser(this.options);
    this.nextSequence = 0;
    this.nextFlush = 0;
    this.slots = new SafeMap();
    this.closed = false;
    this.closeAfterWrites = false;
    this.destroying = false;
    this.pendingWrites = 0;
    this.headersComplete = false;
    this.requestStarted = 0;
    this.timeoutKind = kTimeoutNone;
    // Backpressure: when slots.size reaches maxInflight, already-parsed records
    // queue here (FIFO via a head cursor, no O(n) shifts) and reads are paused.
    // They dispatch as slots drain; reads resume once the queue empties.
    this.maxInflight = this.options.maxInflightRequests;
    this.pendingRecords = [];
    this.pendingHead = 0;
    this.readPaused = false;
    this.dispatchingPending = false;

    handle.onread = (nread, chunk) => this.onread(nread, chunk);
    handle.onwrite = (status) => this.onwrite(status);
    handle.ontimeout = () => this.onTimeout();
  }

  start() {
    const err = this.handle.startRead();
    if (err !== 0) this.destroy();
    else this.beginRequestDeadline();
  }

  destroy() {
    if (this.destroying) return;
    this.destroying = true;
    this.closed = true;
    this.clearTimeout();
    if (this.parser !== undefined) {
      this.parser.destroy();
      this.parser = undefined;
    }
    try {
      this.handle.close();
    } catch {
      // The native handle may already be closing.
    }
    this.state.deleteConnection(this);
  }

  onread(nread, chunk) {
    if (this.closed) return;
    if (nread > 0) {
      if (this.timeoutKind === kTimeoutKeepAlive) {
        this.beginRequestDeadline();
      }
      this.parse(chunk);
      return;
    }
    if (nread < 0) {
      this.closed = true;
      if (this.slots.size === 0) this.maybeDestroyAfterWrites();
    }
  }

  onTimeout() {
    if (this.destroying || this.closed) return;
    if (this.timeoutKind === kTimeoutKeepAlive) {
      // When both headersTimeout and requestTimeout are 0, beginRequestDeadline()
      // skips the stopTimeout() call to save a C++/JS crossing. The keepAlive
      // timer may then fire while a request is in flight. Guard: only destroy
      // when the connection is truly idle (no active slots).
      if (this.slots.size !== 0) return;
      this.destroy();
      return;
    }
    this.sendError(kStatusRequestTimeout, true);
  }

  onwrite(status) {
    if (this.pendingWrites > 0) this.pendingWrites--;
    if (status < 0) {
      this.destroy();
      return;
    }
    this.maybeDestroyAfterWrites();
    this.maybeBeginKeepAliveDeadline();
  }

  maybeDestroyAfterWrites() {
    if ((this.closeAfterWrites || this.closed) && this.pendingWrites === 0) {
      this.destroy();
    }
  }

  beginRequestDeadline() {
    this.headersComplete = false;
    const options = this.options;
    const headersTimeout = options.headersTimeout;
    const requestTimeout = options.requestTimeout;
    // Fast path: when no request-level timeouts are configured, skip all timer
    // operations. The keepAlive timer (if running) is guarded by the slots.size
    // check in onTimeout(), so it cannot destroy an active connection.
    if (headersTimeout === 0 && requestTimeout === 0) return;
    this.requestStarted = DateNow();
    this.armTimeout(minNonZero(headersTimeout, requestTimeout), kTimeoutRequest);
  }

  beginBodyDeadline() {
    if (this.headersComplete) return;
    this.headersComplete = true;

    const options = this.options;
    const requestTimeout = options.requestTimeout;
    if (requestTimeout === 0) {
      // Only stop a timer if headersTimeout armed one. When both are 0 no timer
      // was armed and the keepAlive timer (if any) must not be disturbed.
      if (options.headersTimeout !== 0) this.clearTimeout();
      return;
    }

    const remaining = requestTimeout - (DateNow() - this.requestStarted);
    if (remaining <= 0) {
      this.onTimeout();
    } else {
      this.armTimeout(remaining, kTimeoutRequest);
    }
  }

  maybeBeginKeepAliveDeadline() {
    // headersComplete means a request is mid-flight (headers parsed, body
    // pending), e.g. after a 100-continue write completes. The request/body
    // deadline governs that phase, so do not replace it with keep-alive.
    if (this.destroying || this.closed || this.closeAfterWrites ||
        this.pendingWrites !== 0 || this.slots.size !== 0 ||
        this.buffer.length !== 0 || this.headersComplete) {
      return;
    }
    this.armTimeout(this.options.keepAliveTimeout, kTimeoutKeepAlive);
  }

  armTimeout(timeout, kind) {
    if (timeout === 0 || this.destroying || this.closed) {
      this.clearTimeout();
      return;
    }
    this.timeoutKind = kind;
    this.handle.setTimeout(timeout);
  }

  clearTimeout() {
    if (this.timeoutKind === kTimeoutNone) return;
    this.timeoutKind = kTimeoutNone;
    this.handle.stopTimeout();
  }

  parse(input = kEmpty) {
    while (!this.closed && (this.buffer.length !== 0 || input.length !== 0)) {
      if (this.parser === undefined) {
        this.parser = createRequestParser(this.options);
      }

      const parser = this.parser;
      const prefix = this.buffer;
      const totalLength = prefix.length + input.length;
      const result = parser.parse(input, prefix);
      if (result.consumed > totalLength) {
        this.sendError(kStatusBadRequest, true);
        return;
      }
      this.buffer = this.remainingInput(prefix, input, result.consumed);
      input = kEmpty;

      const capped = this.dispatchRecords(result.records);

      if (result.errorStatus !== 0) {
        parser.destroy();
        this.parser = undefined;
        this.buffer = kEmpty;
        this.sendError(result.errorStatus, true);
        return;
      }

      // `Expect: 100-continue`: headers parsed, body pending. Send the interim
      // 100 response so the client proceeds. Reported once by the parser.
      if (result.expectContinue) {
        const err = this.handle.writev([kContinue]);
        if (err !== 0) {
          this.destroy();
          return;
        }
        this.pendingWrites++;
      }

      // Backpressure: the in-flight cap was reached and the remaining records
      // were queued. Reads are paused; maybeDispatchPending() resumes parsing
      // the buffered bytes once slots drain.
      if (capped) return;

      if (result.records.length !== 0) {
        // Clear the request-phase timer (headers or request timeout) now that
        // the message is fully parsed. Do not disturb the keepAlive timer.
        if (this.timeoutKind === kTimeoutRequest) this.clearTimeout();
        this.headersComplete = false;
        if (this.buffer.length !== 0) this.beginRequestDeadline();
        continue;
      }

      if (result.headersComplete) this.beginBodyDeadline();

      return;
    }
  }

  remainingInput(prefix, input, consumed) {
    const prefixLength = prefix.length;
    const inputLength = input.length;
    const totalLength = prefixLength + inputLength;
    if (consumed === totalLength) return kEmpty;
    if (consumed >= prefixLength) {
      return input.subarray(consumed - prefixLength);
    }
    if (inputLength === 0) return prefix.subarray(consumed);
    return Buffer.concat(
      [prefix.subarray(consumed), input],
      totalLength - consumed);
  }

  // Dispatch parsed records, respecting the in-flight cap. Records beyond the
  // cap are queued (FIFO) and dispatched later by maybeDispatchPending() as
  // slots drain. Returns true if the cap was reached and records were queued,
  // signalling the caller to stop parsing more buffered data.
  dispatchRecords(records) {
    for (let i = 0; i < records.length; i++) {
      if (this.slots.size >= this.maxInflight) {
        for (let j = i; j < records.length; j++) {
          ArrayPrototypePush(this.pendingRecords, records[j]);
        }
        this.pauseReads();
        return true;
      }
      this.state.dispatchRecord(this, records[i]);
    }
    return false;
  }

  pauseReads() {
    if (this.readPaused || this.destroying || this.closed) return;
    this.readPaused = true;
    this.handle.stopRead();
  }

  // Dispatch queued records as slots free up, then (once the queue is drained)
  // resume reads and parse any buffered bytes that were deferred while capped.
  // No-op on the common path (nothing queued, reads not paused) so it is safe
  // to call from flushConnection. The dispatchingPending guard makes the
  // reentrant call from a synchronous handler's flushConnection a no-op.
  maybeDispatchPending() {
    if ((this.pendingHead >= this.pendingRecords.length && !this.readPaused) ||
        this.dispatchingPending || this.closed || this.destroying) {
      return;
    }
    this.dispatchingPending = true;
    try {
      while (this.pendingHead < this.pendingRecords.length &&
             this.slots.size < this.maxInflight && !this.closed) {
        const record = this.pendingRecords[this.pendingHead++];
        this.state.dispatchRecord(this, record);
      }
      if (this.pendingHead >= this.pendingRecords.length &&
          !this.closed && !this.destroying) {
        this.pendingRecords = [];
        this.pendingHead = 0;
        if (this.readPaused && this.slots.size < this.maxInflight) {
          this.readPaused = false;
          this.handle.startRead();
        }
        // parse() may re-queue/re-pause; reentrant maybeDispatchPending no-ops.
        if (this.buffer.length !== 0 && this.slots.size < this.maxInflight) {
          this.parse();
        }
      }
    } finally {
      this.dispatchingPending = false;
    }
  }

  sendError(status, close) {
    this.clearTimeout();
    // Set closed before flushConnection so keepAlive and destroy checks see
    // the correct state even if a write completes synchronously during flush.
    if (close) this.closed = true;
    const slot = this.state.createSlot(this, close);
    ArrayPrototypePush(
      slot.chunks,
      serializeResponseHead(status, [
        'content-length', '0',
      ], close));
    slot.ready = true;
    this.state.flushConnection(this);
  }
}

// ServerState is not exposed on the public server instance. Connection and
// writer objects hold it so hot-path helpers do not become public methods.
class ServerState {
  #handler;
  #options;
  #connections;
  #handle;

  constructor(handler, options) {
    validateFunction(handler, 'handler');
    this.#handler = handler;
    this.#options = validateOptions(options);
    this.#connections = new SafeSet();
    this.#handle = undefined;
  }

  get options() { return this.#options; }

  listen(port, host) {
    // Validation is performed in WebHTTPServer.listen() before DNS resolution.
    if (this.#handle !== undefined) {
      throw new ERR_INVALID_STATE('Server is already listening');
    }

    const handle = new NativeWebHttpServer();
    handle.connectionConstructor = WebHttpConnection;
    handle.onconnection = (status, connection) => {
      if (status !== 0 || connection === undefined) return;
      const connectionState = new ConnectionState(this, connection);
      this.#connections.add(connectionState);
      connectionState.start();
    };

    try {
      handle.bind(host, port);
      handle.listen();
    } catch (err) {
      try {
        handle.close();
      } catch {
        // The native handle may already be closing.
      }
      throw err;
    }

    this.#handle = handle;
  }

  address() {
    const handle = this.#handle;
    if (handle === undefined) return null;
    const address = handle.address();
    if (typeof address === 'number') return null;
    return address;
  }

  close() {
    const handle = this.#handle;
    if (handle === undefined) return undefined;
    this.#handle = undefined;
    const { promise, resolve } = PromiseWithResolvers();
    handle.close(resolve);
    this.closeAllConnections();
    return promise;
  }

  // Force-close all active connections immediately. Does not close the
  // listening socket; the server can accept new connections after this call.
  closeAllConnections() {
    for (const connection of this.#connections) {
      connection.destroy();
    }
    this.#connections.clear();
  }

  deleteConnection(connection) {
    this.#connections.delete(connection);
  }

  async inject(request) {
    const { Request, Response } = lazyWebConstructors();
    if (!(request instanceof Request)) {
      throw new ERR_INVALID_ARG_TYPE('request', 'Request', request);
    }

    const body = await request.arrayBuffer();
    const url = new URL(request.url);
    const rawHeaders = [];
    for (const pair of request.headers) {
      ArrayPrototypePush(rawHeaders, pair[0], pair[1]);
    }

    const bodyChunks = body.byteLength === 0 ? [] : [Buffer.from(body)];
    const record = {
      __proto__: null,
      method: request.method,
      url: `${url.pathname}${url.search}`,
      rawHeaders,
      headers: undefined,
      host: request.headers.get('host') ?? url.host,
      hostCount: 1,
      hasExpect: false,
      hasUpgrade: false,
      body: bodyChunks,
      bodyLength: body.byteLength,
      bodySource: undefined,
      closeAfterResponse: false,
    };
    const slot = {
      __proto__: null,
      connection: null,
      sequence: 0,
      chunks: [],
      responseStatus: 200,
      responseHeaders: [],
      bodyLength: 0,
      ready: false,
      hijacked: false,
      closeAfterFlush: false,
    };
    const ctx = new WebHttpContext(this, record, slot);
    const result = await FunctionPrototypeCall(this.#handler, undefined, ctx);
    if (slot.hijacked) {
      if (!slot.ready) {
        throw new ERR_INVALID_STATE('Hijacked response was not ended');
      }
      const bodyChunks = [];
      // slot.chunks[0] is the serialized response head; skip it.
      for (let i = 1; i < slot.chunks.length; i++) {
        ArrayPrototypePush(bodyChunks, slot.chunks[i]);
      }
      // RFC 7230 section 3.3: HEAD responses must not include a message body.
      const body = bodyChunks.length === 0 || record.method === 'HEAD' ?
        null :
        Buffer.concat(bodyChunks, slot.bodyLength);
      return new Response(body, {
        __proto__: null,
        status: slot.responseStatus,
        headers: materializeFlatHeaderPairs(slot.responseHeaders),
      });
    }
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    throw new ERR_INVALID_ARG_TYPE('handler return value', 'Response', result);
  }

  createSlot(connection, closeAfterFlush) {
    const sequence = connection.nextSequence++;
    const slot = {
      __proto__: null,
      connection,
      sequence,
      chunks: [],
      responseStatus: 200,
      responseHeaders: [],
      bodyLength: 0,
      ready: false,
      hijacked: false,
      closeAfterFlush,
      // Streaming fields: used when the response body is a ReadableStream.
      // streamingState: null (not started) | 'started' | 'done'
      streamingState: null,
      bodyReader: null,
    };
    connection.slots.set(sequence, slot);
    return slot;
  }

  dispatchRecord(connection, record) {
    const slot = this.createSlot(connection, record.closeAfterResponse);
    const ctx = new WebHttpContext(this, record, slot);
    this.#runHandler(slot, record, ctx);
  }

  #runHandler(slot, record, ctx) {
    try {
      const response = FunctionPrototypeCall(this.#handler, undefined, ctx);
      if (isPromise(response)) {
        PromisePrototypeThen(
          response,
          (response) => this.#completeResponse(slot, record, response),
          (err) => this.#handlerError(slot, err));
        return;
      }
      this.#completeResponse(slot, record, response);
    } catch (err) {
      this.#handlerError(slot, err);
    }
  }

  #completeResponse(slot, record, response) {
    const { Response } = lazyWebConstructors();
    if (slot.hijacked) {
      return;
    }
    if (!(response instanceof Response)) {
      if (response === undefined) {
        response = new Response(null, { status: 204 });
      } else {
        this.#handlerError(
          slot,
          new ERR_INVALID_ARG_TYPE('handler return value', 'Response', response));
        return;
      }
    }

    const status = response.status;
    const statusText = response.statusText;
    const noBody = record.method === 'HEAD' || isForbiddenBodyStatus(status);
    const headers = [];
    for (const pair of response.headers) {
      appendHeaderPair(headers, pair[0], pair[1]);
    }

    if (noBody) {
      this.#finishWebResponse(slot, status, statusText, headers, kEmpty, true);
      return;
    }

    // Explicit null body (e.g. new Response(null)): send Content-Length: 0.
    if (response.body === null) {
      this.#finishWebResponse(slot, status, statusText, headers, kEmpty, false);
      return;
    }

    // If content-length is already set: buffer the body so we can send it
    // together with the headers in one writev call (no chunked framing).
    // Otherwise: stream the body with Transfer-Encoding: chunked so that
    // arbitrarily large or truly streaming bodies are handled correctly.
    if (findHeader(headers, 'content-length') !== undefined) {
      let body;
      try {
        body = response.arrayBuffer();
      } catch (err) {
        this.#handlerError(slot, err);
        return;
      }
      PromisePrototypeThen(
        body,
        (body) => this.#finishWebResponse(
          slot, status, statusText, headers, body, false),
        (err) => this.#handlerError(slot, err));
    } else {
      this.#startStreamResponse(
        slot, status, statusText, headers, response.body);
    }
  }

  #finishWebResponse(slot, status, statusText, headers, body, noBody) {
    const bodyBuffer = body === kEmpty ? kEmpty : Buffer.from(body);
    if (!noBody && findHeader(headers, 'content-length') === undefined) {
      ArrayPrototypePush(headers, 'content-length', `${bodyBuffer.length}`);
    }
    ArrayPrototypePush(
      slot.chunks,
      serializeResponseHead(status, headers, slot.closeAfterFlush, statusText));
    if (bodyBuffer.length !== 0) ArrayPrototypePush(slot.chunks, bodyBuffer);
    slot.ready = true;
    this.flushConnection(slot.connection);
  }

  // Begins a chunked streaming response. The response head is queued into the
  // slot's first chunk and the slot is marked ready so flushConnection can
  // detect it and start the async pump once the slot reaches the head of the
  // ordered response queue (pipelining correctness).
  #startStreamResponse(slot, status, statusText, headers, body) {
    if (findHeader(headers, 'transfer-encoding') === undefined) {
      ArrayPrototypePush(headers, 'transfer-encoding', 'chunked');
    }
    ArrayPrototypePush(
      slot.chunks,
      serializeResponseHead(status, headers, slot.closeAfterFlush, statusText));
    slot.bodyReader = body.getReader();
    slot.streamingState = null;
    slot.ready = true;
    this.flushConnection(slot.connection);
  }

  // Async pump that runs only after the slot reaches the head of the ordered
  // response queue. Sends headers, then each body chunk with chunked framing,
  // then the final terminator. Any write error destroys the connection.
  async #runStreamPump(slot, connection) {
    const reader = slot.bodyReader;

    // Send the response head (slot.chunks[0]).
    if (slot.chunks.length !== 0) {
      const err = connection.handle.writev(slot.chunks);
      slot.chunks = [];
      if (err !== 0) {
        connection.destroy();
        return;
      }
      connection.pendingWrites++;
    }

    try {
      while (!connection.destroying) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.byteLength > 0) {
          // Chunked framing: <hex-size>\r\n<data>\r\n
          const sizeStr = value.byteLength.toString(16);
          const chunkHead = Buffer.from(`${sizeStr}\r\n`);
          const err = connection.handle.writev([chunkHead, value, kChunkTrailer]);
          if (err !== 0) {
            connection.destroy();
            return;
          }
          connection.pendingWrites++;
        }
      }
      if (!connection.destroying) {
        const err = connection.handle.writev([kFinalChunk]);
        if (err !== 0) {
          connection.destroy();
          return;
        }
        connection.pendingWrites++;
      }
    } catch {
      if (!connection.destroying) connection.destroy();
      return;
    } finally {
      // releaseLock() throws if a read is still pending; the stream is being
      // torn down regardless, so the error is intentionally ignored.
      try {
        reader.releaseLock();
      } catch {
        // Intentionally empty.
      }
    }

    slot.streamingState = 'done';
    this.flushConnection(connection);
  }

  #handlerError(slot, err) {
    if (slot.hijacked) return;
    slot.chunks.length = 0;
    slot.closeAfterFlush = true;
    ArrayPrototypePush(
      slot.chunks,
      serializeResponseHead(
        kStatusInternalServerError,
        ['content-length', '0'],
        true));
    slot.ready = true;
    this.flushConnection(slot.connection);
    if (err !== undefined) triggerUncaughtException(err, false);
  }

  flushConnection(connection) {
    if (connection === null || connection.destroying) return;
    while (true) {
      const slot = connection.slots.get(connection.nextFlush);
      if (slot === undefined || !slot.ready) {
        // Queue head is caught up. If the connection is closing (client
        // half-close or a requested close), close once every queued response
        // has drained; not-yet-ready in-flight slots re-enter here when ready.
        if (connection.closed) {
          if (connection.slots.size === 0) {
            connection.closeAfterWrites = true;
            connection.maybeDestroyAfterWrites();
          }
        } else {
          // Dispatch any backpressure-queued records first (may create new
          // slots / reparse buffered bytes), then arm keep-alive only if the
          // connection is then truly idle.
          connection.maybeDispatchPending();
          connection.maybeBeginKeepAliveDeadline();
        }
        return;
      }

      // Streaming slot: pump must run to completion before advancing the queue.
      // This preserves pipelining response order even when one response streams
      // slowly while later fixed-body responses are already ready.
      if (slot.bodyReader !== null) {
        if (slot.streamingState === 'done') {
          // Pump finished - advance the queue and loop to the next slot.
          connection.slots.delete(connection.nextFlush);
          connection.nextFlush++;
          if (slot.closeAfterFlush) {
            connection.closeAfterWrites = true;
            connection.maybeDestroyAfterWrites();
            return;
          }
          continue;
        }
        if (slot.streamingState === null) {
          // First time this streaming slot reaches the head of the queue.
          slot.streamingState = 'started';
          // Guard against unhandled rejection; the pump handles all errors
          // internally and destroys the connection on failure.
          PromisePrototypeThen(
            this.#runStreamPump(slot, connection),
            undefined,
            () => { if (!connection.destroying) connection.destroy(); });
        }
        // Pump is running - return and wait for it to call flushConnection.
        return;
      }

      // Non-streaming slot: flush all chunks at once.
      connection.slots.delete(connection.nextFlush);
      connection.nextFlush++;
      if (slot.chunks.length !== 0) {
        const err = connection.handle.writev(slot.chunks);
        if (err !== 0) {
          connection.destroy();
          return;
        }
        connection.pendingWrites++;
      }
      // Only this slot's own close marker closes the connection here. A pending
      // connection.closed (e.g. a queued error after an in-flight request) keeps
      // draining ready slots and closes at the caught-up branch above, so a
      // queued error response is not dropped.
      if (slot.closeAfterFlush) {
        connection.closeAfterWrites = true;
        connection.maybeDestroyAfterWrites();
        return;
      }
    }
  }
}

class WebHTTPServer {
  #state;

  constructor(handler, options) {
    this.#state = new ServerState(handler, options);
  }

  async listen(port, host = kDefaultHost) {
    validatePort(port);
    validateString(host, 'host');
    // Resolve hostnames to IP addresses before binding. The native transport
    // only accepts numeric addresses (uv_ip4_addr / uv_ip6_addr).
    const resolvedHost = isNumericAddress(host) ?
      host :
      await lazyDnsLookup(host);
    this.#state.listen(port, resolvedHost);
    return this;
  }

  address() {
    return this.#state.address();
  }

  close() {
    return this.#state.close();
  }

  // Forcibly destroy all active connections. Matching legacy http.Server API.
  closeAllConnections() {
    this.#state.closeAllConnections();
  }

  async [SymbolAsyncDispose]() {
    const close = this.close();
    if (close !== undefined) await close;
  }

  inject(request) {
    return this.#state.inject(request);
  }
}

function createServer(handler, options) {
  return new WebHTTPServer(handler, options);
}

module.exports = ObjectFreeze({
  createServer,
});
