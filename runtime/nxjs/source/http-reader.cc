// Portable blocking HTTP/1.1 range reader. See http-reader.h.
#include "http-reader.h"

#include <algorithm>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <strings.h>
#include <sys/socket.h>
#include <unistd.h>

namespace {

constexpr int CONNECT_TIMEOUT_MS = 10000;
// Abort-flag check granularity while blocked.
constexpr int POLL_STEP_MS = 250;
// Give up when no bytes arrive for this long.
constexpr int IDLE_TIMEOUT_MS = 30000;
constexpr size_t HEAD_MAX = 16 * 1024;
// Forward seeks up to this far are read through instead of reconnecting.
constexpr int64_t SKIP_FORWARD_MAX = 1 << 20;

} // namespace

struct nx_http_reader {
	std::string host;
	std::string port;
	std::string path;
	std::string authority;
	std::atomic<bool> *abort = nullptr;
	int fd = -1;
	int64_t size = -1;
	int64_t pos = 0;
	// Body bytes still to come on `fd`, including those already in `pending`.
	int64_t remaining = 0;
	// Body bytes that arrived together with the response head.
	std::string pending;
	char err[160] = {};
};

namespace {

bool aborted(nx_http_reader *r) { return r->abort && r->abort->load(); }

// Diagnostics go to stderr (the runtime's debug log on device).
void http_log(const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	fprintf(stderr, "[http] ");
	vfprintf(stderr, fmt, ap);
	fputc('\n', stderr);
	va_end(ap);
	fflush(stderr);
}

void set_err(nx_http_reader *r, const char *what, int err) {
	if (err)
		snprintf(r->err, sizeof(r->err), "%s: %s", what, strerror(err));
	else
		snprintf(r->err, sizeof(r->err), "%s", what);
	http_log("error at pos %lld: %s", (long long)r->pos, r->err);
}

void close_conn(nx_http_reader *r) {
	if (r->fd >= 0) {
		close(r->fd);
		r->fd = -1;
	}
	r->remaining = 0;
	r->pending.clear();
}

bool parse_url(nx_http_reader *r, const char *url) {
	if (strncmp(url, "http://", 7) != 0)
		return false;
	const char *p = url + 7;
	const char *slash = strchr(p, '/');
	r->authority = slash ? std::string(p, (size_t)(slash - p)) : std::string(p);
	r->path = slash ? slash : "/";
	size_t colon = r->authority.rfind(':');
	if (colon == std::string::npos) {
		r->host = r->authority;
		r->port = "80";
	} else {
		r->host = r->authority.substr(0, colon);
		r->port = r->authority.substr(colon + 1);
	}
	return !r->host.empty() && !r->port.empty();
}

// Waits for `events` on the socket, checking the abort flag every
// POLL_STEP_MS. False on timeout, abort or error.
bool wait_fd(nx_http_reader *r, short events, int timeout_ms) {
	for (int waited = 0; waited < timeout_ms; waited += POLL_STEP_MS) {
		if (aborted(r)) {
			set_err(r, "aborted", 0);
			return false;
		}
		struct pollfd pfd = {r->fd, events, 0};
		int n = poll(&pfd, 1, POLL_STEP_MS);
		if (n > 0)
			return true;
		if (n < 0 && errno != EINTR) {
			set_err(r, "poll", errno);
			return false;
		}
	}
	set_err(r, "timeout", 0);
	return false;
}

bool connect_host(nx_http_reader *r) {
	struct addrinfo hints;
	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_INET;
	hints.ai_socktype = SOCK_STREAM;
	struct addrinfo *res = nullptr;
	int rc = getaddrinfo(r->host.c_str(), r->port.c_str(), &hints, &res);
	if (rc != 0 || !res) {
		snprintf(r->err, sizeof(r->err), "dns: %s",
		         rc ? gai_strerror(rc) : "no address");
		return false;
	}
	int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
	if (fd < 0) {
		set_err(r, "socket", errno);
		freeaddrinfo(res);
		return false;
	}
#ifdef SO_NOSIGPIPE
	int nosigpipe = 1;
	setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosigpipe, sizeof(nosigpipe));
#endif
	int flags = fcntl(fd, F_GETFL, 0);
	fcntl(fd, F_SETFL, flags | O_NONBLOCK);
	int c = connect(fd, res->ai_addr, res->ai_addrlen);
	freeaddrinfo(res);
	r->fd = fd;
	if (c != 0 && errno != EINPROGRESS) {
		set_err(r, "connect", errno);
		close_conn(r);
		return false;
	}
	if (c != 0) {
		if (!wait_fd(r, POLLOUT, CONNECT_TIMEOUT_MS)) {
			close_conn(r);
			return false;
		}
		int soerr = 0;
		socklen_t len = sizeof(soerr);
		if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &len) != 0 ||
		    soerr != 0) {
			set_err(r, "connect", soerr ? soerr : errno);
			close_conn(r);
			return false;
		}
	}
	return true;
}

