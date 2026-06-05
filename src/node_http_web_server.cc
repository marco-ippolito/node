#include "base_object-inl.h"
#include "env-inl.h"
#include "node_buffer.h"
#include "node_errors.h"
#include "node_external_reference.h"
#include "node_sockaddr-inl.h"
#include "permission/permission.h"
#include "util-inl.h"
#include "uv.h"

#include <memory>
#include <string>
#include <vector>

namespace node {
namespace http_web_server {

using errors::TryCatchScope;
using v8::Array;
using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::BackingStore;
using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::HandleScope;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::MaybeLocal;
using v8::Object;
using v8::Value;

constexpr int kBacklog = 511;
constexpr size_t kReadSlabSize = 64 * 1024;
constexpr size_t kWriteHighWaterMark = 64 * 1024;

// This binding is intentionally below node:net/TCPWrap. It owns raw uv_tcp_t
// handles and passes coarse byte chunks to JS, where the wasm llhttp parser
// runs without per-token C++/JS callbacks.
class WebHTTPConnection;

struct ReadBuffer final {
  explicit ReadBuffer(size_t capacity)
      : data(new char[capacity]), capacity(capacity) {}

  char* data;
  size_t capacity;
  size_t refs = 1;  // Connection owner reference.
  bool detached = false;
};

void RetainReadBuffer(ReadBuffer* buffer) {
  buffer->refs++;
}

void ReleaseReadBuffer(ReadBuffer* buffer) {
  if (--buffer->refs == 0) {
    delete[] buffer->data;
    delete buffer;
  }
}

void FreeReadBuffer(char* data, void* hint) {
  ReleaseReadBuffer(static_cast<ReadBuffer*>(hint));
}

class WriteRequest final {
 public:
  WriteRequest(WebHTTPConnection* connection,
               Isolate* isolate,
               Local<Value> buffer);
  WriteRequest(WebHTTPConnection* connection,
               Isolate* isolate,
               Local<Array> buffers);
  ~WriteRequest();

  static WriteRequest* From(uv_write_t* req) {
    return ContainerOf(&WriteRequest::req_, req);
  }

  bool empty() const {
    return bufs_.empty();
  }

  bool Append(Isolate* isolate, Local<Value> value);

  WebHTTPConnection* connection_;
  // uv_write() requires the memory behind uv_buf_t to outlive the call. JS
  // ArrayBufferViews are retained without copying, while strings are encoded
  // once into request-owned storage so the JS hot path does not allocate
  // short-lived Buffer objects for HTTP framing.
  std::vector<v8::Global<Object>> buffers_;
  std::vector<std::shared_ptr<BackingStore>> backing_stores_;
  std::vector<std::string> strings_;
  std::vector<uv_buf_t> bufs_;
  uv_write_t req_;
};

class ShutdownRequest final {
 public:
  explicit ShutdownRequest(WebHTTPConnection* connection)
      : connection_(connection), req_() {}

  static ShutdownRequest* From(uv_shutdown_t* req) {
    return ContainerOf(&ShutdownRequest::req_, req);
  }

  WebHTTPConnection* connection_;
  uv_shutdown_t req_;
};

class WebHTTPConnection final : public BaseObject {
 public:
  WebHTTPConnection(Environment* env, Local<Object> object);
  ~WebHTTPConnection() override;

  uv_stream_t* stream() {
    return reinterpret_cast<uv_stream_t*>(&tcp_);
  }

  static void New(const FunctionCallbackInfo<Value>& args);
  static void Start(const FunctionCallbackInfo<Value>& args);
  static void Write(const FunctionCallbackInfo<Value>& args);
  static void WriteV(const FunctionCallbackInfo<Value>& args);
  static void End(const FunctionCallbackInfo<Value>& args);
  static void Destroy(const FunctionCallbackInfo<Value>& args);
  static void Initialize(Local<Object> target,
                         Local<Value> unused,
                         Local<Context> context,
                         void* priv);
  static void RegisterExternalReferences(ExternalReferenceRegistry* registry);

