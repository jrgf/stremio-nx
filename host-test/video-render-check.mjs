import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = root + 'host-test/dist/';
mkdirSync(dist, { recursive: true });
const canvas = readFileSync(root + 'runtime/nxjs/source/canvas.cc', 'utf8');
const start = canvas.indexOf('\tif (img && img->logical_width');
assert.ok(start >= 0);
const end = canvas.indexOf('\tSkPaint p;', start);
assert.ok(end > start);
writeFileSync(dist + 'video-render-check.cc', `
#include <cassert>
#include <cmath>
#include <array>
#include <vector>
using SkScalar = float;
struct SkRect {
 double x, y, w, h;
 static SkRect MakeXYWH(double x, double y, double w, double h) { return {x,y,w,h}; }
};
struct Image { int w, h; int width() const { return w; } int height() const { return h; } };
struct Logical { int logical_width, logical_height; };
void draw(int argc, const double *args, Image *image, Logical *img, std::array<SkRect,2> &out) {
 double source_w=image->width(), source_h=image->height();
 ${canvas.slice(start, end)}
 out={srcR,dstR};
}
void check(std::vector<double> args, Image image, Logical logical, SkRect src, SkRect dst) {
 std::array<SkRect,2> actual;
 draw(args.size()+1,args.data(),&image,&logical,actual);
 auto equal=[](SkRect a,SkRect b) {
  assert(std::abs(a.x-b.x)<.001 && std::abs(a.y-b.y)<.001 && std::abs(a.w-b.w)<.001 && std::abs(a.h-b.h)<.001);
 };
 equal(actual[0],src); equal(actual[1],dst);
}
int main() {
 check({10,20}, {1280,720}, {1920,1080}, {0,0,1280,720}, {10,20,1920,1080});
 check({10,20,640,360}, {1280,720}, {1920,1080}, {0,0,1280,720}, {10,20,640,360});
 check({960,540,960,540,10,20,320,180}, {1280,720}, {1920,1080}, {640,360,640,360}, {10,20,320,180});
 check({270,480,540,960,0,0,100,200}, {405,720}, {1080,1920}, {101.25,180,202.5,360}, {0,0,100,200});
 check({20,10,100,50,1,2,200,100}, {640,360}, {0,0}, {20,10,100,50}, {1,2,200,100});
}
`);
let result = spawnSync('clang++', ['-std=c++20', '-fsanitize=undefined', dist + 'video-render-check.cc', '-o', dist + 'video-render-check'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
result = spawnSync(dist + 'video-render-check', [], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
console.log('PASS: actual canvas geometry preserves intrinsic size, resizing and crop coordinates for video and ordinary images');

const video = readFileSync(root + 'runtime/nxjs/packages/runtime/src/video.ts', 'utf8');
const methods = video.slice(video.indexOf('\tsetRenderSize('), video.indexOf('\t/** Active decoding backend.'));
const compiled = transformSync(`class Video { ${methods} }`, { loader: 'ts', target: 'es2022' }).code;
const state = { src: '' }, calls = [];
const stats = { width: 1280, height: 720, transferMs: 3, convertMs: 5 };
const Video = new Function('_', '$', 'handleOf', 'DOMException', compiled + ';return Video;')(
  () => state, { videoSetRenderSize: (...args) => calls.push(args), videoFrameStats: () => stats }, v => v, DOMException);
const element = new Video();
for (const dimensions of [[0,720], [1280,0], [Infinity,720], [1280,NaN], [4097,720], [1280.5,720]]) {
  assert.throws(() => element.setRenderSize(...dimensions), RangeError);
}
element.setRenderSize(1280,720);
assert.deepEqual(calls, [[element,1280,720]]);
assert.deepEqual(element.getFrameStats(), stats);
state.src = 'nxms:1';
assert.throws(() => element.setRenderSize(640,360), { name: 'InvalidStateError' });
assert.equal(calls.length, 1);
console.log('PASS: runtime render bounds validation, pre-load configuration and frame timing bridge');
