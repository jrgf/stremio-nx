#pragma once
// Host stand-ins for the Horizon calls. The allocator itself is compiled intact.
#include <cstdint>
#include <cstdlib>
#include <mutex>

using u64 = uint64_t;
using u32 = uint32_t;
using Result = unsigned;
using Mutex = std::mutex;
constexpr int InfoType_TotalMemorySize = 0, CUR_PROCESS_HANDLE = 0;
constexpr u32 Perm_None = 0, Perm_R = 1, Perm_Rw = 3;
#define R_SUCCEEDED(r) ((r) == 0)
#define R_FAILED(r) ((r) != 0)
inline void mutexLock(Mutex* m) { m->lock(); }
inline void mutexUnlock(Mutex* m) { m->unlock(); }
struct VirtmemReservation { void* address; };
inline void virtmemLock() {}
inline void virtmemUnlock() {}
inline void* virtmemFindStack(size_t n, size_t alignment) {
  void* p = nullptr;
  return posix_memalign(&p, alignment, n) == 0 ? p : nullptr;
}
inline VirtmemReservation* virtmemAddReservation(void* p, size_t) { return new VirtmemReservation{p}; }
inline void virtmemRemoveReservation(VirtmemReservation* r) { free(r->address); delete r; }
inline bool fail_next_map = false;
inline unsigned mapped_slabs = 0;
inline Result svcMapMemory(void*, void*, size_t) {
  if (fail_next_map) { fail_next_map = false; return 1; }
  ++mapped_slabs;
  return 0;
}
inline Result svcUnmapMemory(void*, void*, size_t) { --mapped_slabs; return 0; }
inline void armDCacheFlush(void*, size_t) {}
inline void armICacheInvalidate(void*, size_t) {}
inline Result svcGetInfo(u64* value, int, int, int) { *value = 3ULL << 30; return 0; }
struct Jit { void* base = nullptr; int type = 0; };
inline Result jitCreate(Jit* j, size_t n) { j->base = malloc(n); return j->base ? 0 : 1; }
inline void jitTransitionToExecutable(Jit*) {}
inline void* jitGetRxAddr(Jit* j) { return j->base; }
inline void* jitGetRwAddr(Jit* j) { return j->base; }
inline void jitClose(Jit* j) { free(j->base); j->base = nullptr; }
