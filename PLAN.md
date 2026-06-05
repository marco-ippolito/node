<!--lint disable maximum-line-length prohibited-strings-->

# Web HTTP Server Plan

## Goal

Build an experimental, high-performance HTTP/1.1 server API named Web HTTP,
gated by `--experimental-web-http-server`.

The public module is `node:http/web`. It exports only `createServer`. Legacy
`node:http`, `_http_server`, `net.Server`, `IncomingMessage`,
`ServerResponse`, `EventEmitter`, and the existing C++ HTTP parser are not part
of this feature.

This file is authoritative. Re-read it after compaction/interruption and write
down every new API, flag, error, benchmark, or architecture decision here before
continuing.

## Public API

* The public specifier is scheme-only: `node:http/web`.
* Without `--experimental-web-http-server`, `node:http/web` is not visible to
  userland and behaves as an unknown built-in module.
* Without the flag, `module.builtinModules` must not list `node:http/web`.
* With `--experimental-web-http-server`, `node:http/web` resolves and exports
  `createServer`.
* With the flag:

  ```js
  import { createServer } from 'node:http/web';

  const server = createServer(async (ctx) => {
    const request = ctx.request;
    return new Response('Hello World');
  });

  await server.listen(3000);
  ```

* `createServer(handler[, options])` is the only entry point. Do not add a
  modern/mode parameter to legacy `createServer()`.
* Handler receives exactly one argument: `(ctx)`.
* `ctx.request` is a lazy getter that materializes and caches a Web `Request`
  only if user code asks for it.
* `ctx.hijack()` lazily returns protocol access, disables automatic `Response`
  handling, and must avoid Web `Request`/`Headers` construction when it is the
  first high-level API user code touches.
* `ctx` is the extension point for future per-exchange data. Do not add
  currently unused data to it.
* Hijack exposes `method`, `url`, `headers`, `body`, `writeHead()`, `write()`,
  and `end()`. It never exposes a raw socket.
* `server.inject(request)` accepts only a Web `Request` and returns
  `Promise<Response>`. Invalid input rejects at the promise boundary.
* Lifecycle API: promise-based `listen()`, synchronous `address()`, `close()`
  without a promise for no-op close, and async dispose. If an active libuv close
  needs completion reporting, `close()` may return that pending promise.
* Do not export `WebHTTPServer` publicly or from the internal module surface
  unless a concrete review-driven need appears.

## Core Discipline

* Treat this as Node.js core internals intended for maintainer review.
* No hacks, hidden workarounds, speculative utilities, or undocumented lifetime
  tricks. If uncertain and local code cannot answer it, ask.
* Before adding a helper/validator/utility, check existing Node internals.
* Use `internal/validators`, primordials, and internal utilities instead of
  open-coded validation or prototype-sensitive helpers.
* `primordials` generates uncurried prototype helpers such as
  `SetPrototypeAdd`, `SetPrototypeDelete`, and `SetPrototypeGetSize`; prefer
  those over direct `.add()`, `.delete()`, or `.size` access in internals.
* `lib/internal/per_context/primordials.js` exposes `uncurryThis` and generates
  helpers for prototype methods. When code needs `charCodeAt()`, `push()`,
  `slice()`, `toLowerCase()`, and similar built-in prototype methods, use the
  generated primordial helper instead of calling through the instance.
* Use internal errors from `internal/errors`; reuse where possible, add new
  internal errors only when this feature needs specific codes. Header/parser
  failures should reuse legacy-style `HPE_*` parser codes where possible;
  `ERR_WEB_HTTP_BODY_LIMIT` remains for the new configured request body limit.
* Error docs must include only errors that are truly new public surface. Before
  documenting/adding a Web HTTP error, check whether legacy HTTP already has a
  reusable internal error code.
* Use modern private class fields/properties for feature-local private state
  instead of symbols unless local Node patterns require otherwise.
* Comments are required for non-obvious invariants: JS/C++ ownership, parser
  lifetimes, queue ordering, backpressure, body materialization, and Web object
  laziness.
* Public documentation belongs in `doc/api/http.md`, not a new markdown file,
  unless Node documentation reviewers ask for a split. Match Node.js doc style.
* Tests must use the native `node:test` module.
* Rebuild after any `lib/` or `src/` edit before tests or benchmarks.
* Preferred rebuild command is `./configure --ninja && make`. Do not cap
  parallelism with `-j8`; let the project/default build settings drive it.
  In this workspace, prefix
  `PATH=/opt/homebrew/opt/python@3.14/bin:/opt/homebrew/bin:$PATH` so
  configure finds Python 3.14 and `make` finds Ninja.

## Performance Contract

Performance is an acceptance criterion. Comparable paths must be competitive
with or faster than legacy `node:http`; slower results are design problems to
investigate, not acceptable trade-offs.

Hot-path rules:

* No `EventEmitter`.
* No promise chains for parsing, pipelining, or response ordering.
* Promise-based public APIs remain boundary costs only.
* Do not return promises from lifecycle methods unless the operation genuinely
  needs asynchronous completion reporting. `close()` should avoid promise
  allocation when a synchronous/no-pending close result is sufficient.