  void Close();
  void EmitError(int status);
  void EmitDrain();
  void EmitReadEnd();
  void EmitClose();
  void MaybeShutdown();
  void EnableNoDelay();
  bool QueueWrite(WriteRequest* req);
  ReadBuffer* EnsureReadBuffer(size_t suggested_size);
  void DetachReadBuffer();

  SET_NO_MEMORY_INFO()
  SET_MEMORY_INFO_NAME(WebHTTPConnection)
  SET_SELF_SIZE(WebHTTPConnection)

 private:
  static void Alloc(uv_handle_t* handle, size_t suggested_size, uv_buf_t* buf);
  static void OnRead(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf);
  static void OnWrite(uv_write_t* req, int status);
  static void OnShutdown(uv_shutdown_t* req, int status);
  static void OnClosed(uv_handle_t* handle);

  MaybeLocal<Value> CallJS(const v8::Global<Function>& callback,
                           int argc,
                           Local<Value>* argv);
  void StartRead(Local<Function> on_data,
                 Local<Function> on_read_end,
                 Local<Function> on_error,
                 Local<Function> on_drain,
                 Local<Function> on_close);

  uv_tcp_t tcp_;
  v8::Global<Function> on_data_;
  v8::Global<Function> on_read_end_;
  v8::Global<Function> on_close_;
  v8::Global<Function> on_error_;
  v8::Global<Function> on_drain_;
  ReadBuffer* read_buffer_ = nullptr;
  ReadBuffer* active_read_buffer_ = nullptr;
  bool closing_ = false;
  bool reading_ = false;
  bool read_buffer_in_use_ = false;
  bool shutdown_after_writes_ = false;
  bool shutdown_started_ = false;
  bool needs_drain_ = false;
  size_t pending_writes_ = 0;
};

class WebHTTPServerHandle final : public BaseObject {
 public:
  WebHTTPServerHandle(Environment* env, Local<Object> object);
  ~WebHTTPServerHandle() override = default;

  static void New(const FunctionCallbackInfo<Value>& args);
  static void Listen(const FunctionCallbackInfo<Value>& args);
  static void Address(const FunctionCallbackInfo<Value>& args);
  static void Close(const FunctionCallbackInfo<Value>& args);
  static void Initialize(Local<Object> target,
                         Local<Value> unused,
                         Local<Context> context,
                         void* priv);
  static void RegisterExternalReferences(ExternalReferenceRegistry* registry);

  void EmitConnection(Local<Object> connection);
  void EmitError(int status);
  void EmitClose();
  void CloseHandle();

  SET_NO_MEMORY_INFO()
  SET_MEMORY_INFO_NAME(WebHTTPServerHandle)
  SET_SELF_SIZE(WebHTTPServerHandle)

 private:
  static void OnConnection(uv_stream_t* server, int status);
  static void OnClosed(uv_handle_t* handle);

  void CallJS(const v8::Global<Function>& callback,
              int argc,
              Local<Value>* argv);

