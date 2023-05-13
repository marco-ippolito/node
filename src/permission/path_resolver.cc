#include "v8.h"

#include <unistd.h>
#include <string>
#include <string_view>

namespace node {

using v8::String;

namespace permission {

const int CHAR_FORWARD_SLASH = 47;

const int CHAR_BACKWARD_SLASH = 92;

const int CHAR_DOT = 46;

bool IsAbsolutePath(const std::string_view& path) {
#if defined(_WIN32) || defined(_WIN64)
  return path.find(':') != std::string::npos;
#else
  return path[0] == '/';
#endif
}

std::string Resolve(const std::string_view& path) {
  // if (CHECK_NULL(path)) {
  //   path = GetWorkingDirectory();
  // }

  return "hello";
}

std::string GetWorkingDirectory() {
#if defined(_WIN32) || defined(_WIN64)
  char system_buffer[MAX_PATH];
  DWORD len = GetCurrentDirectoryA(MAX_PATH, system_buffer);
  CHECK_GT(len, 0);
  return system_buffer;
#else
  char curdir[PATH_MAX];
  CHECK_NOT_NULL(getcwd(curdir, PATH_MAX));
  return curdir;
#endif
}

bool IsPathSeparator(int code) {
#if defined(_WIN32) || defined(_WIN64)
  return code == CHAR_FORWARD_SLASH || code == CHAR_BACKWARD_SLASH;
#else
  return code == CHAR_FORWARD_SLASH;
#endif
}

}  // namespace permission

}  // namespace node