* Synchronous handlers and immediately available `Response`s need a fast path
  without unnecessary `PromiseResolve()`/`.then()`.
* Asynchronous handlers attach one continuation at the boundary and re-enter a
  cheap ordered response queue.
* Pending response writes/streams attach one continuation at the ordered queue
  boundary. Do not build nested promise chains inside per-response helpers just
  to run finish bookkeeping.
* Use stable object shapes, private fields, counted loops, compact/sequential
  data, and lazy state. Avoid dynamic properties and array/object helper churn.
* Avoid JSON parsing in transport/parser/serialization. HTTP bodies are bytes;
  JSON belongs only to explicit body APIs such as `request.json()`.
* `BaseObject::FromJSObject()` is V8 wrapper unwrapping, not JSON conversion.
  Native callbacks should prefer native pointers already stored on uv handles
  or requests.
* Optimize boundary count first: coarse native notifications, batched writes,
  writev/scatter-gather, corking, and fewer C++/JS crossings.
* Native writes retain JS `Buffer`s through `uv_write()` completion; do not copy
  response bytes into native storage unless a documented staged step requires
  it.
* Native writes should retain generic `ArrayBufferView`s, not only Node
  `Buffer`s, so Web `Uint8Array` chunks can go to `uv_write()` without being
  copied back into Buffers.
* Inbound libuv reads should expose externally backed Buffers to JS when
  possible. Future passes should investigate pooled read buffers and direct
  wasm-memory reads.
* Native reads should borrow the legacy HTTP parser's reusable read-slab idea:
  use a per-connection 64 KiB slab for normal header-only reads, have the JS
  wasm parser report whether body callbacks retained views, then either reuse
  the slab immediately or transfer slab ownership to the Buffer finalizer. This
  keeps GET/header-heavy traffic allocation-light without copying request body
  chunks.
* Reusable native read slabs need explicit ownership: a small ref-counted
  control block keeps the connection owner reference plus any JS `Buffer`
  references. Header-only reads release only the JS reference and reuse the
  slab; body-retaining reads detach the connection reference and allocate a new
  slab.
* Native binding callbacks should not be passed as many positional arguments.
  Keep native method signatures compact so V8 has a better chance of optimizing
  the call sites.
* The native side may use modern C++20 features. Prefer reviewable C++20
  ownership and view types such as RAII helpers, `std::string_view`, and compact
  value structs when they make libuv lifetime and write-buffer retention clearer
  or faster.
* Request body chunks should preserve typed-array views over external read
  buffers. Do not copy with `new Uint8Array(view)` on the hot path.
* Async iterators/iterators are valid streaming candidates and may be adapted
  into Web streams at the API boundary.
* `hijack()` is the low-level fast path closest to legacy `node:http`; benchmark
  it separately from high-level Web `Request`/`Response`.
* High-level Web `Request`/`Response` throughput may trail legacy in the first
  pass, but the hijack path must beat legacy `node:http` on comparable simple
  workloads or the architecture needs more work.
* The `ctx`-only handler signature exists to protect hijack: do not construct
  public Web `Request`/`Headers` objects before user code has had a chance to
  call `ctx.hijack()`.
* Treat Web object creation as pull/deferred materialization. The connection
  must still read and parse through request headers before invoking the handler,
  but `ctx.request`, `ctx.request.headers`, Web body streams, and hijack body
  views should each be materialized only when their getters/methods are used.
* Request-body flow may be pull-shaped after headers: pause or limit libuv reads
  when neither `ctx.request.body` nor `ctx.hijack().body` is consumed and resume
  under explicit body demand/backpressure. Do not interpret pull-based as
  invoking handlers before HTTP/1.1 framing is known.
* Own-property enumerability is not part of the hijack contract. Keep writer
  shape fast; prototype getters are acceptable for lazy protocol views.
* A stable class/prototype `ctx` shape was tested to avoid a per-request
  `hijack()` closure/wrapper. In the current simple socket benchmarks it did
  not beat legacy and regressed one chunked hijack case, so do not keep that
  shape until a faster variant is proven.
* Benchmark freshness matters: if `out/Release/node` does not include the
  latest embedded JS bundle, socket benchmark numbers are stale and must not be
  used to judge the newest optimizations.
* Avoid unnecessary JS `Buffer` allocation on write paths. Prefer collecting
  adjacent string fragments and crossing into native once, with native retaining
  the encoded bytes until `uv_write()` completes.
* uWebSockets source reinforces the hot-path direction: compact per-socket
  state, explicit corking/batching around parser and handler work, string-view
  style writes, direct timeout/backpressure state, and native-owned queued write
  storage. Apply those lessons in Node-compatible pieces rather than copying
  its public architecture.
* A synchronous `uv_try_write()` fast path was tested after native string
  writes. In the current benchmark harness it did not move hijack ahead and may
  add syscall overhead under concurrency, so keep it deferred unless a future
  implementation proves faster on the target simple/hijack benchmarks.
