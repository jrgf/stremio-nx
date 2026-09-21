#pragma once
#include <cstdlib>
inline void* memalign(size_t alignment, size_t bytes) {
  void* p = nullptr;
  return posix_memalign(&p, alignment, bytes) == 0 ? p : nullptr;
}