  uv_tcp_t tcp_;
  v8::Global<Function> connection_constructor_;
  v8::Global<Function> on_connection_;
  v8::Global<Function> on_error_;
  v8::Global<Function> on_close_;
  bool closing_ = false;
};

WriteRequest::WriteRequest(WebHTTPConnection* connection,
                           Isolate* isolate,
                           Local<Value> buffer)
    : connection_(connection),
      buffers_(),
      backing_stores_(),
      strings_(),
      bufs_(),
      req_() {
  strings_.reserve(1);
  CHECK(Append(isolate, buffer));
}

WriteRequest::WriteRequest(WebHTTPConnection* connection,
                           Isolate* isolate,
                           Local<Array> buffers)
    : connection_(connection),
      buffers_(),
      backing_stores_(),
      strings_(),
      bufs_(),
      req_() {
  Local<Context> context = connection->env()->context();
  const uint32_t length = buffers->Length();
  buffers_.reserve(length);
  backing_stores_.reserve(length);
  strings_.reserve(length);
  bufs_.reserve(length);

  for (uint32_t i = 0; i < length; i++) {
    Local<Value> value;
    if (!buffers->Get(context, i).ToLocal(&value)) return;
    CHECK(Append(isolate, value));
  }
}

WriteRequest::~WriteRequest() {
  for (auto& buffer : buffers_) {
    buffer.Reset();
  }
}

bool WriteRequest::Append(Isolate* isolate, Local<Value> value) {
  if (value->IsString()) {
    node::Utf8Value string(isolate, value);
    if (string.length() == 0) {
      return true;
    }

    strings_.emplace_back(string.out(), string.length());
    std::string& stored = strings_.back();
    bufs_.push_back(uv_buf_init(stored.data(), stored.size()));
    return true;
  }

  if (value->IsArrayBufferView()) {
    Local<ArrayBufferView> view = value.As<ArrayBufferView>();
    const size_t byte_length = view->ByteLength();
    if (byte_length == 0) {
      return true;
    }

    Local<ArrayBuffer> buffer = view->Buffer();
    std::shared_ptr<BackingStore> backing_store = buffer->GetBackingStore();
    char* data =
        static_cast<char*>(backing_store->Data()) + view->ByteOffset();
    buffers_.emplace_back(isolate, view.As<Object>());
    backing_stores_.push_back(std::move(backing_store));
    bufs_.push_back(uv_buf_init(data, byte_length));
    return true;
  }

  return false;
}

WebHTTPConnection::WebHTTPConnection(Environment* env, Local<Object> object)
    : BaseObject(env, object), tcp_() {
  int err = uv_tcp_init(env->event_loop(), &tcp_);
  CHECK_EQ(err, 0);
  tcp_.data = this;
}

WebHTTPConnection::~WebHTTPConnection() {
  if (read_buffer_ != nullptr) {
    DetachReadBuffer();
  }
  on_data_.Reset();
  on_read_end_.Reset();
  on_close_.Reset();
  on_error_.Reset();
  on_drain_.Reset();
}

ReadBuffer* WebHTTPConnection::EnsureReadBuffer(size_t suggested_size) {
  if (read_buffer_ == nullptr) {
    const size_t capacity =
        suggested_size > kReadSlabSize ? suggested_size : kReadSlabSize;
    read_buffer_ = new ReadBuffer(capacity);
  }
  return read_buffer_;
}

void WebHTTPConnection::DetachReadBuffer() {
  ReadBuffer* buffer = read_buffer_;
  if (buffer == nullptr) return;
  read_buffer_ = nullptr;
  read_buffer_in_use_ = false;
  buffer->detached = true;
  ReleaseReadBuffer(buffer);
}

MaybeLocal<Value> WebHTTPConnection::CallJS(
    const v8::Global<Function>& callback,
    int argc,
    Local<Value>* argv) {
  if (callback.IsEmpty()) return MaybeLocal<Value>();

  Environment* env = this->env();
  Isolate* isolate = env->isolate();
  HandleScope scope(isolate);
  Local<Context> context = env->context();
  Context::Scope context_scope(context);
  TryCatchScope try_catch(env);

  Local<Function> fn = PersistentToLocal::Default(isolate, callback);
  MaybeLocal<Value> ret = fn->Call(context, object(isolate), argc, argv);
  if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
    errors::TriggerUncaughtException(isolate, try_catch);
    return MaybeLocal<Value>();
  }
  return ret;
}

void WebHTTPConnection::StartRead(Local<Function> on_data,
                                  Local<Function> on_read_end,
                                  Local<Function> on_error,
                                  Local<Function> on_drain,
                                  Local<Function> on_close) {
  on_data_.Reset(env()->isolate(), on_data);
  on_read_end_.Reset(env()->isolate(), on_read_end);
  on_close_.Reset(env()->isolate(), on_close);
  on_error_.Reset(env()->isolate(), on_error);
  on_drain_.Reset(env()->isolate(), on_drain);

  if (!reading_) {
    int err = uv_read_start(stream(), Alloc, OnRead);
    if (err != 0) {
      EmitError(err);
      Close();
      return;
    }
    reading_ = true;
  }
}

void WebHTTPConnection::New(const FunctionCallbackInfo<Value>& args) {
  CHECK(args.IsConstructCall());
  Environment* env = Environment::GetCurrent(args);
  new WebHTTPConnection(env, args.This());
}

void WebHTTPConnection::Start(const FunctionCallbackInfo<Value>& args) {
  WebHTTPConnection* connection = BaseObject::FromJSObject<WebHTTPConnection>(
      args.This());
  CHECK_NOT_NULL(connection);
  CHECK_GE(args.Length(), 1);
  CHECK(args[0]->IsArray());

  Local<Array> callbacks = args[0].As<Array>();
  CHECK_GE(callbacks->Length(), 5);
  Local<Context> context = connection->env()->context();
  Local<Value> on_data;
  Local<Value> on_read_end;
  Local<Value> on_error;
  Local<Value> on_drain;
  Local<Value> on_close;
  CHECK(callbacks->Get(context, 0).ToLocal(&on_data));
  CHECK(callbacks->Get(context, 1).ToLocal(&on_read_end));
  CHECK(callbacks->Get(context, 2).ToLocal(&on_error));
  CHECK(callbacks->Get(context, 3).ToLocal(&on_drain));
  CHECK(callbacks->Get(context, 4).ToLocal(&on_close));
  CHECK(on_data->IsFunction());
  CHECK(on_read_end->IsFunction());
  CHECK(on_error->IsFunction());
  CHECK(on_drain->IsFunction());
  CHECK(on_close->IsFunction());

  connection->StartRead(on_data.As<Function>(),
                        on_read_end.As<Function>(),
                        on_error.As<Function>(),
                        on_drain.As<Function>(),
                        on_close.As<Function>());
}

void WebHTTPConnection::Write(const FunctionCallbackInfo<Value>& args) {
  WebHTTPConnection* connection = BaseObject::FromJSObject<WebHTTPConnection>(
      args.This());
  CHECK_NOT_NULL(connection);
  CHECK_GE(args.Length(), 1);
  CHECK(args[0]->IsString() || args[0]->IsArrayBufferView());

  if (connection->closing_) {
    args.GetReturnValue().Set(false);
    return;
  }

  if (args[0]->IsArrayBufferView() &&
      args[0].As<ArrayBufferView>()->ByteLength() == 0) {
    args.GetReturnValue().Set(true);
    return;
  }

  WriteRequest* req =
      new WriteRequest(connection, connection->env()->isolate(), args[0]);
  args.GetReturnValue().Set(connection->QueueWrite(req));
}

void WebHTTPConnection::WriteV(const FunctionCallbackInfo<Value>& args) {
  WebHTTPConnection* connection = BaseObject::FromJSObject<WebHTTPConnection>(
      args.This());
  CHECK_NOT_NULL(connection);
  CHECK_GE(args.Length(), 1);
  CHECK(args[0]->IsArray());

  if (connection->closing_) {
    args.GetReturnValue().Set(false);
    return;
  }

  WriteRequest* req =
      new WriteRequest(connection,
                       connection->env()->isolate(),
                       args[0].As<Array>());
  args.GetReturnValue().Set(connection->QueueWrite(req));
}

bool WebHTTPConnection::QueueWrite(WriteRequest* req) {
  if (req->empty()) {
    delete req;
    return true;
  }

  pending_writes_++;
  int err = uv_write(&req->req_,
                     stream(),
                     req->bufs_.data(),
                     static_cast<unsigned int>(req->bufs_.size()),
                     OnWrite);
  if (err != 0) {
    pending_writes_--;
    delete req;
    EmitError(err);
    Close();
    return false;
  }

  const bool under_high_water_mark =
      stream()->write_queue_size <= kWriteHighWaterMark;
  if (!under_high_water_mark) {
    needs_drain_ = true;
  }
  return under_high_water_mark;
}

void WebHTTPConnection::End(const FunctionCallbackInfo<Value>& args) {
  WebHTTPConnection* connection = BaseObject::FromJSObject<WebHTTPConnection>(
      args.This());
  CHECK_NOT_NULL(connection);

  if (connection->closing_) {
    return;
  }

  if (args.Length() > 0 && !args[0]->IsUndefined()) {
    CHECK(args[0]->IsString() || args[0]->IsArrayBufferView());
    Write(args);
  }

  connection->shutdown_after_writes_ = true;
  connection->MaybeShutdown();
}

void WebHTTPConnection::Destroy(const FunctionCallbackInfo<Value>& args) {
  WebHTTPConnection* connection = BaseObject::FromJSObject<WebHTTPConnection>(
      args.This());
  CHECK_NOT_NULL(connection);
  connection->Close();
}

void WebHTTPConnection::Alloc(uv_handle_t* handle,
                              size_t suggested_size,
                              uv_buf_t* buf) {
  WebHTTPConnection* connection =
      static_cast<WebHTTPConnection*>(handle->data);
  if (connection->read_buffer_in_use_) {
    ReadBuffer* fallback = new ReadBuffer(suggested_size);
    fallback->detached = true;
    connection->active_read_buffer_ = fallback;
    *buf = uv_buf_init(fallback->data, fallback->capacity);
    return;
  }

  ReadBuffer* buffer = connection->EnsureReadBuffer(suggested_size);
  if (suggested_size > buffer->capacity) {
    connection->DetachReadBuffer();
    buffer = connection->EnsureReadBuffer(suggested_size);
  }
  connection->read_buffer_in_use_ = true;
  connection->active_read_buffer_ = buffer;
  *buf = uv_buf_init(buffer->data, buffer->capacity);
}

void WebHTTPConnection::OnRead(uv_stream_t* stream,
                               ssize_t nread,
                               const uv_buf_t* buf) {
  WebHTTPConnection* connection =
      static_cast<WebHTTPConnection*>(stream->data);
  Environment* env = connection->env();
  Isolate* isolate = env->isolate();
  HandleScope scope(isolate);
  ReadBuffer* read_buffer = connection->active_read_buffer_;
  connection->active_read_buffer_ = nullptr;

  if (nread > 0) {
    Local<Object> chunk;
    CHECK_NOT_NULL(read_buffer);
    RetainReadBuffer(read_buffer);
    if (Buffer::New(isolate,
                    buf->base,
                    static_cast<size_t>(nread),
                    FreeReadBuffer,
                    read_buffer)
            .ToLocal(&chunk)) {
      Local<Value> argv[] = { chunk };
      Local<Value> retained;
      const bool body_retained =
          connection->CallJS(connection->on_data_, arraysize(argv), argv)
              .ToLocal(&retained) &&
          retained->IsTrue();
      if (read_buffer == connection->read_buffer_) {
        if (body_retained) {
          connection->DetachReadBuffer();
        } else {
          connection->read_buffer_in_use_ = false;
        }
      } else {
        ReleaseReadBuffer(read_buffer);
      }
      return;
    }
    ReleaseReadBuffer(read_buffer);
    if (read_buffer == connection->read_buffer_) {
      connection->read_buffer_in_use_ = false;
    } else {
      ReleaseReadBuffer(read_buffer);
    }
    return;
  } else if (nread < 0) {
    if (nread != UV_EOF) {
      connection->EmitError(nread);
      connection->Close();
    } else {
      // A peer FIN ends the readable side only. HTTP responses already queued
      // must still be allowed to drain before the transport closes its writer.
      if (connection->reading_) {
        uv_read_stop(connection->stream());
        connection->reading_ = false;
      }
      connection->EmitReadEnd();
    }
  }

  if (read_buffer != nullptr) {
    if (read_buffer == connection->read_buffer_) {
      connection->read_buffer_in_use_ = false;
    } else {
      ReleaseReadBuffer(read_buffer);
    }
  }
}

void WebHTTPConnection::OnWrite(uv_write_t* req, int status) {
  std::unique_ptr<WriteRequest> write_req(WriteRequest::From(req));
  WebHTTPConnection* connection = write_req->connection_;

  if (connection->pending_writes_ > 0) {
    connection->pending_writes_--;
  }

  if (status != 0 && !connection->closing_) {
    connection->EmitError(status);
    connection->Close();
    return;
  }

  if (connection->pending_writes_ == 0) {
    if (connection->needs_drain_) {
      connection->needs_drain_ = false;
      connection->EmitDrain();
    }
    connection->MaybeShutdown();
  }
}

void WebHTTPConnection::EnableNoDelay() {
  uv_tcp_nodelay(&tcp_, 1);
}

void WebHTTPConnection::MaybeShutdown() {
  // end() half-closes only after queued writes finish, preserving ordered HTTP
  // responses without exposing a socket or relying on node:net stream state.
  if (!shutdown_after_writes_ ||
      shutdown_started_ ||
      closing_ ||
      pending_writes_ != 0) {
    return;
  }

  shutdown_started_ = true;
  ShutdownRequest* req = new ShutdownRequest(this);
  int err = uv_shutdown(&req->req_, stream(), OnShutdown);
  if (err != 0) {
    delete req;
    Close();
  }
}

void WebHTTPConnection::OnShutdown(uv_shutdown_t* req, int status) {
  std::unique_ptr<ShutdownRequest> shutdown_req(ShutdownRequest::From(req));
  WebHTTPConnection* connection = shutdown_req->connection_;
  if (status != 0 && !connection->closing_) {
    connection->EmitError(status);
  }
  connection->Close();
}

void WebHTTPConnection::Close() {
  if (closing_) return;
  closing_ = true;
  if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(&tcp_))) {
    uv_read_stop(stream());
    uv_close(reinterpret_cast<uv_handle_t*>(&tcp_), OnClosed);
  }
}