* Do not blindly defer URL/header strings by retaining read-buffer views. The
  current native read slab is reusable only when JS reports that no body views
  were retained. Lazy URL/header views would also need to retain those bytes,
  which can pin a 64 KiB slab for a tiny request. A landable lazy metadata path
  needs compact request-owned token storage or wasm/native offsets with explicit
  lifetime, not accidental slab pinning.
* Legacy HTTP's parser stores URL/header fragments in C++ `StringPtr`s backed by
  an 8 KiB per-parser slab and flushes at most 32 header fields per JS callback.
  Web HTTP should copy that shape conceptually: compact token storage first,
  one complete-record callback, and string/Web-object materialization only when
  user code touches metadata.
* The biggest parser copy to remove is `currentBuffer.set(chunk)` before
  `llhttp_execute()`. Investigate a C++/wasm bridge where libuv reads into a
  wasm linear-memory parse slab, or into another parser-readable buffer, so JS
  does not copy every native read chunk into wasm memory.
* Per-connection JS timers should not be the final high-concurrency design.
  Legacy HTTP tracks parser activity and scans connection deadlines; Web HTTP
  should consider native deadline tracking or a compact JS/native timer wheel
  for headers/request/keep-alive timeouts.

## Architecture

* Implement JS orchestration in `lib/internal/http_web_server.js`.
* Implement transport from scratch on libuv. Do not use `net`, `_http_server`,
  Node's existing TCPWrap/net userland stack, or Node's C++ HTTP parser.
* Expose only an internal opaque native transport binding to JS. Register the
  native `web_http_server` binding in Node's built-in binding list.
* C++ owns libuv event loop integration, connection lifetime, native
  backpressure/write completion, and cheap per-connection state.
* JS owns user handler invocation, Web API materialization, response
  serialization, ordered slots, and wasm parser coordination.
* Use coarse C++ -> JS inbound byte delivery. Parser callbacks stay on the
  cheaper JS/wasm side.
* Handler invocation happens after request-line/header parse, using a small
  stable `ctx` object. `ctx` owns the parsed record and exposes lazy getters.
  First access to `ctx.request` builds the public Web `Request`; first access to
  `ctx.hijack()` builds the protocol writer/view and suppresses automatic
  `Response` serialization.
* Use wasm `llhttp` generated from top-level `deps/llhttp`; do not copy
  Undici's artifact.
* Do not depend on `internalBinding('http_parser')`, even for constants. Method
  names must come from the wasm llhttp artifact used by Web HTTP.
* Cache method names in JS after first decoding
  `llhttp.llhttp_method_name(method)` so common methods do not repeatedly pay
  C-string conversion.
* Keep llhttp's numeric method code on network request records and decode the
  method string only when user code or high-level response handling reads it.
  CONNECT/deferred handling should use the numeric llhttp code on the network
  path so hijack handlers that never read `method` avoid C-string decoding.
* Keep parser record/header/body views lazy. Capture cheap common metadata
  directly, such as `Host`, while heavier maps/Web `Headers` are lazy.
* Host detection should use a cheap ASCII token comparison. Do not lowercase
  every header field on the parser hot path only to discover `Host`.
* Avoid `Buffer.concat()` when a token arrives in one contiguous fragment.
* Header token assembly should use scalar-first storage and allocate arrays
  only for fragmented field/value tokens.
* URL token assembly should follow the same scalar-first rule so the common
  contiguous URL path does not allocate an array per request.
* Direct URL/header token decoding from the current read buffer was tested and
  reverted. In this workspace, `FastBuffer` token views plus `.toString()` were
  faster than `utf8Slice(start, end)` despite the extra tiny object allocation.
* Parsed network request records now copy URL bytes into request-owned Buffer
  storage and decode the URL string only when `record.url` is read. This avoids
  retaining mutable views into the reusable native read slab while still moving
  URL string materialization out of metadata-free hijack handlers. This is a
  staged compromise until compact native/wasm token storage removes the copy.
* Request body slots are lazy. Do not allocate Web body bookkeeping for GET,
  HEAD, hijack, or metadata-only handlers unless body bytes arrive or
  `record.body` is accessed.
* A future body path should be demand-driven where possible: hold parsed body
  chunks as typed-array views, expose them through `ctx.request` or
  `ctx.hijack().body` only on access, and coordinate uv read pause/resume with
  body consumption and response backpressure.
* Reuse/reset parser instances if benchmarks show allocation churn.
* Native read EOF is distinct from transport close. A client half-close after a
  complete request must still allow queued responses to drain in order.
* Ordered pipelined responses use per-connection response slots and increasing
  sequence numbers, not chained promises.
* Backpressure is native write readiness/high-water state plus minimal JS
  resume, not per-chunk promises.
* Add corking/batching inspired by legacy `OutgoingMessage` and
  uNetworking/uWebSockets: batch sync handler writes, combine headers with the
  first chunk, track offsets/native queue size, and avoid Web objects on the
  hijack path.
* `ProtocolWriter` should batch adjacent string writes and hand strings to the
  native transport when possible, while preserving typed-array chunks without
  copying. The native transport may encode strings into request-owned storage so
  JS does not allocate short-lived `Buffer`s for headers and hijack output.
