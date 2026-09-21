/**
 * Minimal HTTP/1.1 server over a `Connection`: persistent connections,
 * request bodies by Content-Length, streamed responses. Enough for the local
 * streaming server the core talks to and the media player reads from.
 */
import { ByteReader } from '../platform/stream';
import type { Connection } from '../platform/types';

export interface HttpRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Map<string, string>;
	body: Uint8Array;
}

export type BodySource = Uint8Array | AsyncIterable<Uint8Array>;

export interface HttpResponse {
	status: number;
	headers?: Record<string, string>;
	body?: BodySource;
}

export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse>;

const STATUS_TEXT: Record<number, string> = {
	200: 'OK',
	204: 'No Content',
	206: 'Partial Content',
	400: 'Bad Request',
	403: 'Forbidden',
	404: 'Not Found',
	409: 'Conflict',
	429: 'Too Many Requests',
	416: 'Range Not Satisfiable',
	500: 'Internal Server Error',
};

const MAX_BODY = 4 * 1024 * 1024;
const encoder = new TextEncoder();

/** Serves requests on one connection until the client closes or asks to. */
export async function serveConnection(conn: Connection, handler: HttpHandler, onError?: (err: unknown) => void): Promise<void> {
	const reader = new ByteReader(conn.readable);
	const writer = conn.writable.getWriter();
	try {
		for (;;) {
			const req = await readRequest(reader);
			if (!req) break;
			const res = await handleSafely(handler, req);
			const keepAlive = (req.headers.get('connection') ?? '').toLowerCase() !== 'close';
			await writeResponse(writer, res, req.method === 'HEAD', keepAlive);
			if (!keepAlive) break;
		}
	} catch (err) {
		// Client went away mid-request or mid-response; nothing to recover.
		onError?.(err);
	} finally {
		reader.release();
		writer.releaseLock();
		await conn.close().catch(() => undefined);
	}
}

async function handleSafely(handler: HttpHandler, req: HttpRequest): Promise<HttpResponse> {
	try {
		return await handler(req);
	} catch (err) {
		return text(500, err instanceof Error ? err.message : String(err));
	}
}

async function readRequest(reader: ByteReader): Promise<HttpRequest | null> {
	let requestLine = await reader.readLine();
	while (requestLine === '') requestLine = await reader.readLine();
	if (requestLine === null) return null;

	const [method, target, version] = requestLine.split(' ');
	if (!method || !target || !version?.startsWith('HTTP/1.')) throw new Error(`bad request line: ${requestLine}`);

	const headers = new Map<string, string>();
	for (;;) {
		const line = await reader.readLine();
		if (line === null) return null;
		if (line === '') break;
		const colon = line.indexOf(':');
		if (colon === -1) throw new Error(`bad header: ${line}`);
		headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
	}

	const length = Number(headers.get('content-length') ?? 0);
	if (!Number.isInteger(length) || length < 0 || length > MAX_BODY) throw new Error('bad content-length');
	const body = length > 0 ? await reader.readExact(length) : new Uint8Array(0);
	if (!body) return null;

	const url = new URL(target, 'http://localhost');
	return { method, path: url.pathname, query: url.searchParams, headers, body };
}

async function writeResponse(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	res: HttpResponse,
	headOnly: boolean,
	keepAlive: boolean,
): Promise<void> {
	const headers: Record<string, string> = { ...res.headers };
	const body = res.body ?? new Uint8Array(0);
	if (body instanceof Uint8Array) headers['Content-Length'] = String(body.length);
	if (!('Content-Length' in headers)) keepAlive = false;
	headers['Connection'] = keepAlive ? 'keep-alive' : 'close';

	let head = `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] ?? ''}\r\n`;
	for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
	await writer.write(encoder.encode(`${head}\r\n`));

	if (headOnly) return;
	if (body instanceof Uint8Array) {
		if (body.length) await writer.write(body);
		return;
	}
	for await (const chunk of body) await writer.write(chunk);
}

export function text(status: number, message: string): HttpResponse {
	return { status, headers: { 'Content-Type': 'text/plain' }, body: encoder.encode(message) };
}

export function json(status: number, value: unknown): HttpResponse {
	return { status, headers: { 'Content-Type': 'application/json' }, body: encoder.encode(JSON.stringify(value)) };
}