void WebHTTPConnection::OnClosed(uv_handle_t* handle) {
  WebHTTPConnection* connection = static_cast<WebHTTPConnection*>(handle->data);
  connection->EmitClose();
  // The uv handle is the native owner. Delete only after uv_close() has run its
  // callback so no libuv request can observe a freed WebHTTPConnection.
  delete connection;
}

void WebHTTPConnection::EmitError(int status) {
  Isolate* isolate = env()->isolate();
  Local<Value> argv[] = { Integer::New(isolate, status) };
  CallJS(on_error_, arraysize(argv), argv);
}

void WebHTTPConnection::EmitDrain() {
  CallJS(on_drain_, 0, nullptr);
}

void WebHTTPConnection::EmitReadEnd() {
  CallJS(on_read_end_, 0, nullptr);
}

void WebHTTPConnection::EmitClose() {
  CallJS(on_close_, 0, nullptr);
}

WebHTTPServerHandle::WebHTTPServerHandle(Environment* env, Local<Object> object)
    : BaseObject(env, object), tcp_() {
  int err = uv_tcp_init(env->event_loop(), &tcp_);
  CHECK_EQ(err, 0);
  tcp_.data = this;
}

void WebHTTPServerHandle::CallJS(const v8::Global<Function>& callback,
                                 int argc,
                                 Local<Value>* argv) {
  if (callback.IsEmpty()) return;

  Environment* env = this->env();
  Isolate* isolate = env->isolate();
  HandleScope scope(isolate);
  Local<Context> context = env->context();
  Context::Scope context_scope(context);
  TryCatchScope try_catch(env);

  Local<Function> fn = PersistentToLocal::Default(isolate, callback);
  USE(fn->Call(context, object(isolate), argc, argv));
  if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
    errors::TriggerUncaughtException(isolate, try_catch);
  }
}