* Chunked response framing should cache common chunk-size header buffers.
  Fixed string bodies may serialize head, chunk framing, and body into one
  `Buffer` because the string must be encoded anyway; fixed typed-array bodies
  stay scatter-gather/zero-copy.
* Fixed response serialization may reuse Undici body-state `length` and direct
  `HeadersList.headersMap` lookups only if an existing/upstreamable internal
  accessor is available. Do not carry a local `deps/undici` patch for this.
* First native transport pass may bind default `0.0.0.0` and numeric hosts
  directly. Hostname resolution must be added explicitly without `net`.

## Web Constructors

* Reuse `internal/deps/undici/undici` for `Headers`, `Request`, and `Response`.
* `createServer()` is the only exported factory. After argument validation it
  lazily initializes those constructor references once and caches them for all
  server, inject, and network paths.
* Do not call repeated lazy constructor getters from hot helpers.
* Do not share a global `Headers` instance; `Headers` is mutable and
  per-request/per-response.
* Do not patch `deps/undici` for Web HTTP. Any access to Undici internals must
  come from an existing Node/Undici internal surface, or this feature must use
  public Web `Response` APIs until an upstreamable internal accessor exists.
* Avoid private-field guessing on Web `Response`. If no existing accessor can
  expose fixed body/header state, fixed-body fast paths must be implemented
  elsewhere or deferred.
* The network `Request` URL builder must not do hidden `Headers` work. Capture
  `Host` during parsing, use that captured value when materializing a Web
  `Request`, and do not support a hostless HTTP/1.0 fallback.
* Direct filesystem require of `deps/undici/src/lib/web/fetch/request` exposes
  `makeRequest()` and `fromInnerRequest()`, but creates a second `Request`
  class that is distinct from Node's bundled/global Web `Request`. Do not use
  that duplicate class for public handler arguments. A landable fast inner
  `Request` path needs an accessor from the bundled Undici surface or a
  coordinated embedded-deps build change that preserves Web class identity.
* When using public `Request`, pass request headers as array pairs instead of
  first constructing a `Headers` object; this preserves duplicate header
  behavior and avoids one Web `Headers` allocation/copy step.
* Keep public `Request` inputs cheap. Use simple string concatenation for the
  common `http://` + `Host` + origin-form URL construction path. Do not keep
  pre-sized/holey header-pair arrays unless benchmarks prove they win.
* Undici's public `Request` constructor is intentionally expensive: Web IDL
  conversion, URL parsing, header normalization/fill, body extraction, and
  AbortSignal wiring. The internal `makeRequest()`/`fromInnerRequest()` shape is
  closer to what Web HTTP needs, but using it by requiring files from
  `deps/undici/src` creates duplicate public classes. A fast high-level path
  needs an upstreamable accessor from the bundled/global Undici surface that
  preserves `Request` identity while accepting a prepared `HeadersList`/inner
  request.
* Undici's client-side `Pool` is not directly reusable for server request
  handling. Relevant lessons are fixed-size queue chunks, compact queue indices,
  cached sorted header arrays in `HeadersList`, and direct handler pause/resume
  rather than promise-heavy flow control.

## HTTP/1.1 Scope

Implement v1:

* strict HTTP/1.1 only; reject older HTTP versions before user handlers;
* strict means Web HTTP should not inherit legacy compatibility leniency for
  obsolete protocol versions; optimize for HTTP/1.1 correctness and speed;
* content-length and chunked request bodies;
* keep-alive and `Connection: close`;
* pipelined request parsing;
* concurrent handler execution with ordered response writes;
* streamed Web `Response` bodies with backpressure;
* chunked responses when content length is unknown;
* no-body handling for `HEAD`, `204`, `205`, `304`, and informational statuses;
* malformed request handling with HTTP error responses and close when required;
* handler errors before hijack send `500` and close.

Defaults/options:

* Fastify-inspired defaults: `bodyLimit` 1 MiB, `keepAliveTimeout` 72s,
  `requestTimeout` 0 unless configured.
* Support `bodyLimit`, `headersTimeout`, `requestTimeout`,
  `keepAliveTimeout`, and `maxHeaderSize`.
* When `headersTimeout` and `requestTimeout` are both non-zero, validate
  `headersTimeout <= requestTimeout`, matching legacy HTTP.
* Legacy HTTP/1 server source (`lib/_http_server.js`,
  `src/node_http_parser.cc`, and top-level `deps/llhttp`) has reusable
  header-limit and parser error behavior, but no configured request body byte
  limit equivalent to Web HTTP's `bodyLimit`. Keep the new internal
  `ERR_WEB_HTTP_BODY_LIMIT` unless a future legacy-compatible error appears.

Deferred: CONNECT, Upgrade/WebSocket, trailers, and `Expect: 100-continue`
unless explicitly accepted into v1.

Runtime errors:

* No `clientError`, raw socket, `onError`, or generic runtime error dispatch in
  v1.
