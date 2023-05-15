#include "path_resolver.h"
#include "v8.h"

#include <stdlib.h>
#include <unistd.h>

namespace node {

namespace permission {

static bool IsAbsolute(const std::string_view& path) {
#if defined(_WIN32) || defined(_WIN64)
  return path.find(':') != std::string::npos;
#else
  return path[0] == '/';
#endif
}

static std::string Resolve(const std::string_view& path) {
  if (CHECK_NULL(path)) {
    return GetWorkingDirectory();
  }

  return NormalizePath(path);
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

std::string NormalizePath(const std::string& path) {
  std::string absolute_path = path;
  std::replace(absolute_path.begin(), absolute_path.end(), '\\', '/');
  std::vector<std::string> segments;
  std::istringstream segment_stream(absolute_path);
  std::string segment;
  while (std::getline(segment_stream, segment, '/')) {
    if (segment == "..") {
      if (!segments.empty()) segments.pop_back();
    } else if (segment != ".") {
      segments.push_back(segment);
    }
  }
  // Join path segments.
  std::ostringstream os;
  if (segments.size() > 1) {
    std::copy(segments.begin(),
              segments.end() - 1,
              std::ostream_iterator<std::string>(os, "/"));
    os << *segments.rbegin();
  } else {
    os << "/";
    if (!segments.empty()) os << segments[0];
  }
  return os.str();
}

}  // namespace permission

}  // namespace node