void WebHTTPServerHandle::New(const FunctionCallbackInfo<Value>& args) {
  CHECK(args.IsConstructCall());
  Environment* env = Environment::GetCurrent(args);
  CHECK_GE(args.Length(), 4);
  CHECK(args[0]->IsFunction());
  CHECK(args[1]->IsFunction());
  CHECK(args[2]->IsFunction());
  CHECK(args[3]->IsFunction());

  WebHTTPServerHandle* server = new WebHTTPServerHandle(env, args.This());
  Isolate* isolate = env->isolate();
  server->connection_constructor_.Reset(isolate, args[0].As<Function>());
  server->on_connection_.Reset(isolate, args[1].As<Function>());
  server->on_error_.Reset(isolate, args[2].As<Function>());
  server->on_close_.Reset(isolate, args[3].As<Function>());
}

void WebHTTPServerHandle::Listen(const FunctionCallbackInfo<Value>& args) {
  WebHTTPServerHandle* server = BaseObject::FromJSObject<WebHTTPServerHandle>(
      args.This());
  CHECK_NOT_NULL(server);
  Environment* env = server->env();
  CHECK_GE(args.Length(), 3);

  THROW_IF_INSUFFICIENT_PERMISSIONS(
      env, permission::PermissionScope::kNet, "");

  node::Utf8Value host(env->isolate(), args[0]);
  uint32_t port;
  int32_t backlog;
  if (!args[1]->Uint32Value(env->context()).To(&port) ||
      !args[2]->Int32Value(env->context()).To(&backlog)) {
    return;
  }
  if (backlog <= 0) backlog = kBacklog;

  SocketAddress address;
  if (!SocketAddress::New(*host, port, &address)) {
    args.GetReturnValue().Set(UV_EINVAL);
    return;
  }

  int err = uv_tcp_bind(&server->tcp_, address.data(), 0);
  if (err == 0) {
    err = uv_listen(
        reinterpret_cast<uv_stream_t*>(&server->tcp_), backlog, OnConnection);
  }
  args.GetReturnValue().Set(err);
}