* `listen()` rejects for listen failures.
* `close()` returns `undefined` for a no-op close and returns a promise only
  when an active libuv close completion must be reported.
* `inject()` rejects for injection/response conversion failures.
* Malformed network requests receive the appropriate HTTP error response.
* Handler errors before hijack send `500` and close.

## Legacy Lessons To Mine

Study and copy lessons from `lib/_http_server.js`, `lib/_http_common.js`,
`lib/_http_incoming.js`, `lib/_http_outgoing.js`,
`src/node_http_parser.cc`, and `test/parallel/test-http-*`; do not copy their
public architecture.

Important legacy lessons:

* Break parser/request/connection references after completion/close.
* Preserve inbound byte ownership when callbacks reference read-buffer slices.
* Make parser close/free behavior explicit after errors, EOF, and close.
* Separate header timeout, request timeout, keep-alive idle timeout, and
  close/drain sequencing.
* Avoid deadline underflow and track active vs idle parser/connection state.
* Link backpressure with pipelining: queued responses, unread request bodies,
  and slow streams cannot flood memory or reorder writes.
* Response edge cases: no body for no-body statuses, correct chunked framing,
  no chunk terminator leakage, close when framing cannot delimit a message.
* Request-smuggling defenses: missing HTTP/1.1 `Host`, invalid header bytes,
  invalid separators, overflow, conflicting/malformed `Content-Length`,
  `Transfer-Encoding` conflicts, repeated/malformed chunked encoding, chunk
  extension limits, CR/LF edge cases, and data after close.
* Web-specific header tests are required for duplicates, `Set-Cookie`,
  `Cookie`, casing/raw hijack data, and lazy Web `Headers` normalization.

## Tests

Split tests into small `node:test` files before broad feature expansion:

* `test-http-web-gating.js`: flag gating, module shape, warnings.
* `test-http-web-api.js`: overloads, option validation, lifecycle, dispose,
  address.
* `test-http-web-inject.js`: Web `Request` validation, response conversion,
  errors, body streaming.
* `test-http-web-request.js`: lazy `ctx.request`, URL, method, headers, body,
  duplicates, host validation, and no Web `Request` construction on hijack.
* `test-http-web-response.js`: serialization, status text, headers, fixed
  length, chunked, no-body statuses.
* `test-http-web-hijack.js`: `ctx.hijack()`, protocol data, writer methods, no
  socket, and no Web `Request`/`Headers` construction when hijack is first.
* `test-http-web-parser.js`: content-length, chunked, fragmented input,
  pipelining, EOF, reset.
* `test-http-web-malformed.js`: 400/413/431, close behavior, smuggling, invalid
  CR/LF/header cases.
* `test-http-web-keepalive.js`: `Connection`, idle timeout, close, HTTP/1.1
  defaults.
* `test-http-web-close.js`: active accepted connections, idle keep-alive
  connections, and close-promise completion.
* `test-http-web-pipeline.js`: concurrent handlers and ordered writes.
* `test-http-web-backpressure.js`: slow client, streamed response, drain,
  parser pause/resume.
* `test-http-web-timeouts.js`: headers, request, keep-alive, half-close drain.
* `test-http-web-limits.js`: `bodyLimit`, `maxHeaderSize`, validation.
* `test-http-web-permission.js`: listen permission checks and loopback
  permissions. Run separately from broad `--allow-net` batches.
* `test-http-web-deferred.js`: deterministic unsupported behavior for deferred
  protocol features.

Tests that open sockets must grant network permission explicitly instead of
weakening native `kNet` permission checks.

## Benchmarks

Benchmarks must use the existing Node benchmark harness and mirror legacy
workloads fairly.

* Keep files simple and close to existing shapes.
* Do not use a mixed legacy/Web `implementation` axis for simple throughput.
  Mirror files instead: `simple.js` vs `web-simple.js`,
  `bench-parser.js` vs `web-parser.js`.
* Bench fixtures must not use `async` handlers, promises, WHATWG URL parsing,
  or stream adapters unless measuring those costs.
* Add a separate `web-hijack-simple.js` benchmark using raw hijack writer
  methods. Do not use it to hide high-level Web API overhead.
* Parser benchmarks must state/equalize semantic differences between legacy
  C++ parser and Web HTTP JS/wasm parser wrapper.
* Cover fixed string/Buffer bodies, unknown-length chunked bodies, echo bodies,
  small/large responses, keep-alive, pipelining, backpressure, and concurrency.
* Reuse `benchmark/http/simple.js`,
  `benchmark/fixtures/simple-http-server.js`,
  `benchmark/http/bench-parser.js`, and `benchmark/_http-benchmarkers.js`.
* Benchmark reports need throughput plus enough configuration to reproduce.

Latest focused snapshot, `duration=2 c=50 len=4 chunks=1`, rebuilt
2026-06-03 after native read slabs, native string writes, strict HTTP/1.1,
array-pair public `Request` headers, and reverted `uv_try_write()` experiment:

* Tests: `./node --test test/parallel/test-http-web-*.js` passes 32/32 with
  loopback permissions.
