import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = root + 'host-test/dist/';
mkdirSync(dist, { recursive: true });
const native = readFileSync(root + 'runtime/nxjs/source/main.cc', 'utf8');
const fatal = native.slice(native.indexOf('static void nx_v8_fatal_exit('), native.indexOf('static void nx_v8_fatal_cb('));
assert.ok(fatal.includes('svcExitProcess'));
writeFileSync(dist + 'fatal-check.cc', `
#include <cassert>
#include <cstdio>
#include <cstring>
#include <unistd.h>
struct mallinfo { size_t uordblks=1024, fordblks=2048, arena=3072; };
struct mallinfo mallinfo() { return {}; }
char heap[4096]; char *fake_heap_start=heap, *fake_heap_end=heap+sizeof(heap);
size_t horizon_mman_data_used_size() { return 8192; }
size_t horizon_mman_data_committed_size() { return 16384; }
enum { AppletType_Application=0, AppletType_SystemApplication=4 };
int mode=0, cleaned=0;
int appletGetAppletType() { return mode; }
[[noreturn]] void svcExitProcess() { throw 7; }
void nx_emergency_teardown() { cleaned++; }
[[noreturn]] void test_exit(int code) { assert(code==1); throw 8; }
FILE* test_fopen(const char* path, const char* mode) {
 assert(strcmp(path,"sdmc:/switch/nxjs-fatal.log")==0 && strcmp(mode,"a")==0);
 return fopen("fatal-check.log",mode);
}
#define fopen test_fopen
#define exit test_exit
${fatal}
#undef fopen
#undef exit
int main() {
 remove("fatal-check.log");
 for (int type : {0, 4, 2}) {
  mode=type;
  try { nx_v8_fatal_exit("OOM",nullptr,nullptr); assert(false); }
  catch(int result) { assert(result==(type==2 ? 8 : 7)); }
 }
 assert(cleaned==1);
}
`.replace('#include <cassert>', '#include <cassert>\n#include <initializer_list>'));
let result = spawnSync('clang++', ['-std=c++20', '-fsanitize=undefined', dist + 'fatal-check.cc', '-o', dist + 'fatal-check'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
result = spawnSync(dist + 'fatal-check', [], { cwd: dist, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const log = readFileSync(dist + 'fatal-check.log', 'utf8');
assert.equal(log.match(/FATAL OOM at \?:/g)?.length, 3);
assert.equal(log.match(/data arena live=8 KiB committed=16 KiB/g)?.length, 3);
console.log('PASS: fatal evidence appends across launches; application exits all threads; applet fallback retained');

const fetchSource = readFileSync(root + 'runtime/nxjs/packages/runtime/src/fetch/fetch.ts', 'utf8');
const headerCode = fetchSource.slice(fetchSource.indexOf('function indexOfEol('), fetchSource.indexOf('function createChunkedParseStream()'));
const headerParser = new Function('decoder', transformSync(headerCode, { loader: 'ts', target: 'es2022' }).code + '; return headersIterator;')(new TextDecoder());
async function parseHeaders(value) {
	const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(value)); c.close(); } });
	const lines = [];
	for await (const item of headerParser(stream.getReader())) lines.push(item);
	return lines;
}
assert.equal((await parseHeaders('HTTP/1.1 206 OK\r\nX: a\r\n\r\nbody')).length, 3);
await assert.rejects(parseHeaders('x'.repeat(8193)), /too long/);
await assert.rejects(parseHeaders(('X: ' + 'x'.repeat(8000) + '\r\n').repeat(9)), /too large/);
const chunkParser = fetchSource.slice(fetchSource.indexOf('function createChunkedParseStream()'), fetchSource.indexOf('function createContentLengthStream('));
const createParser = new Function(transformSync(chunkParser, { loader: 'ts', target: 'es2022' }).code + '; return createChunkedParseStream;')();
async function decode(chunks) {
	const stream = new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
	return new Response(stream.pipeThrough(createParser())).text();
}
const wire = '3;test=yes\r\nabc\r\n2\r\nde\r\n0\r\n\r\n';
assert.equal(await decode([...wire]), 'abcde');
assert.equal(await decode([wire]), 'abcde');
await assert.rejects(decode(['3\r\na']), /Truncated/);
await assert.rejects(decode(['1\r\naXX0\r\n']), /delimiter/);
await assert.rejects(decode(['garbage\r\n']), /size/);
await assert.rejects(decode(['a'.repeat(8193)]), /too long/);
// A server declaring a huge chunk must release data immediately, not accumulate it.
const stream = createParser(), writer = stream.writable.getWriter(), reader = stream.readable.getReader();
const writing = writer.write(new TextEncoder().encode('4000000\r\nsmall prefix')).catch(() => {});
const first = await reader.read();
assert.equal(new TextDecoder().decode(first.value), 'small prefix');
await reader.cancel(); await writing;
console.log('PASS: chunked HTTP streams incrementally; fragmented framing, truncation, oversized headers checked');