void WebHTTPServerHandle::Address(const FunctionCallbackInfo<Value>& args) {
  WebHTTPServerHandle* server = BaseObject::FromJSObject<WebHTTPServerHandle>(
      args.This());
  CHECK_NOT_NULL(server);

  SocketAddress address = SocketAddress::FromSockName(server->tcp_);
  Local<Object> info;
  if (address.ToJS(server->env()).ToLocal(&info)) {
    args.GetReturnValue().Set(info);
  }
}

void WebHTTPServerHandle::Close(const FunctionCallbackInfo<Value>& args) {
  WebHTTPServerHandle* server = BaseObject::FromJSObject<WebHTTPServerHandle>(
      args.This());
  CHECK_NOT_NULL(server);
  server->CloseHandle();
}

void WebHTTPServerHandle::CloseHandle() {
  if (closing_) return;
  closing_ = true;
  if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(&tcp_))) {
    uv_close(reinterpret_cast<uv_handle_t*>(&tcp_), OnClosed);
  }
}

void WebHTTPServerHandle::OnConnection(uv_stream_t* handle, int status) {
  WebHTTPServerHandle* server = static_cast<WebHTTPServerHandle*>(handle->data);
  Environment* env = server->env();
  Isolate* isolate = env->isolate();
  HandleScope scope(isolate);
  Local<Context> context = env->context();
  Context::Scope context_scope(context);

  if (status != 0) {
    server->EmitError(status);
    return;
  }

  Local<Function> constructor =
      PersistentToLocal::Default(isolate, server->connection_constructor_);
  Local<Object> connection_object;
  if (!constructor->NewInstance(context, 0, nullptr)
           .ToLocal(&connection_object)) {
    return;
  }

  WebHTTPConnection* connection =
      BaseObject::FromJSObject<WebHTTPConnection>(connection_object);
  CHECK_NOT_NULL(connection);

  int err = uv_accept(handle, connection->stream());
  if (err != 0) {
    connection->Close();
    server->EmitError(err);
    return;
  }

  connection->EnableNoDelay();
  // JS receives an opaque internal connection object, not a net.Socket.
  server->EmitConnection(connection_object);
}