* Parser-only: legacy `1,506,490`, Web wrapper `546,646` parses/s.
* Fixed length bytes/buffer: legacy `33,491`/`35,365`, Web high-level
  `28,809`/`28,404`, Web hijack `34,557`/`34,267` req/s.
* Chunked bytes/buffer: legacy `33,558`/`34,302`, Web high-level
  `26,934`/`27,405`, Web hijack `33,512`/`33,345` req/s.
* Current state: hijack is close and can beat legacy on the fixed bytes case,
  but still does not beat legacy across all comparable simple paths. Next
  target is reducing mandatory public `Request` construction/parser cost while
  preserving Node's bundled/global Web class identity.

Fresh short snapshot after active connection tracking and parser retained-slab
error fix, rebuilt 2026-06-03:

* Tests: `./node --test test/parallel/test-http-web-*.js` passes 37/37 with
  loopback permissions.
* Fixed length bytes: legacy `32,611`, Web hijack `31,787` req/s.
* Fixed length buffer: legacy `34,500`, Web hijack `32,599` req/s.
* Current state: hijack is behind legacy in this rebuilt short run. The next
  performance pass should attack mandatory `Request` construction on hijack
  handlers and the wasm input copy before tuning response writer details.

Parser investigation snapshot, rebuilt 2026-06-03:

* `./node benchmark/http/bench-parser.js len=4 n=1000000`: legacy
  `923,785` parses/s.
* `./node benchmark/http/web-parser.js len=4 n=1000000`: Web wrapper
  `404,280` parses/s.
* `./node benchmark/http/bench-parser.js len=32 n=500000`: legacy
  `368,724` parses/s.
* `./node benchmark/http/web-parser.js len=32 n=500000`: Web wrapper
  `87,968` parses/s.
* Ratio worsens as header count grows. The dominant gap is not just wasm
  execution. Legacy Node feeds the input `ArrayBufferView` directly to native
  llhttp, stores URL/header pieces in C++ `StringPtr` slabs, and calls JS
  mostly at header-complete/message-complete. Web HTTP currently copies each
  input chunk into wasm memory, then imports back into JS for URL, every header
  field, every header value, bodies, headers-complete, and message-complete.
* uWebSockets reinforces the same architecture lesson: parse over a
  post-padded contiguous buffer, keep method/url/headers as views, use fixed
  per-request header storage plus a fallback buffer only for fragmentation,
  lowercase field names in-place, use compact membership tests for hot headers,
  and batch/cork writes around handler execution.
* Next parser architecture target: keep wasm, but redesign the generated
  callback surface so token offsets/lengths are batched and pulled by JS once
  per complete message, or otherwise stored in wasm/native-owned compact
  request records. Per-token wasm->JS callbacks will not beat legacy on
  header-heavy traffic.

Post parser-record cleanup snapshot, rebuilt 2026-06-03:

* Tests: `./node --test test/parallel/test-http-web-*.js` passes 38/38 with
  loopback permissions.
* Web parser `len=4 n=1000000`: `571,618` parses/s, up from `404,280`.
* Web parser `len=32 n=500000`: `102,058` parses/s, up from `87,968`.
* Fixed length bytes: legacy `34,400`, Web hijack `35,945` req/s.
* Fixed length buffer: legacy `33,818`, Web hijack `34,751` req/s.
* Chunked bytes: legacy `31,440`, Web hijack `32,366` req/s.
* Chunked buffer: legacy `33,389`, Web hijack `32,487` req/s.
* Current state: the stable parser record materially improved parser
  throughput and Web hijack now wins most short simple cases, but chunked
  Buffer remains behind. Do not claim the performance gate is met until longer
  and broader benchmark runs prove all comparable hijack cases beat legacy.

Post hijack writer validation snapshot, rebuilt 2026-06-03:

* Tests: `./node --test test/parallel/test-http-web-*.js` passes 39/39 with
  loopback permissions.
* `internal/http/validators` is embedded and reachable with `--expose-internals`.
* Fixed length bytes sanity run: legacy `32,175`, Web hijack `32,407` req/s.
* Chunked buffer sanity runs were noisy: legacy `33,119`; Web hijack sampled
  `30,696` then `34,587` req/s. Treat this as inconclusive and use longer
  benchmark runs before making a performance claim.

Post `ctx`-only lazy request snapshot, rebuilt 2026-06-05:

* Tests: `./node --test test/parallel/test-http-web-*.js` passes 39/39 with
  loopback permissions.
* Handler signature is now `createServer((ctx) => ...)`; `ctx.request`
  materializes the public Web `Request` only on access, and hijack handlers no
  longer pay that construction cost before choosing `ctx.hijack()`.
* `duration=5 len=4 chunks=1 c=50` fixed bytes: legacy `92,516`, Web hijack
  `96,638`, Web high-level `69,828` req/s.
* `duration=5 len=4 chunks=1 c=50` fixed buffer: legacy `92,697`, Web hijack
  `93,294` req/s.
* `duration=5 len=4 chunks=1 c=50` chunked bytes: legacy `91,979`, Web hijack
  `97,006` req/s.
