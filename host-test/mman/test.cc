#include <cassert>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

// Do not interpose the host/sanitizer's own mmap functions.
#define mmap test_mmap
#define munmap test_munmap
#define mprotect test_mprotect
#define madvise test_madvise
#define msync test_msync
#ifndef MMAN_SOURCE
#define MMAN_SOURCE "../../runtime/nxjs/source/mman-horizon.cc"
#endif
#include MMAN_SOURCE

int main() {
  setbuf(stdout, nullptr);
  constexpr size_t page = 4096, chunk = 2 << 20;
  constexpr int flags = MAP_PRIVATE | MAP_ANONYMOUS;
  // Reproduce the shipped bump allocator's exhaustion without touching 1 GiB.
  for (int i = 0; i < 2000; ++i) {
    void* p = mmap(nullptr, chunk, PROT_NONE, flags, -1, 0);
    if (p == MAP_FAILED) {
      printf("FAIL: arena exhausted after %d allocate/free cycles (%zu MiB cumulative)\n", i, i * chunk / (1 << 20));
      return 1;
    }
    assert(munmap(p, chunk) == 0);
  }
#ifndef BASELINE
  puts("PASS: repeated reservations reuse the data arena");
  assert(horizon_mman_data_used_size() == 0);
  // Real read/write churn must also reuse backing slabs and return zeroed bytes.
  for (int i = 0; i < 2000; ++i) {
    auto* p = static_cast<unsigned char*>(mmap(nullptr, chunk, PROT_READ | PROT_WRITE, flags, -1, 0));
    assert(p != MAP_FAILED);
    for (size_t j = 0; j < chunk; j += page) assert(p[j] == 0);
    memset(p, 0xA5, chunk);
    assert(munmap(p, chunk) == 0);
    assert(horizon_mman_data_used_size() == 0);
    assert(horizon_mman_data_committed_size() == (16 << 20));
  }
  // Alignment trims, holes, adjacent live pages, and fixed decommit/recommit.
  puts("PASS: repeated writable mappings reuse one backing slab");
  auto* p = static_cast<unsigned char*>(mmap(nullptr, 8 * page, PROT_READ | PROT_WRITE, flags, -1, 0));
  memset(p, 0x37, 8 * page);
  assert(munmap(p, page) == 0);
  assert(munmap(p + 7 * page, page) == 0);
  auto* first = mmap(nullptr, page, PROT_NONE, flags, -1, 0);
  auto* last = mmap(nullptr, page, PROT_READ | PROT_WRITE, flags, -1, 0);
  assert(first == p && last == p + 7 * page);
  assert(mprotect(first, page, PROT_READ | PROT_WRITE) == 0);
  for (size_t i = 0; i < page; ++i) assert(p[i] == 0);
  for (size_t i = page; i < 7 * page; ++i) assert(p[i] == 0x37);
  assert(mmap(p + page, page, PROT_NONE, flags | MAP_FIXED, -1, 0) == p + page);
  assert(mprotect(p + page, page, PROT_READ | PROT_WRITE) == 0);
  assert(p[page] == 0 && p[2 * page] == 0x37);
  assert(horizon_mman_data_used_size() == 8 * page);
  assert(munmap(p + 1, page) == -1);
  assert(mmap(nullptr, SIZE_MAX, PROT_NONE, flags, -1, 0) == MAP_FAILED);
  assert(munmap(p, 8 * page) == 0);
  assert(mmap(p + page, page, PROT_NONE, flags | MAP_FIXED, -1, 0) == p + page);
  assert(horizon_mman_data_used_size() == page);
  assert(mmap(nullptr, 2 * page, PROT_NONE, flags, -1, 0) == p + 2 * page);
  assert(munmap(p, 4 * page) == 0);
  // Backing-map failure rolls back the reservation instead of leaking space.
  puts("PASS: partial and fixed mappings preserve neighboring pages");
  horizon_mman_teardown();
  fail_next_map = true;
  assert(mmap(nullptr, chunk, PROT_READ | PROT_WRITE, flags, -1, 0) == MAP_FAILED);
  assert(horizon_mman_data_used_size() == 0);
  std::vector<std::thread> workers;
  puts("PASS: failed mapping releases its reservation");
  for (int i = 0; i < 4; ++i) workers.emplace_back([&] {
    for (int n = 0; n < 1000; ++n) {
      auto* ptr = static_cast<unsigned char*>(mmap(nullptr, 3 * page, PROT_READ | PROT_WRITE, flags, -1, 0));
      assert(ptr != MAP_FAILED);
      memset(ptr, 0x29, 3 * page);
      assert(munmap(ptr, 3 * page) == 0);
    }
  });
  for (auto& worker : workers) worker.join();
  assert(horizon_mman_data_used_size() == 0);
  horizon_mman_teardown();
  assert(mapped_slabs == 0);
  puts("PASS: 8000 MiB cumulative reservations/allocations, zero reuse leaks, partial/fixed mappings, rollback, concurrency");
#endif
}