void WebHTTPServerHandle::OnClosed(uv_handle_t* handle) {
  WebHTTPServerHandle* server =
      static_cast<WebHTTPServerHandle*>(handle->data);
  server->EmitClose();
  // The listening handle is the native owner for the server wrapper.
  delete server;
}

void WebHTTPServerHandle::EmitConnection(Local<Object> connection) {
  Local<Value> argv[] = { connection };
  CallJS(on_connection_, arraysize(argv), argv);
}

void WebHTTPServerHandle::EmitError(int status) {
  Isolate* isolate = env()->isolate();
  Local<Value> argv[] = { Integer::New(isolate, status) };
  CallJS(on_error_, arraysize(argv), argv);
}

void WebHTTPServerHandle::EmitClose() {
  CallJS(on_close_, 0, nullptr);
}

void WebHTTPConnection::Initialize(Local<Object> target,
                                   Local<Value> unused,
                                   Local<Context> context,
                                   void* priv) {
  Environment* env = Environment::GetCurrent(context);
  Isolate* isolate = env->isolate();

  Local<FunctionTemplate> t = NewFunctionTemplate(isolate, New);
  t->InstanceTemplate()->SetInternalFieldCount(
      WebHTTPConnection::kInternalFieldCount);

  SetProtoMethod(isolate, t, "start", Start);
  SetProtoMethod(isolate, t, "write", Write);
  SetProtoMethod(isolate, t, "writev", WriteV);
  SetProtoMethod(isolate, t, "end", End);
  SetProtoMethod(isolate, t, "destroy", Destroy);

  SetConstructorFunction(context, target, "WebHTTPConnection", t);
}