* `duration=5 len=4 chunks=1 c=50` chunked buffer: legacy `91,596`, Web hijack
  `95,223` req/s.
* `duration=5 len=4 chunks=1 c=500` fixed bytes: legacy `93,648`, Web hijack
  `98,600` req/s.
* `duration=5 len=4 chunks=1 c=500` chunked bytes: legacy `86,407`, Web hijack
  `97,312` req/s.
* Current state: the ctx-only lazy materialization change moves hijack ahead of
  legacy on these focused simple socket runs. This is encouraging but not yet
  the full performance gate: repeat longer runs, cover the full simple matrix,
  large bodies, pipelining, backpressure, and parser-only before claiming the
  feature is faster overall.

High-level Web request snapshot, same rebuild and benchmark shape:

* `duration=5 len=4 chunks=1 c=50` fixed bytes: legacy `92,516`, Web high-level
  `69,828` req/s, about `24.5%` lower throughput.
* `duration=5 len=4 chunks=1 c=50` fixed buffer: legacy `92,697`, Web
  high-level `75,136` req/s, about `18.9%` lower throughput.
* `duration=5 len=4 chunks=1 c=50` chunked bytes: legacy `91,979`, Web
  high-level `71,512` req/s, about `22.3%` lower throughput.
* `duration=5 len=4 chunks=1 c=50` chunked buffer: legacy `91,596`, Web
  high-level `67,354` req/s, about `26.5%` lower throughput.
* `duration=5 len=4 chunks=1 c=500` fixed bytes: legacy `93,648`, Web
  high-level `71,967` req/s, about `23.2%` lower throughput.
* `duration=5 len=4 chunks=1 c=500` chunked bytes: legacy `86,407`, Web
  high-level `69,409` req/s, about `19.7%` lower throughput.
* Current state: high-level Web is consistently slower on tiny simple responses.
  That is acceptable only if documented as Web API cost and if hijack remains
  faster. The high-level path needs an internal Undici construction/accessor
  story plus fixed-body `Response` fast paths before it can compete with legacy.

Post lazy method-name snapshot, rebuilt 2026-06-05:

* Tests: `./node --test test/parallel/test-http-web-*.js` passes 39/39 with
  loopback permissions.
* Network request records now keep the llhttp numeric method code and expose
  `record.method` through a lazy getter. `ctx.hijack()` no longer copies
  `method` or `url` onto the writer as own properties, and CONNECT detection on
  parsed network records uses the numeric llhttp `HTTP_CONNECT` code.
* `duration=5 len=4 chunks=1 c=50` fixed bytes Web hijack: `95,198` req/s.
* `duration=5 len=4 chunks=1 c=50` chunked bytes Web hijack: `97,189` req/s.
* `duration=5 len=4 chunks=1 c=500` fixed bytes Web hijack: `98,956` req/s.
* `duration=5 len=4 chunks=1 c=500` chunked bytes Web hijack sampled
  `94,699` then `96,084` req/s.
* Web parser `len=4 n=1000000`: `573,873` parses/s, effectively flat versus
  the prior `571,618`. This confirms method laziness is the right pull-based
  shape but not the dominant parser bottleneck.
* Current state: hijack remains ahead of the latest focused legacy baselines in
  these samples, but the next meaningful win is still removing wasm input copy
  and batching parser token callbacks.

Post lazy URL string snapshot, rebuilt 2026-06-05:

* Tests: `./node --test test/parallel/test-http-web-*.js` passes 39/39 with
  loopback permissions.
* Network request records now keep request-owned URL bytes and decode
  `record.url` lazily. This avoids retaining views into the reusable native
  read slab; the tradeoff is one small URL byte copy until parser token storage
  moves native/wasm-side.
* Web parser `len=4 n=1000000`: `575,217` parses/s, slightly above the prior
  `573,873` sample but still effectively flat. URL laziness is not the
  dominant parser bottleneck.
* `duration=5 len=4 chunks=1 c=50` fixed bytes: legacy `92,850`, Web hijack
  `98,456` req/s.
* `duration=5 len=4 chunks=1 c=50` chunked bytes Web hijack: `97,439` req/s.
* `duration=5 len=4 chunks=1 c=500` fixed bytes Web hijack: `96,818` req/s.
* `duration=5 len=4 chunks=1 c=500` chunked bytes: legacy `93,400`, Web hijack
  `97,011` req/s.
* Current state: URL string decoding is now pull-based and the focused hijack
  cases remain ahead of fresh legacy samples where measured. The parser gap
  still requires removing wasm input copy and batching token callbacks.

## Maintainer Review Findings

Current staged code is not landable yet. Treat these as blocking review notes,
not polish:

* P0: wasm parsing still copies each native read chunk into wasm memory before
  `llhttp_execute()`. The native read slab reduces JS `Buffer` allocation but
  does not remove the parser copy. The parser benchmark gap remains a design
  problem.
* P0: wasm parser callbacks still cross into JS for URL/header field/header
  value/body/header-complete/message-complete. Legacy HTTP batches URL/header
  tokens in C++ and calls JS mostly with complete header arrays. Web HTTP needs
  a batched request-record callback or compact token table before header-heavy
  performance can be expected to beat legacy.
