/** Serves one file with HTTP range support on Node: `node range-server.mjs <file> <port>`. */
import { serveConnection, text } from '../src/server/http';
import { chunked, rangeResponse } from '../src/server/range';
import { nodePlatform } from './node-platform';

const [file, portArg] = process.argv.slice(2);
const port = Number(portArg);
const size = await nodePlatform.fileSize(file);
const read = chunked(64 * 1024, (start, end) => nodePlatform.readFile(file, start, end));

nodePlatform.listen(
	port,
	(conn) =>
		void serveConnection(conn, async (req) =>
			req.path === '/file' ? rangeResponse(req, size, 'application/octet-stream', read) : text(404, 'not found'),
		),
	'127.0.0.1',
);
console.log(`range server: http://127.0.0.1:${port}/file (${size} bytes)`);