void WebHTTPConnection::RegisterExternalReferences(
    ExternalReferenceRegistry* registry) {
  registry->Register(New);
  registry->Register(Start);
  registry->Register(Write);
  registry->Register(WriteV);
  registry->Register(End);
  registry->Register(Destroy);
}

void WebHTTPServerHandle::Initialize(Local<Object> target,
                                     Local<Value> unused,
                                     Local<Context> context,
                                     void* priv) {
  Environment* env = Environment::GetCurrent(context);
  Isolate* isolate = env->isolate();

  WebHTTPConnection::Initialize(target, unused, context, priv);

  Local<FunctionTemplate> t = NewFunctionTemplate(isolate, New);
  t->InstanceTemplate()->SetInternalFieldCount(
      WebHTTPServerHandle::kInternalFieldCount);

  SetProtoMethod(isolate, t, "listen", Listen);
  SetProtoMethod(isolate, t, "address", Address);
  SetProtoMethod(isolate, t, "close", Close);

  SetConstructorFunction(context, target, "WebHTTPServerHandle", t);
}

void WebHTTPServerHandle::RegisterExternalReferences(
    ExternalReferenceRegistry* registry) {
  registry->Register(New);
  registry->Register(Listen);
  registry->Register(Address);
  registry->Register(Close);
  WebHTTPConnection::RegisterExternalReferences(registry);
}

}  // namespace http_web_server
}  // namespace node

NODE_BINDING_CONTEXT_AWARE_INTERNAL(web_http_server,
                                    node::http_web_server::
                                        WebHTTPServerHandle::Initialize)
NODE_BINDING_EXTERNAL_REFERENCE(web_http_server,
                                node::http_web_server::
                                    WebHTTPServerHandle::
                                        RegisterExternalReferences)