* P0: high-level Web `Request` construction uses public Undici constructors and
  is about 19-27% slower than legacy on focused tiny-response benchmarks. A
  fast path must preserve global `Request` identity while avoiding public
  constructor conversion work.
* P0: rejected headers must stop parser progress immediately. A 400/505
  decision in the JS server cannot let llhttp continue parsing body or
  pipelined bytes after the connection has been marked closed.
* P1: `headersTimeout` currently protects only the first request on a
  keep-alive connection. After an idle keep-alive response, the next partial
  request must get a fresh header deadline.
* P1: server `close()` still needs pending streamed-response cleanup tests.
* P1: native `WebHTTPConnection` deletion on `uv_close()` must be documented
  and guarded against JS async continuations that may still hold the opaque
  connection wrapper.
* P1: high-level `Response` serialization always goes through async iterator
  machinery. Fixed/known-length bodies need a separate fast path, or the docs
  and benchmark expectations must call out that high-level Web is not yet
  competitive.
* P1: avoid holey arrays and unprimordialized globals in internal hot paths.
  A pre-sized `new Array()` header-pair experiment regressed simple benchmarks
  and should not stay without proof.
* P1: test coverage is below the plan. Add backpressure/slow-client tests,
  second-request header timeout tests, close-with-active-connection tests,
  smuggling tests, duplicate header tests, and `Set-Cookie`/`Cookie` cases.
* P2: `ProtocolWriter.writeHead()` validation is covered, but the new narrow
  internal validator helper should be reviewed for possible reuse by legacy
  HTTP before landing.
* P2: docs need Node style cleanup before review:
  correct error YAML, and no behavior claims that are not implemented and
  covered by tests.
* P2: wasm artifact generation needs reproducibility cleanup. Avoid shell
  string command construction in the Docker path, and make optional
  optimization differences explicit.

Cleanup already applied after this review:

* Rejected headers now return an error signal to wasm llhttp so parser progress
  stops after Web HTTP sends 400/505 and marks the connection closed.
* The header-pair `new Array()` experiment was reverted to avoid holey arrays
  in the hot public `Request` construction path.
* `headersTimeout` is re-armed for the next keep-alive request and no longer
  resets on every byte of an incomplete header.
* The attempted `ProtocolWriter.writeHead()` validator reuse was backed out
  because it introduced a hidden dependency on legacy HTTP internals and the
  legacy parser binding.
* Server close now tracks accepted connection states, destroys them on close,
  and resolves the close promise only after the listening handle and tracked
  connections have closed. Tracking uses generated primordial Set helpers.
* Added close lifecycle tests for accepted idle connections and idle
  keep-alive connections after a response.
* Added a close lifecycle test for a pending handler that resolves after the
  native connection has closed, guarding JS continuation/native lifetime
  cleanup.
* Parser error paths now preserve the retained read-buffer signal. If body
  bytes were queued before a parse/body-limit error, JS returns that retention
  bit to native so the reusable read slab is not recycled while Web stream
  views may still exist.
* Feature-local `SafeMap`/`SafeSet` operations now use generated uncurried
  primordial helpers on the hot/internal paths.
* Parser request records now use a stable class with prototype/private-field
  lazy accessors instead of allocating per-request getter closures.
* Duplicate HTTP/1.1 `Host` headers are now rejected before user handlers and
  covered by malformed-request tests.
* Added `internal/http/validators` as a narrow dependency-light helper for
  HTTP token, header value, and status code validation. Web HTTP hijack writer
  uses it instead of importing `_http_outgoing`/`_http_common`, so it reuses
  legacy internal error codes without loading streams or the legacy parser
  binding.
* `ProtocolWriter.writeHead()` now validates status codes, header names,
  header values, and odd flat header arrays before buffering protocol bytes.
  It also supports legacy-style flat header arrays for low-level writer
  ergonomics.
* The narrow HTTP validator helper now uses generated primordial prototype
  helpers instead of instance method calls for token scanning.
* Implementation, tests, benchmarks, and docs were migrated to the
  `createServer((ctx) => ...)` signature. Hijack handlers can now avoid public
  Web `Request` construction unless `ctx.request` is accessed.
* Parser records now decode method names lazily. The network path uses the
  numeric llhttp CONNECT code for deferred CONNECT handling, preserving inject's
  string fallback while avoiding mandatory method string creation for normal
  hijack handlers.
* Parser records now decode URL strings lazily from request-owned URL bytes.
  The implementation intentionally copies only the URL token bytes so lazy URL
  access does not retain or observe mutations of the reusable native read slab.

## References

* Fastify defaults: <https://fastify.dev/docs/v5.5.x/Reference/Server/>
* Undici wasm/backpressure inspiration: <https://github.com/nodejs/undici>
* uNetworking/uWebSockets transport inspiration:
  <https://github.com/uNetworking/uWebSockets>
* JavaScript optimization notes: <https://romgrk.com/posts/optimizing-javascript>