bool send_all(nx_http_reader *r, const char *data, size_t len) {
	while (len > 0) {
		ssize_t n = send(r->fd, data, len, 0);
		if (n > 0) {
			data += n;
			len -= (size_t)n;
			continue;
		}
		if (n < 0 && errno == EINTR)
			continue;
		if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
			if (!wait_fd(r, POLLOUT, IDLE_TIMEOUT_MS))
				return false;
			continue;
		}
		set_err(r, "send", errno);
		return false;
	}
	return true;
}

// Returns bytes received (> 0), 0 when the peer closed, -1 on error/abort.
int recv_some(nx_http_reader *r, uint8_t *buf, size_t n) {
	for (;;) {
		ssize_t got = recv(r->fd, buf, n, 0);
		if (got >= 0)
			return (int)got;
		if (errno == EINTR)
			continue;
		if (errno == EAGAIN || errno == EWOULDBLOCK) {
			if (!wait_fd(r, POLLIN, IDLE_TIMEOUT_MS))
				return -1;
			continue;
		}
		set_err(r, "recv", errno);
		return -1;
	}
}

// Reads the response head into `head`; body bytes that arrive with it go to
// r->pending.
bool read_head(nx_http_reader *r, std::string &head) {
	uint8_t buf[4096];
	for (;;) {
		size_t at = head.find("\r\n\r\n");
		if (at != std::string::npos) {
			r->pending.assign(head, at + 4, std::string::npos);
			head.resize(at);
			return true;
		}
		if (head.size() > HEAD_MAX) {
			set_err(r, "response head too large", 0);
			return false;
		}
		int got = recv_some(r, buf, sizeof(buf));
		if (got < 0)
			return false;
		if (got == 0) {
			set_err(r, "connection closed before response head", 0);
			return false;
		}
		head.append((const char *)buf, (size_t)got);
	}
}

bool header_value(const std::string &head, const char *name,
                  std::string &out) {
	size_t nlen = strlen(name);
	size_t at = 0;
	while ((at = head.find("\r\n", at)) != std::string::npos) {
		at += 2;
		if (head.size() - at > nlen &&
		    strncasecmp(head.c_str() + at, name, nlen) == 0 &&
		    head[at + nlen] == ':') {
			size_t v = at + nlen + 1;
			while (v < head.size() && head[v] == ' ')
				v++;
			size_t e = head.find("\r\n", v);
			out = head.substr(v, e == std::string::npos ? std::string::npos
			                                            : e - v);
			return true;
		}
	}
	return false;
}

// Applies the status line and headers of a range response to the reader.
bool apply_head(nx_http_reader *r, const std::string &head) {
	int status = 0;
	if (sscanf(head.c_str(), "HTTP/%*d.%*d %d", &status) != 1) {
		set_err(r, "malformed status line", 0);
		return false;
	}
	std::string value;
	if (status == 206) {
		long long first = 0, last = 0, total = 0;
		if (!header_value(head, "content-range", value) ||
		    sscanf(value.c_str(), "bytes %lld-%lld/%lld", &first, &last,
		           &total) != 3 ||
		    first != r->pos || last < first || total <= last) {
			set_err(r, "bad content-range", 0);
			return false;
		}
		r->size = total;
		r->remaining = last - first + 1;
		return true;
	}
	if (status == 200 && r->pos == 0) {
		// Server ignored the range: fine for the initial request only.
		if (!header_value(head, "content-length", value)) {
			set_err(r, "no content-length", 0);
			return false;
		}
		r->size = atoll(value.c_str());
		r->remaining = r->size;
		return true;
	}
	if (status == 416 && r->size >= 0) {
		// Requested past the end: nothing to read.
		r->remaining = 0;
		return true;
	}
	snprintf(r->err, sizeof(r->err), "http %d", status);
	return false;
}

// Connects and requests the resource from r->pos.
bool open_range(nx_http_reader *r) {
	close_conn(r);
	if (!connect_host(r))
		return false;
	char req[1024];
	int len = snprintf(req, sizeof(req),
	                   "GET %s HTTP/1.1\r\nHost: %s\r\nRange: bytes=%lld-\r\n"
	                   "Connection: close\r\nUser-Agent: nx.js\r\n\r\n",
	                   r->path.c_str(), r->authority.c_str(),
	                   (long long)r->pos);
	if (len < 0 || (size_t)len >= sizeof(req)) {
		set_err(r, "request too long", 0);
		close_conn(r);
		return false;
	}
	std::string head;
	if (!send_all(r, req, (size_t)len) || !read_head(r, head) ||
	    !apply_head(r, head)) {
		close_conn(r);
		return false;
	}
	if ((int64_t)r->pending.size() > r->remaining)
		r->pending.resize((size_t)r->remaining);
	http_log("range from %lld: size %lld, body %lld, %zu bytes with head",
	         (long long)r->pos, (long long)r->size, (long long)r->remaining,
	         r->pending.size());
	if (r->remaining == 0)
		close_conn(r);
	return true;
}

} // namespace

nx_http_reader *nx_http_reader_open(const char *url, std::atomic<bool> *abort,
                                    char *errbuf, size_t errbuf_size) {
	nx_http_reader *r = new nx_http_reader();
	r->abort = abort;
	if (!parse_url(r, url)) {
		snprintf(errbuf, errbuf_size, "unsupported url");
		delete r;
		return nullptr;
	}
	if (!open_range(r) || r->size < 0) {
		snprintf(errbuf, errbuf_size, "%s", r->err[0] ? r->err : "http open failed");
		delete r;
		return nullptr;
	}
	return r;
}

int64_t nx_http_reader_size(nx_http_reader *r) { return r->size; }

int64_t nx_http_reader_pos(nx_http_reader *r) { return r->pos; }

const char *nx_http_reader_error(nx_http_reader *r) { return r->err; }

int nx_http_reader_read(nx_http_reader *r, uint8_t *buf, int n) {
	if (n <= 0)
		return 0;
	if (r->size >= 0 && r->pos >= r->size)
		return 0;
	if (r->fd < 0 && !open_range(r))
		return -1;
	if (r->remaining <= 0)
		return 0;
	int got;
	if (!r->pending.empty()) {
		got = (int)std::min((size_t)n, r->pending.size());
		memcpy(buf, r->pending.data(), (size_t)got);
		r->pending.erase(0, (size_t)got);
	} else {
		size_t want = (size_t)std::min((int64_t)n, r->remaining);
		got = recv_some(r, buf, want);
		if (got < 0) {
			close_conn(r);
			return -1;
		}
		if (got == 0) {
			http_log("peer closed with %lld body bytes outstanding",
			         (long long)r->remaining);
			set_err(r, "connection closed mid-body", 0);
			close_conn(r);
			return -1;
		}
	}
	r->pos += got;
	r->remaining -= got;
	if (r->remaining == 0)
		close_conn(r);
	return got;
}

bool nx_http_reader_seek(nx_http_reader *r, int64_t pos) {
	if (pos < 0 || (r->size >= 0 && pos > r->size))
		return false;
	if (pos == r->pos)
		return true;
	int64_t ahead = pos - r->pos;
	http_log("seek %lld -> %lld (%s)", (long long)r->pos, (long long)pos,
	         r->fd >= 0 && ahead > 0 && ahead <= SKIP_FORWARD_MAX &&
	                 ahead <= r->remaining
	             ? "read-through"
	             : "reconnect");
	if (r->fd >= 0 && ahead > 0 && ahead <= SKIP_FORWARD_MAX &&
	    ahead <= r->remaining) {
		uint8_t scratch[16384];
		while (r->pos < pos) {
			int want = (int)std::min(pos - r->pos, (int64_t)sizeof(scratch));
			if (nx_http_reader_read(r, scratch, want) <= 0)
				break;
		}
		if (r->pos == pos)
			return true;
	}
	close_conn(r);
	r->pos = pos;
	return true;
}

void nx_http_reader_close(nx_http_reader *r) {
	if (!r)
		return;
	close_conn(r);
	delete r;
}
