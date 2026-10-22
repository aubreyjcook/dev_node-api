# HTTP and REST Fundamentals

This document covers what you need before the rest of this project makes sense: what actually travels over the wire, what methods and status codes mean, how headers work, what "REST" is really claiming, and how a URL turns into a function call.

The reference project is a small task-tracking API with a `tasks` resource, built with **zero runtime dependencies** directly on Node's built-in `node:http` module. It exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/api/tasks` | List tasks (the collection) |
| GET | `/api/tasks/:id` | Read one task (an item) |
| POST | `/api/tasks` | Create a task |
| PUT | `/api/tasks/:id` | Replace a task |
| PATCH | `/api/tasks/:id` | Partially update a task |
| DELETE | `/api/tasks/:id` | Delete a task |

This document stays at the HTTP/REST level. Implementation details — file layout, function names, validation code — live in the other docs.

## 1. What HTTP Actually Is

**HTTP** (HyperText Transfer Protocol) is a **text-based request/response protocol** that runs on top of **TCP**.

Unpack that, because every word matters:

- **Text-based**: the bytes on the wire are, for practical purposes, ASCII text. A request is a few lines of text followed by an optional blob of bytes; there is no binary framing format to learn. You could type a valid HTTP request into a TCP socket by hand. (HTTP/2 and HTTP/3 are binary and far more complex, but Node's `http` module speaks HTTP/1.1 — and HTTP/1.1 defines the semantics, methods, status codes, and headers that every other version still uses.)
- **Request/response**: HTTP is strictly **client-initiated**. The client opens a connection and sends a request; the server sends exactly one response back. A server never spontaneously pushes a request at a client.
- **On top of TCP**: TCP already gives you an ordered, reliable **byte stream**. HTTP does not handle packet loss or retransmission; its whole job is to define a *shape* for that stream — how a request is delimited, how a response is delimited, and what the text between them means. That is why `Content-Length` and chunked encoding exist at all: a byte stream has no built-in message boundaries, so HTTP has to invent them.

The practical consequence: **HTTP is stateless at the protocol level**. Each request is a self-contained message, and the protocol has no concept of being "in the middle of a conversation." Section 9 covers the implications.

### 1.1 A request and a response, verbatim

Here is a complete, real HTTP/1.1 exchange — what the bytes look like if you capture them.

> **About line endings:** every line terminator below is **CRLF** — carriage return (`0x0D`) followed by line feed (`0x0A`). It is drawn as an ordinary line break here for readability. HTTP requires CRLF; a bare LF is tolerated by many servers but is not correct.

**The raw request** (`POST /api/tasks`):

```http
POST /api/tasks HTTP/1.1
Host: localhost:3000
User-Agent: curl/8.5.0
Accept: application/json
Content-Type: application/json
Content-Length: 56

{"title":"Ship the docs","done":false,"priority":"high"}
```

| Part | What it is | What it means |
| --- | --- | --- |
| `POST /api/tasks HTTP/1.1` | The **request line** | Method `POST`, target `/api/tasks`, protocol version |
| `Host: localhost:3000` | Header | Which host and port is being addressed. **Required** in HTTP/1.1 |
| `User-Agent: curl/8.5.0` | Header | Identifies the client software. Purely informational |
| `Accept: application/json` | Header | "In the response, I can handle JSON" |
| `Content-Type: application/json` | Header | "The body I am sending is JSON" |
| `Content-Length: 56` | Header | "My body is exactly 56 bytes long" |
| *(empty line)* | Separator | A bare CRLF marking the end of the header section |
| `{"title":...}` | The **body** | 56 bytes of JSON |

Two things beginners routinely get wrong here:

1. **`Content-Length` counts bytes, not characters.** The body above is pure ASCII, so 56 characters is 56 bytes and the two numbers agree. They stop agreeing the moment a non-ASCII character appears. `{"title":"Café"}` is **16 characters** but **17 bytes**, because `é` is one character and two bytes in UTF-8. That is a difference of one here; the gap grows with every accented letter, and an emoji such as `🎉` is one character but four bytes. (There is even a third number: JavaScript's `String.prototype.length` counts UTF-16 code units, so `"🎉".length` is `2`. For `Café` it happens to agree with the character count, because `é` sits inside the Basic Multilingual Plane.) Get this wrong and the server hangs waiting for a body that never fully arrives, or truncates one.
2. **The blank line is mandatory even when there is no body.** A `GET` has no body, but still ends its header block with an empty line. The blank line is what tells the parser "headers are done."

**The raw response** (the server created task `3`):

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Content-Length: 63
Location: /api/tasks/3
Date: Mon, 09 Jun 2025 14:32:07 GMT

{"id":3,"title":"Ship the docs","done":false,"priority":"high"}
```

| Part | What it is | What it means |
| --- | --- | --- |
| `HTTP/1.1 201 Created` | The **status line** | Version, **status code** `201`, human-readable **reason phrase** (decorative; clients must use the number) |
| `Content-Type: application/json; charset=utf-8` | Header | The media type of the response body |
| `Content-Length: 63` | Header | The response body is 63 bytes |
| `Location: /api/tasks/3` | Header | The URI of the resource that was just created |
| `Date: ...` | Header | When the response was generated. Servers generally add this automatically |
| *(empty line)* | Separator | End of headers |
| `{"id":3,...}` | The body | The freshly created task, as JSON |

Note the asymmetry in how a message is known to be over:

- If `Content-Length` is present, read exactly that many bytes after the blank line.
- If `Transfer-Encoding: chunked` is present, read chunks until a zero-length chunk.
- If the status is `204` or `304`, or the response answers a `HEAD`, there is **no body at all** — the message ends at the blank line.

### 1.2 A chunked response

When a server does not know the body size up front it uses `Transfer-Encoding: chunked` instead of `Content-Length`. The body is framed as chunks: a hexadecimal length, CRLF, the chunk bytes, CRLF — repeated — then a zero-length terminator.

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Transfer-Encoding: chunked
Date: Mon, 09 Jun 2025 14:32:07 GMT

2a
[{"id":1,"title":"Buy milk","done":false}]
0

```

The `2a` is hexadecimal for 42, and the 42 bytes that follow are exactly `[{"id":1,"title":"Buy milk","done":false}]`. Then `0` announces a zero-length chunk — the end — followed by one final empty line (the trailer section, normally empty). Chunk lengths are case-insensitive hex; lowercase is conventional.

This matters because Node's `http` server **defaults to chunked** when you write a body without announcing its length. If you want an explicit `Content-Length`, you must set it yourself — one of the small chores a framework normally hides.

> Never send both `Content-Length` and `Transfer-Encoding: chunked`. That is a protocol error and a classic request-smuggling vector. To confirm any `Content-Length` in this document, use `Buffer.byteLength(body, 'utf8')` — **not** `body.length`.

## 2. The Anatomy of a Request

Every request has exactly three parts, in this order.

### 2.1 The request line

```
<method> <request-target> <HTTP-version>
```

The three tokens are separated by single spaces; nothing else is on the line.

- **Method** — the verb, what you want done: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.
- **Request target** — almost always the **origin-form**: path and query string only, starting with `/`. It does **not** include `http://`, the host, or the port. `GET /api/tasks?done=false HTTP/1.1` is correct; `GET http://localhost:3000/api/tasks HTTP/1.1` is the *absolute-form*, used only when talking to a forward proxy.
- **HTTP version** — `HTTP/1.1` for this project. `HTTP/1.0` closes the connection after every response by default.

### 2.2 The URL versus the request target

```
http://localhost:3000/api/tasks/42?fields=title&verbose=1#notes
└─┬─┘ └──────┬──────┘└─────┬──────┘└────────┬────────┘└──┬─┘
scheme     authority      path            query       fragment
```

Only **path + query** goes on the request line. The **authority** goes in the `Host` header. The **scheme** is implied by the port you connected to and whether TLS was used. And the **fragment is never sent to the server at all** — it is resolved entirely by the client, which is why `#notes` will never appear in your logs or your handler, no matter how long you look.

### 2.3 Headers

Headers are `name: value` metadata lines carrying everything that is not the method, the identity of the resource, or the payload: content types, lengths, credentials, caching rules, cookies, correlation IDs. Section 5 covers them properly.

Header **names are case-insensitive** (`content-type`, `Content-Type`, and `CONTENT-TYPE` are the same header) and are conventionally written in `Title-Case`. Header **values** are generally case-sensitive. Whitespace around a value is trimmed, and the canonical form is `Name: value` with one space.

### 2.4 The body

The body is optional and is just bytes. HTTP does not care whether they are JSON, form data, a JPEG, or protobuf. Two headers tell the receiver how to interpret the bytes and where they end: **`Content-Type`** says what they *are*, and **`Content-Length`** or **`Transfer-Encoding: chunked`** says how many there are and how they are framed.

A request body only makes sense for methods defined to carry one: `POST`, `PUT`, `PATCH`. `GET` and `DELETE` bodies have no defined semantics and are widely ignored or rejected.

## 3. Methods

The method is the verb of the request. It tells the server *what to do with the resource identified by the target*, without the URL itself having to say so. That is the single most important idea in REST. Two properties classify every method; definitions now, examples in Section 8.

- **Safe** — the method is intended to be read-only. The client is requesting no state change and cannot be held responsible for one, so browsers, crawlers, and prefetchers may issue safe requests speculatively.
- **Idempotent** — issuing the *same* request N times has the same **effect on server state** as issuing it once. The *response* may differ between calls; the state may not.

### 3.1 Summary table

| Method | Purpose | Request body? | Safe? | Idempotent? | Typical success |
| --- | --- | --- | --- | --- | --- |
| `GET` | Retrieve a representation of the target resource | No (undefined semantics) | Yes | Yes | `200 OK` |
| `HEAD` | Identical to `GET`, but headers only | No | Yes | Yes | `200 OK` |
| `OPTIONS` | Ask what methods/options the target supports | No | Yes | Yes | `204` / `200` |
| `POST` | Create a subordinate resource, or process the enclosed representation | Yes | No | **No** | `201 Created` (or `200`) |
| `PUT` | Replace the entire resource at the target URI | Yes (usually) | No | **Yes** | `200` / `204` |
| `PATCH` | Apply a partial modification | Yes | No | **No** (not guaranteed) | `200` / `204` |
| `DELETE` | Remove the resource at the target URI | No | No | **Yes** | `204 No Content` |

`TRACE` also exists — it echoes the request back for diagnostics — and is safe and idempotent, but it is disabled by virtually every production server because it enables cross-site tracing attacks. You will not implement it.

### 3.2 Method notes, using this project's endpoints

**`GET /api/tasks`** and **`GET /api/tasks/42`** — read. No request body, a JSON representation in the response, `200 OK`. Safe and idempotent, so a browser may prefetch them and an intermediary cache may store them. `GET /api/tasks/42` for a task that does not exist is `404 Not Found`.

**`HEAD /api/tasks/42`** — what `GET` would return, minus the body. Useful for cheap existence checks. If a resource supports `GET` it should support `HEAD`, and the `HEAD` response must carry the same headers the `GET` would have — including the `Content-Length` the `GET` body would have had, even though no body follows. Many minimal servers get this wrong; treat it as a correctness detail, not a feature.

**`OPTIONS /api/tasks`** — asks for the communication options available on that resource; the response may carry an `Allow` header. It is also what browsers send automatically as a **CORS preflight** for non-simple cross-origin requests (Section 5.7).

**`POST /api/tasks`** — create. The body is the representation of the new task; the server assigns the identity (`id`) and answers **`201 Created`** with a `Location` header pointing at the new resource. Sending the same `POST` twice creates **two** tasks, which is why `POST` is neither safe nor idempotent and why retrying a timed-out `POST` is dangerous.

**`PUT /api/tasks/42`** — replace the task at `/api/tasks/42` wholesale with the body's representation. The client named the resource in the URL; the body supplies the *complete* new state, so any field absent from the body is removed or reset, not preserved. Because the client chose the URI, `PUT` can create-if-absent, and the conventional signal is `201 Created` when it created a resource and `200 OK` or `204 No Content` when it replaced one. **Honest note:** whether this project's `PUT` creates a missing task or returns `404 Not Found` is a design decision documented elsewhere. Both are defensible; what matters is choosing one behavior and applying it consistently.

**`PATCH /api/tasks/42`** — partial modification. Only the fields present in the body change. This is the practical difference from `PUT`: `PUT {"done":true}` wipes `title` and `priority`, while `PATCH {"done":true}` flips one field. `PATCH` is defined by RFC 5789 and is neither safe nor idempotent in general.

**`DELETE /api/tasks/42`** — remove. No body, `204 No Content` on success. A second identical `DELETE` typically returns `404 Not Found` — and the method is *still* idempotent, because the server state after the second call is identical to the state after the first. This is the cleanest illustration that idempotency is about **effects, not responses**.

## 4. Status Codes

A status code is a three-digit integer on the first line of the response: the server's machine-readable verdict on the request.

### 4.1 The class system

| Class | Name | Meaning |
| --- | --- | --- |
| `1xx` | Informational | Request received; the server is continuing. Provisional, headers only |
| `2xx` | Successful | Request received, understood, and accepted |
| `3xx` | Redirection | Further action is needed; `Location` usually tells you where |
| `4xx` | Client Error | The request is at fault: malformed, unauthorized, or pointing at nothing |
| `5xx` | Server Error | The server failed to fulfill an apparently valid request |

Two things to internalize:

1. **The class is the contract.** A client can treat any `2xx` as success and any `5xx` as "the server broke, maybe retry" without understanding the specific code. Well-behaved generic clients only look at the first digit. That is the point of the design.
2. **`4xx` versus `5xx` is a claim about blame.** If your handler throws a `TypeError` because a client sent a string where you expected an object, that is **your** bug (you failed to validate) and arguably still a `4xx`. If it throws because a disk is full, that is genuinely `5xx`. Getting this wrong makes your API lie to monitoring systems and to retry logic.

The only `1xx` you might meet is **`100 Continue`**: a client sends `Expect: 100-continue` with a large body, the server replies `100 Continue`, and only then does the client send the body — avoiding a wasted upload just to learn the request is unauthorized.

### 4.2 The codes this project uses

| Code | Reason phrase | When to use it here |
| --- | --- | --- |
| `200` | OK | General success with a body. `GET /api/tasks`, `GET /api/tasks/42`, `PUT`/`PATCH` returning the updated task |
| `201` | Created | A new resource now exists. `POST /api/tasks` — always with a `Location` header |
| `204` | No Content | Success with deliberately **no** body. `DELETE /api/tasks/42` |
| `400` | Bad Request | The request is **syntactically** broken: unparseable JSON, bad framing |
| `404` | Not Found | No resource at that URI: unknown task id, or a path the router does not serve |
| `405` | Method Not Allowed | The path exists but not for that method. Must include an `Allow` header |
| `415` | Unsupported Media Type | `Content-Type` is one we cannot process: a task sent as `text/plain` |
| `422` | Unprocessable Content | Body is syntactically fine but **semantically invalid**: missing `title`, bad enum, unparseable date |
| `500` | Internal Server Error | Genuinely unexpected server failure. The catch-all |

Codes you will meet elsewhere, and which this project correctly does not need: `401 Unauthorized` (actually *unauthenticated* — no credentials or bad ones; requires a `WWW-Authenticate` header), `403 Forbidden` (authenticated but not allowed — note that a `403` on `/api/tasks/42` confirms task 42 exists, while `404` deliberately hides that), `406 Not Acceptable`, `409 Conflict`, `429 Too Many Requests` (pairs with `Retry-After`), and `503 Service Unavailable`.

### 4.3 `400` versus `422`

This distinction is genuinely useful, and beginners collapse it into "400 for everything."

**`400 Bad Request`** means the server could not even get to the point of evaluating the request's *meaning*. The message is malformed at the syntax or framing layer:

- The body is not valid JSON at all: `{"title": "Fix bug",` — truncated, missing brace.
- The body is not valid UTF-8.
- The request framing is wrong (a `Content-Length` that does not match the bytes sent).

The server's attitude is: *"I could not parse this into a value I can reason about."*

**`422 Unprocessable Content`** means the server parsed the request perfectly and the content type is supported, but the resulting value **fails validation**. The syntax is fine; the semantics are not:

- Valid JSON, but a number or bare string instead of an object.
- Valid object, but `title` is missing, empty, or not a string.
- `priority` is `"urgent"` when the allowed set is `"low" | "medium" | "high"`.
- `dueDate` is `"next tuesday"` instead of an ISO 8601 date.
- `done` is `"true"` (a string) instead of `true` (a boolean).

The server's attitude is: *"I understood exactly what you asked for, and it is not acceptable."*

RFC 9110 defines `422` as: the server understands the content type and the syntax is correct, but it was unable to process the contained instructions. It was introduced in WebDAV (RFC 4918) as `Unprocessable Entity`; RFC 9110 renamed it `Unprocessable Content`. The old name is still extremely common, so expect to see either.

> **Be honest about pragmatism.** Plenty of production APIs use `400` for both cases and are perfectly usable. The split earns its keep when clients can act differently: `400` says "your serializer or HTTP client is broken, do not retry," while `422` says "here is a per-field validation error, show it next to the form." This project uses the split because it is the more informative behavior.

### 4.4 `200` versus `201` versus `204`

All three are "it worked," and beginners pick them at random. Each says something different.

**`200 OK`** — success with a representation in the body. Use it whenever you are returning a resource so the client does not need a second request. `GET` is essentially always `200`; `PUT` and `PATCH` are `200` when they return the updated resource.

**`201 Created`** — a new resource came into existence *as a result of this request*, and the response tells the client where it is via a **`Location` header**. This is the correct answer for `POST /api/tasks`:

```http
HTTP/1.1 201 Created
Location: /api/tasks/3
Content-Type: application/json; charset=utf-8

{"id":3,"title":"Ship the docs","done":false,"priority":"high"}
```

`201` is about *existence*, not about which method was used — a `PUT` that creates a resource should also return `201`, not `200`. Returning `200` from a `POST` that created something is the most common mistake in this group: it forces the client to guess the new id by parsing the body or re-listing the collection, which is exactly the problem `Location` exists to solve.

**`204 No Content`** — the request succeeded and there is deliberately nothing to say. The response has **no body**, and per RFC 9110 a `204` **must not** include a `Content-Length` header. This is the natural fit for `DELETE /api/tasks/42`: the resource is gone, so there is no representation to return, and the client already knows the URI it deleted.

That generalizes: **use `204` when the client already knows the outcome, and `200` when the body carries information the client does not have.** A `DELETE` that returns the deleted task as a body should be `200`, not `204`.

A concrete mistake to avoid: returning `204` *and* a JSON body. Clients and intermediaries disagree about whether to read it — many discard the body outright — so the field silently disappears.

## 5. Headers

A header is a `name: value` line in the header block. Headers are HTTP's extension mechanism, carrying everything the request line and status line have no room for: `Host`, `Accept`, `Authorization`, and `User-Agent` on requests; `Content-Type`, `Location`, `ETag`, `Cache-Control`, and `Date` on responses.

Many headers may legally appear multiple times or be combined with commas (`Accept: application/json, text/plain`); for list-valued headers both forms mean the same thing, so a robust reader handles both. Some headers are **hop-by-hop** (`Connection`, `Transfer-Encoding`) and must not be forwarded by proxies; the rest are end-to-end.

### 5.1 `Content-Type`

**What the body of *this message* is.** Appears on requests that have a body and responses that have a body.

```
Content-Type: application/json; charset=utf-8
```

The syntax is `type/subtype` plus optional `;`-separated parameters. `application/json` is the media type for JSON. `charset=utf-8` is technically redundant — RFC 8259 says JSON exchanged between systems **must** be UTF-8, with no way to signal another encoding — but it is harmless and extremely common, so send it for clarity.

If a client sends a body with no `Content-Type`, you cannot know how to parse it. That is why this project answers a `POST` carrying `text/plain` with **`415 Unsupported Media Type`**: the request is well formed, but we do not speak that media type. `415` is specifically about media types; `400` is the right answer for a `Content-Type: application/json` body that turns out not to be valid JSON.

### 5.2 `Content-Length`

**The exact size of the body in bytes** — octets, explicitly not characters. Both sides use it to know where the message ends: on a request it tells the server when it has read the whole body, and on a response it tells the client when to stop reading. It **must not** be sent on a `204`, on a `1xx`, or on a response to `HEAD` (for `HEAD` the value reflects what `GET` *would* have returned, but no body follows). If you cannot know the size in advance, omit it and use chunked transfer encoding — never send both.

### 5.3 `Accept`

**What media types the client is willing to receive in the response.** Request header only.

```
Accept: application/json, text/plain;q=0.5, */*;q=0.1
```

The `q` values are quality weights: "JSON first, plain text half as good, anything else at low priority." If a server cannot produce any acceptable type it should return `406 Not Acceptable`, though in practice most JSON APIs ignore `Accept` on reads and always return JSON.

> **`Content-Type` versus `Accept` in one line:** `Content-Type` describes **what I am sending you**; `Accept` describes **what I want you to send me**. A request can, and usually does, carry both — `Accept: application/json` and `Content-Type: application/json` — and they are independent, not redundant. A request can equally carry `Accept: application/json` with `Content-Type: text/csv`, meaning "I am uploading CSV data and want JSON back."

### 5.4 `Location`

**A URI reference identifying a resource** — typically the newly created one. Response header. Used with `201 Created` to point at the new resource and with `3xx` to point at the redirect target:

```
Location: /api/tasks/3
```

It may be relative to the request URI (as above) or absolute, and clients resolve a relative `Location` against the request URL exactly as a browser resolves a relative link.

### 5.5 `Allow`

**Which methods the target resource supports.** Response header, method names separated by commas. This header has one hard requirement attached: a **`405 Method Not Allowed` response must include it** (RFC 9110). It is also the natural content of an `OPTIONS` response. For example, `DELETE /api/tasks` addressed at the collection, where only reads and creates are supported:

```http
HTTP/1.1 405 Method Not Allowed
Allow: GET, POST, HEAD, OPTIONS
Content-Type: application/json; charset=utf-8

{"error":"Method DELETE is not allowed on /api/tasks"}
```

Two notes: if `GET` is allowed then `HEAD` and `OPTIONS` are effectively allowed too, so listing them is honest. And `405` is not `404` — `405` means *the path is real but not for this method*, while `404` means *there is no such resource at all*.

### 5.6 `Cache-Control`

**Directives that control caching.** They can appear on requests ("do not give me a cached copy") and responses ("this may or may not be stored, for this long"). The most-confused pair:

| Directive | Meaning |
| --- | --- |
| `no-store` | Do not store this response anywhere, at all — not disk, not memory |
| `no-cache` | You may store it, but you **must** revalidate with the origin before every reuse |
| `private` | Only the end client may cache it; shared/proxy caches may not |
| `public` | Any cache may store it, even if the request carried credentials |
| `max-age=60` | Fresh for 60 seconds (`s-maxage` is the shared-cache equivalent) |
| `must-revalidate` | Once stale, do not serve it without revalidation |

`no-store` is the stronger directive and the one this project wants in at least two places: **`GET /health`**, because a liveness probe that returns a cached "OK" defeats its entire purpose and a proxy caching health output is a genuinely bad time; and **any response carrying user-specific task data over shared infrastructure**, because you do not want a proxy handing one user's task list to another. Use `no-store`, or at minimum `private`.

### 5.7 `Access-Control-Allow-Origin`

**The CORS header** — the answer to "why does my browser refuse to talk to my own API." Browsers enforce the **same-origin policy**: JavaScript on `https://app.example.com` may not read responses from `http://localhost:3000` unless the server explicitly opts in with CORS (Cross-Origin Resource Sharing). This header is that opt-in: either `Access-Control-Allow-Origin: *`, or echo one specific origin back along with `Vary: Origin`. Critical details people get wrong:

- **CORS is enforced by the browser, not the server.** `curl` and server-to-server clients ignore it entirely. CORS is **not** an access-control mechanism for your API — it is a browser-side relaxation that stops one site's scripts from reading another site's responses. To protect data you need authentication and authorization, not CORS.
- **The wildcard `*` is incompatible with credentialed requests.** If the client sends cookies or `Authorization` with `credentials: 'include'`, the server must echo a specific origin. When you echo, add `Vary: Origin` so caches do not serve one origin's headers to another.
- **Non-simple requests trigger a preflight.** A request is "simple" only if it uses `GET`, `HEAD`, or `POST` **and** only CORS-safelisted headers **and** a safelisted `Content-Type`. Sending `Content-Type: application/json` makes it non-simple, so the browser first sends `OPTIONS /api/tasks` with `Access-Control-Request-Method: POST` and `Access-Control-Request-Headers: content-type`, and the server must reply with `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`. That preflight is why "my POST works in curl but not in the browser."

## 6. What REST Means

### 6.1 It is a style, not a standard

**REST** stands for **RE**presentational **S**tate **T**ransfer. Roy Fielding described it in his 2000 doctoral dissertation (Chapter 5) as an *architectural style* — a set of constraints — not a specification, not a wire format, not a checklist with a validator.

There is no RFC that says "this API is REST." There is no conformance test and nobody certifies anything. When someone says "RESTful API" they mean "an API that follows the spirit of these constraints, at least the popular ones." Much confusion comes from treating REST as a standard, and much unproductive argument from pointing out that an API violates one constraint — nearly all of them do, including the famous ones.

| Constraint | Meaning in practice |
| --- | --- |
| **Client–server** | UI concerns and data storage concerns are separated |
| **Stateless** | Each request carries everything needed to understand it |
| **Cacheable** | Responses declare whether they may be cached |
| **Uniform interface** | One consistent way to talk to every resource |
| **Layered system** | Proxies, gateways, and load balancers can be inserted transparently |
| **Code on demand** | Optional. Servers may send executable code (e.g. JavaScript) to clients |

The **uniform interface** shapes API design most, and decomposes into four sub-constraints:

1. **Identification of resources** — every interesting thing has a stable identifier (a URL).
2. **Manipulation of resources through representations** — you exchange *representations* (JSON documents) describing resources; you never manipulate the resource itself.
3. **Self-descriptive messages** — a message carries enough metadata (`Content-Type`, method, status) to be processed without out-of-band knowledge.
4. **Hypermedia as the engine of application state (HATEOAS)** — responses include links telling the client what it can do next, so the client needs no hard-coded URL map.

> **The honest note:** HATEOAS is the constraint almost nobody implements. If your responses link to other resources you are closer to REST than most; if they do not, you are in the overwhelming majority. This project does not implement HATEOAS, which is a normal, pragmatic choice.

### 6.2 Resources are nouns; methods are the verb

The central move of REST design: **a URL identifies a thing; an HTTP method says what to do with it.**

- `/api/tasks` identifies **the collection of tasks**.
- `/api/tasks/42` identifies **one specific task**.
- `GET` on either means "give me a representation of the thing you just identified."
- `DELETE /api/tasks/42` means "remove the thing at that URL."

The semantics of the operation come from the *pair* (method, URL); neither half alone is the operation. `/api/tasks/42` is not "the get-task operation" — it is resource identity. That is the whole idea.

A **representation** is the bytes you exchange describing the resource at a moment in time. This project's representation is a JSON object:

```json
{"id":42,"title":"Buy milk","done":false,"priority":"medium"}
```

The resource is the task; the representation is that document. The distinction is not pedantic: the same resource could be represented as JSON, XML, or CSV, and the client negotiates which via `Accept`. A representation is also a snapshot, not a live handle — server-side state can change while you hold one.

### 6.3 Why `/api/tasks/42` is right and `/api/getTaskById?id=42` is not

```
GET /api/tasks/42
GET /api/getTaskById?id=42
```

Both work. Only the first is RESTful. Precisely why:

**1. The second puts the verb in the URL, making the URL an operation name rather than an identifier.** `/api/getTaskById` does not identify a thing; it identifies *a procedure you want run*. That is the **RPC** style, and RPC is a perfectly respectable architecture — gRPC and JSON-RPC are built on it — but it is not REST. In REST the verb lives in the method and the URL stays a noun.

**2. It breaks the uniform interface, which breaks generic tooling.** A `GET` is supposed to be safe, cacheable, and dependent only on the *identity* of the resource. With `?id=42` carrying that identity, caches, log analyzers, rate limiters, and access-control rules all have to be taught your private convention. A cache keyed on `/api/tasks/42` just works. Nothing about `/api/getTaskById?id=42` tells a generic component that `id` is identity rather than a filter — and nothing ever will, because your URL scheme is a local invention.

**3. It does not compose.** Down this road you need `getTaskById`, `getTaskByTitle`, `listTasksByPriority`, `deleteTaskById`, `updateTaskTitleById` — an ever-growing flat namespace of procedure names with ad-hoc parameter conventions. REST offers a small closed set instead: one URL per resource, and five or six methods that mean the same thing everywhere. `GET /api/tasks?priority=high` and `DELETE /api/tasks/42` fall out of the model rather than needing new names.

**4. It leaks the implementation and is not self-descriptive.** `/api/getTaskById` describes how your server does something, and it requires you to know that this project happened to choose that name. `GET /api/tasks/42` describes what exists, with no extra knowledge: "read the resource at this URL, a task with id 42." The second survives refactoring; the first does not.

### 6.4 REST is a spectrum

Honest caveats, because REST discourse is full of purity contests. **Most "REST APIs" are really RPC-flavored HTTP APIs** — they use resource URLs, HTTP methods, status codes, and JSON, and skip HATEOAS, use custom media types, and add the occasional awkward action endpoint. That is fine; it is what people actually mean by REST, and it captures most of the value. **The value is concrete, not aesthetic**: uniform URLs give you caching, predictable client code, reusable middleware, and a design new team members can guess correctly. **Some operations are genuinely not CRUD** — "recompute every task's priority" is not a resource (Section 7.5 covers the options). And **the alternative is legitimate**: gRPC, GraphQL, and JSON-RPC each beat REST at something, so choosing HTTP + REST is choosing a widely understood, cache-friendly, tooling-rich default — not the objectively correct answer.

## 7. Resources and URL Design

URLs are the user interface of your API. They are hard to change once clients depend on them, so they are worth a few minutes of thought.

### 7.1 Plural nouns for collections, an id for items

```
/api/tasks        <- the collection
/api/tasks/42     <- one member of the collection
```

Rules of thumb:

- **Use plural nouns.** `/api/tasks`, not `/api/task` and not `/api/taskList`. The collection URL reads as "all tasks"; one item is that collection plus an identifier. Mixing singular and plural across resources is the most common inconsistency in hand-rolled APIs.
- **Lowercase, hyphen-separated for multi-word segments.** `/api/task-comments`, not `/api/taskComments` or `/api/task_comments`. URL paths are case-sensitive (RFC 3986), and mixed case invites bugs.
- **No file extensions.** `/api/tasks/42`, not `/api/tasks/42.json`. The format is negotiated with `Accept`, which is exactly what that header is for.
- **Identifiers are opaque.** `/api/tasks/42` should not be documented as "42 means the 42nd task created." Clients must treat the id as an opaque string, so you can switch to UUIDs or slugs later without breaking anyone. It also means you must **validate** the segment: `/api/tasks/abc` is not a task id, and blindly running `Number(id)` is how `NaN` propagates into a store lookup and becomes a confusing `500`.
- **Trailing slashes:** pick one form and be consistent. `/api/tasks` and `/api/tasks/` are different URLs to generic infrastructure. Most APIs canonicalize one to the other rather than serving both.

### 7.2 Collections versus items

The same noun appears at two levels, and each level supports different operations — by design:

| URL | Kind | Natural methods |
| --- | --- | --- |
| `/api/tasks` | Collection | `GET` (list), `POST` (create a member) |
| `/api/tasks/42` | Item | `GET` (read), `PUT` / `PATCH` (modify), `DELETE` (remove) |

Note what falls out automatically. `DELETE /api/tasks` cannot mean "delete a task" — it would mean "delete the collection," which this API does not support. So the correct answer is **`405 Method Not Allowed`** with `Allow: GET, POST, HEAD, OPTIONS`. Likewise `POST /api/tasks/42` is not "update task 42" (that would mean "create something subordinate to task 42"), so it is also `405`. A router mapping (method, path-pattern) pairs makes these fall out cleanly instead of needing special cases.

### 7.3 Nesting

Sub-resources are expressed by nesting paths:

```
GET  /api/tasks/42/comments        <- comments belonging to task 42
POST /api/tasks/42/comments        <- add a comment to task 42
GET  /api/tasks/42/comments/7      <- one specific comment
```

**Nest only for genuine containment.** A comment belongs to exactly one task, so nesting expresses reality. If the child can move between parents or be looked up on its own, give it a top-level URL (`/api/comments/7`) or both. **One level of nesting is usually enough; two is the practical ceiling** — `/api/tasks/42/comments/7` is fine, while `/api/projects/3/tasks/42/comments/7/attachments/9` is a design smell; at that point, identify the attachment directly. And **do not nest to express a filter**: "tasks that are done" is not a sub-resource of anything, it is `/api/tasks?done=true`.

### 7.4 Why verbs should not appear in paths

```
POST /api/tasks/42/delete      <- avoid
DELETE /api/tasks/42           <- prefer
```

A verb in the URL has all the costs from Section 6.3, plus a specific one: it duplicates information the method already carries, and the two can contradict each other. What should `GET /api/tasks/42/delete` do? What about `DELETE /api/tasks/42/delete`? You have created a state space with no defined semantics. Keeping the verb in the method and the noun in the URL means there is exactly one place to look for each half of the operation.

### 7.5 Actions that do not map to CRUD

Real systems need operations that are not create/read/update/delete. Three reasonable treatments, roughly in order of REST purity:

**1. Model the action as a sub-resource (a noun).** Instead of `POST /api/tasks/42/complete`, treat a completion as a thing that can be created:

```
POST   /api/tasks/42/completions    -> 201 Created, Location: /api/tasks/42/completions/9
DELETE /api/tasks/42/completions/9  -> 204 No Content   (un-complete)
```

Genuinely RESTful, with a nice property: the history of completions is now addressable. It is also more machinery than a simple flag needs.

**2. Model the action as a field change with `PATCH`.** If "complete" is just a boolean on the task, there is no action at all:

```http
PATCH /api/tasks/42
Content-Type: application/json

{"done":true}
```

This is almost always the right answer for simple state transitions, and it is why `PATCH` exists. `PUT` would also work if the client sent the complete new representation, but requiring a whole document for a one-field change is needlessly risky.

**3. Use a verb segment as a documented, deliberate exception.** `POST /api/tasks/42/complete` is common, readable, and understood by every developer — and technically not REST. If the operation is a genuine process rather than a resource (it triggers side effects, it is not addressable afterward, it has no natural noun), a verb endpoint is defensible. If you do it, **use `POST`**: the action is not idempotent in general and the URL is not an identifier, so no other method fits. Document it explicitly so it reads as a decision rather than a mistake.

Which of these this project uses for any given behavior is recorded in the other docs. The point here is the *reasoning*: prefer a noun, prefer `PATCH`, and reach for a verb only when neither fits.

### 7.6 Query strings versus path segments

This is the distinction beginners blur. **Path segments identify. Query strings parameterize.**

```
/api/tasks?done=false&priority=high&limit=20&offset=40&sort=-createdAt
```

Everything after `?` narrows or shapes *the same collection resource*. The resource is still "the tasks collection"; the query string says which slice of it and in what form. The test: **remove a path segment and you get a different resource; remove a query parameter and you get the same resource, filtered or reshaped.** `/api/tasks/42` without `/42` is a different thing entirely. `/api/tasks?done=false` without `?done=false` is the same thing, unfiltered. So `/api/tasks?limit=20` is right, and `/api/tasks/limit/20` is wrong — the latter reads as "the limit sub-resource named 20."

### 7.7 This project's URL map, reviewed

The whole API is one noun at two levels plus a health probe: `/health` (outside `/api`, correctly, since it describes the process rather than the task domain), `/api/tasks`, and `/api/tasks/:id`. There is no `/api/getTasks`, no `/api/createTask`, and no `/api/tasks/delete/:id`. That economy is the payoff of the style. Note also that `/health` should not be versioned or require authentication, since it answers a question about the process, not about any user's data.

## 8. Idempotency and Safety

These two words are used as synonyms. They are not, and the difference is load-bearing.

### 8.1 Definitions

**Safe** — the method is defined to be read-only. The client is *requesting no state change*, and the server must not make one as a side effect of handling it. Safe does **not** mean "writes nothing at all": logging a request, bumping a metrics counter, and updating a cache are all fine, because they are not part of the resource's state as the client sees it. Safe means the client cannot be held responsible for consequences and may issue the request speculatively.

**Idempotent** — issuing the same request N times (N ≥ 1) has the same **effect on server state** as issuing it once. The **response** may differ between calls; the **state** may not. Two consequences of that wording:

- **Idempotency says nothing about response bodies.** `DELETE /api/tasks/42` → `204 No Content`, then `DELETE /api/tasks/42` → `404 Not Found`. Different responses, same state, therefore idempotent.
- **Idempotency is about the intended effect, not incidental bookkeeping.** If the server stamps `updatedAt` on every call, `PUT /api/tasks/42` with a constant body still counts as idempotent, because the resource's meaningful state is the same after every call. Strict readings of the spec disagree about timestamps; practical API design treats them as incidental.

One implication worth memorizing: **every safe method is idempotent** (if nothing changes, doing it again changes nothing). **The converse is false** — `DELETE` is idempotent but definitely not safe.

### 8.2 Method by method, concretely

**`GET` — safe, idempotent.** Ten `GET /api/tasks` calls leave the store exactly as one call would. Safe to prefetch, safe to cache, safe to retry.

**`POST /api/tasks` — neither.** This is the important one.

```http
POST /api/tasks   {"title":"Buy milk"}   -> 201 Created, Location: /api/tasks/11
POST /api/tasks   {"title":"Buy milk"}   -> 201 Created, Location: /api/tasks/12
```

Two identical requests, two different resources. The reason is structural: a `POST` to a collection asks the server to **assign a new identity** and create a subordinate resource. "Make me a new one" is inherently non-idempotent because *there is no way to say "the same one"* — the request does not name a target. This is not an implementation quirk; it follows from the method's definition.

**`PUT /api/tasks/42` — idempotent, not safe.**

```http
PUT /api/tasks/42   {"title":"Buy milk","done":false}   -> 200 OK
PUT /api/tasks/42   {"title":"Buy milk","done":false}   -> 200 OK
```

The client named the target URI *and* supplied the complete resulting state. After the first call, task 42 has exactly that representation; there is nothing left for the second call to change. **`PUT` means "set the state of `/api/tasks/42` to exactly this."** Setting a value is idempotent by nature, which is also why `PUT` can create: "set it to this" works whether or not it already exists.

Contrast a counter patch: `PATCH /api/tasks/42 {"op":"increment","field":"attempts"}` is not idempotent — three calls give three increments. Even a merge-style patch that sets absolute values, which happens to be idempotent in effect, is not *guaranteed* idempotent by the method's definition, because the server cannot assume the patch document is absolute. That is why RFC 5789 states `PATCH` is neither safe nor idempotent, and why what is idempotent in practice depends on the patch format (JSON Merge Patch, RFC 7396, usually is; JSON Patch, RFC 6902, is not in general).

**`DELETE /api/tasks/42` — idempotent, not safe.** The first call removes the task; the second finds nothing to remove and returns `404 Not Found` — but the state ("no task 42") is the same as after the first. Deleting something already gone does not produce a second deletion. **`HEAD` / `OPTIONS`** are safe and idempotent, by the same reasoning as `GET`.

| Method | Safe? | Idempotent? | Why |
| --- | --- | --- | --- |
| `GET` / `HEAD` / `OPTIONS` | Yes | Yes | Read-only |
| `PUT` | No | **Yes** | "Set state to exactly this" — converges |
| `DELETE` | No | **Yes** | "Ensure this does not exist" — converges |
| `POST` | No | **No** | "Create a new one" — each call makes a new thing |
| `PATCH` | No | **No** (not guaranteed) | Depends on the patch document |

### 8.3 Why this matters: retries and networks

Here is the scenario that makes idempotency a practical concern rather than trivia. Your client sends `POST /api/tasks`; the server receives it, creates task 13, and starts writing the response. Then the network drops, or the process crashes, or a 30-second timeout fires. **The client cannot distinguish these cases:** the request never arrived (nothing happened), the request arrived and was processed but the response was lost (the task exists), or the request arrived and is still being processed (unknown).

The client now holds an ambiguous failure and has two options: **do not retry**, risking silent loss of a task the user believes they created, or **retry**, risking task 13 *and* task 14 for one user action.

With an **idempotent** method the dilemma disappears. Retrying `DELETE /api/tasks/42` after an ambiguous failure is always safe: either it was already deleted (the retry does nothing) or it was not (the retry deletes it). Same for `PUT`: either the write landed and the retry rewrites identical state, or it did not land and the retry performs it. **Idempotent methods let clients retry blindly, which is what makes automated retry, load-balancer failover, and at-least-once delivery workable.** This is also why infrastructure treats methods differently: browsers warn before re-issuing a `POST` on page reload but not a `GET`, and load balancers replay idempotent requests more freely.

> **The standard fix for a non-idempotent `POST`:** an **idempotency key**. The client generates a unique value (`Idempotency-Key: 8f14e45f-...`) and sends the same key on every retry; the server records keys it has seen and, on a repeat, returns the original response instead of creating a second task. Stripe popularized this. This project does not implement it, but it is the answer to "but I need to retry a POST."

### 8.4 It is about state, not responses

The single sentence to take away:

> **Idempotency constrains the effect on the server's state, not the status code or the body the client receives.**

`DELETE` returning `204` then `404` is the canonical proof. A client that treats "the second call returned 404" as a bug will fight the protocol forever. The correct reasoning is: *"`404` on a `DELETE` means the desired end state — task absent — holds. Both responses are success from the caller's point of view."* That is exactly why well-designed clients treat `404` on `DELETE` as a no-op success.

## 9. Statelessness

### 9.1 What it means

**Statelessness** means **each request contains all the information necessary to understand and fulfill it, and the server does not rely on remembered context from previous requests.**

Concretely: when the handler for `GET /api/tasks/42` begins, it may consult the request (method, URL, headers, body) and shared persistent application state (the task store). It may **not** depend on anything stored from an earlier interaction with this specific client. A server is stateless if the response is a pure function of (that request, current shared application state). Restart the process between two requests and nothing the client can observe should change — no progress lost, no "you must call step 1 first" that exists only in a variable.

**Conversation state is what must go, not all state.** That distinction is the one people misread:

| Kept on the server | Stateless? | Why |
| --- | --- | --- |
| The task store (the tasks themselves) | Yes | Shared application state; every client sees the same thing |
| A cache of computed task statistics | Yes | Derivable from shared state; a miss is just slower |
| `sessions[token] = { userId, currentStep: 2 }` | **No** | Per-client progress remembered between requests |
| `pendingUploads[userId] = partialBytes` | **No** | The next request's correctness depends on this one's leftovers |

So this project's in-memory task store does **not** violate statelessness. What would violate it is a server that remembers, say, "user A is halfway through editing task 42" in a variable and expects the next request to continue from there.

### 9.2 Why it matters for scaling

Statelessness is not a philosophical preference; it is the property that makes horizontal scaling work.

**Without it**, per-client context lives in one process's memory, so all of a client's requests must reach that same process. You need **sticky sessions** at the load balancer, which means a process crash silently destroys every user's in-progress work on it; you cannot freely rebalance traffic, since moving a client to another instance breaks it; a hot client cannot be moved off a saturated instance; deploys restart everyone's session; autoscaling is unreliable because a new instance cannot serve existing clients until old ones disconnect; and session data must be replicated across instances, reintroducing coordination and its own failure modes.

**With it**, every request is self-contained and **any instance can serve any request**: a load balancer can pick at random or by least-connections; instances can be added, restarted, or killed at any moment with no client-visible effect; a crashed process loses only in-flight requests, which clients can retry (Section 8); rolling deploys are uneventful; and autoscaling responds instantly. This is also why the **layered system** and **cacheability** constraints become achievable — an intermediary can serve a response from cache only if that response does not depend on hidden per-client state. Statelessness is what makes a `GET` response reusable by someone other than the client that asked for it.

### 9.3 Practical consequences

Statelessness is not free. The costs are the flip side of the benefits, and they are deliberate tradeoffs.

**1. Every request must carry its own credentials.** With no server-side session there is nothing to look up, so a typical authenticated request carries a token in a header:

```http
GET /api/tasks HTTP/1.1
Host: localhost:3000
Accept: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

This is exactly why **bearer tokens** and **JWTs** became popular for APIs: a JWT packs the identity claims *into the request itself* and signs them, so the server can verify them with no lookup and no stored session. That is statelessness applied to authentication.

**2. Credentials travel on every single request**, which is more exposure surface than a session cookie sent once and raises the stakes on credential storage, rotation, and log redaction. TLS mitigates this, and you must use it anyway.

**3. Verification is repeated work.** A session lookup is a fast map access; verifying a signature or introspecting a token on every request costs real CPU. At scale that is measurable, and checking for revoked tokens usually requires a lookup that partly reintroduces state.

**4. Revocation is genuinely hard.** A stateless token is valid until it expires, whether or not you still want it to be; logging a user out server-side requires a denylist, which is server-side state again. The usual compromise is short-lived access tokens plus a stateful refresh-token flow.

**5. Client payloads get bigger.** All the context a session once held now travels on every request — usually a rounding error next to the response, but not always.

**6. Some workflows are naturally stateful.** Multi-step uploads, long-running jobs, and interactive wizards want continuity. The stateless answer is to model progress as an addressable resource — a "job" with its own URL and status — so continuation is a `GET` rather than a remembered variable. That is genuinely RESTful and more work than a `Map`.

**This project's endpoints are stateless by construction.** Every request names its resource in the URL (`/api/tasks/42`), carries the data it needs in the body or query string, and can be served by any process with access to the same task store. There is no hidden "first you must call X."

## 10. JSON as the Representation

### 10.1 Why it won

JSON (JavaScript Object Notation) is standardized as **ECMA-404** and **RFC 8259**. It grew out of JavaScript object literal syntax — Douglas Crockford specified it in the early 2000s — and the reasons it displaced XML are mundane and decisive:

- **It is native to the language you are already writing in.** `JSON.parse` and `JSON.stringify` are built into Node, and the representation maps onto plain objects and arrays with no impedance mismatch and no schema-binding step. In XML a task is not an object; it is an element tree you must walk.
- **It is compact and readable.** `{"id":42,"title":"Buy milk"}` versus `<task><id>42</id><title>Buy milk</title></task>` — less punctuation, less bandwidth, far less eye strain in logs.
- **It is unambiguous where XML is not.** XML has attributes versus elements, namespaces, entities, CDATA, and processing instructions: many ways to encode the same information. JSON has objects, arrays, strings, numbers, booleans, and `null`. That is the entire type system.
- **The tooling is everywhere.** Browsers parse it natively via `response.json()`, every language has a fast parser, and every logging system, database (Postgres `jsonb`, MongoDB), and profiling tool speaks it.
- **One representation for everything.** Request bodies, response bodies, error payloads, and configuration all use the same syntax.

### 10.2 Limitations

These are real and you will hit all of them.

**No date type.** Dates are conventionally ISO 8601 / RFC 3339 strings:

```json
{"id":42,"dueDate":"2025-06-14T09:00:00.000Z","createdAt":"2025-06-09T14:32:07.123Z"}
```

The trailing `Z` means UTC. But **nothing enforces the convention.** Another producer may send `"2025-06-14"` (date only, no time zone), `"06/14/2025"`, or a Unix epoch number — all valid JSON. That is why date handling belongs at the validation boundary: parse, reject anything not in your documented format, and return `422` if it is not. This is a real place where the missing type costs you code.

**No comments, no trailing commas, no single quotes, no unquoted keys.** All of these are JavaScript and none of them are JSON. `{id: 42}` is invalid; `{"id": 42}` is valid — the most common manual typo when hand-writing a test request. It is also why `tsconfig.json` and `.vscode/settings.json` are actually **JSON with Comments (JSONC)**, a superset with a different name precisely because they are not JSON. Do not expect to annotate a request body.

**Numbers are IEEE-754 doubles.** There is exactly one number type, and integers beyond 2<sup>53</sup> − 1 lose precision:

```js
JSON.parse('{"id":9007199254740993}').id   // 9007199254740992 -- silently wrong
```

If you have 64-bit database identifiers, serialize them as **strings** or accept that JavaScript clients will corrupt them.

**No `undefined`, `NaN`, or `Infinity`.** These are not JSON values. `JSON.stringify` silently turns `undefined` properties into *absent* keys, drops functions, and converts `NaN`/`Infinity` to `null`. That silence is a common "where did my field go" bug: a property that is `undefined` does not serialize as `"field": null`, it vanishes. **If a field's absence matters to your contract, normalize it to `null` explicitly.**

**No binary, and always UTF-8.** Binary must be base64-encoded (about 33% larger) or moved to a separate `multipart/form-data` endpoint. There is no encoding negotiation and no way to declare a non-UTF-8 charset.

**Keys must be strings, and objects are unordered.** `{1: "a"}` is invalid JSON, and clients must not depend on key order; serializers may reorder freely. Duplicate keys (`{"id":1,"id":2}`) are legal but unpredictable — `JSON.parse` happens to keep the last, and nothing guarantees that.

**No schema in the format.** `{"title": 42}` is perfectly valid JSON, so validation is entirely your job — which is exactly where `422 Unprocessable Content` comes from in Section 4.3. If you need machine-readable contracts, JSON Schema is the common answer, and it is a separate specification.

**A JSON document is a single value.** Top-level arrays are legal (RFC 8259 clarified this after years of ambiguity), and this project returns one for `GET /api/tasks`. Note the tradeoff: a bare array is slightly harder to extend later than a wrapper object, since `{"data":[...],"next":null}` adds room for pagination and metadata without a breaking change.

## 11. The Full Lifecycle of One Request

Time to connect everything. Here is the complete journey of a single request, from a client's call to a client's parsed result. The concrete example:

```http
POST /api/tasks
Content-Type: application/json

{"title":"Ship the docs","done":false,"priority":"high"}
```

### 11.1 The numbered walkthrough

**1. Client code builds the request.** Application code calls something like `fetch('http://localhost:3000/api/tasks', { method: 'POST', headers: {...}, body: JSON.stringify(task) })`. At this moment it is only a JavaScript object describing an intent; nothing has touched the network.

**2. The client serializes the body.** `JSON.stringify` turns the task into 56 bytes of UTF-8 text. The client computes `Content-Length: 56` from those bytes and sets `Content-Type: application/json`. Anything that is not a JSON value — a `Date` object, an `undefined` field, a function — is silently coerced or dropped right here. This is the first place a bug can hide.

**3. Name resolution and TCP connection.** The client resolves `localhost` to `127.0.0.1` and opens a **TCP connection** to port 3000: the three-way handshake. If nothing is listening you get `ECONNREFUSED` — *before any HTTP exists*. Keep that in mind when debugging: connection errors are not HTTP errors, and no status code will ever describe them. Note that HTTP/1.1 connections are **persistent** by default, so if the client already has an open connection to this server it reuses it and skips this step entirely — which is why "how many connections" and "how many requests" are different numbers.

**4. The client writes bytes to the socket.** Request line, headers, blank CRLF, body — in that order, as raw bytes. The request now exists only as a byte stream in flight.

**5. The server's OS accepts the connection and hands it to Node.** The listening socket accepts, and Node's event loop (via libuv) is notified that the socket is readable. Node reads whatever bytes have arrived.

**6. Node's HTTP parser consumes the stream.** Node's built-in parser (llhttp, from the same family as nginx's) is a state machine over those bytes. It parses the request line into method `POST`, target `/api/tasks`, version `HTTP/1.1`; parses each header line into a name/value pair; recognizes the blank line as the end of the header block; sees `Content-Length: 56` and knows it must read exactly 56 more bytes as the body; and waits, buffering, if they have not all arrived.

This is the crucial thing a framework hides: **arrival of bytes is not arrival of a complete request.** A body may span many TCP segments, and the parser emits nothing until it has a full request. If a client sends `Content-Length: 56` then 40 bytes and stops, this is where the request sits — and eventually the client times out.

**7. Node emits a request event.** Once the request line, headers, and full body are available, the `node:http` server emits a `request` event and invokes the listener registered with `http.createServer(...)`. That listener receives two objects, conventionally named `req` and `res`. **`req`** (an `IncomingMessage`) is a **Readable stream** exposing the method, URL, headers, and body — the body is not a string sitting on a property, so you read it as a stream and concatenate chunks, which is exactly why "parse the JSON body" is something you write yourself here. **`res`** (a `ServerResponse`) is a **Writable stream** for producing the response; nothing has been sent yet, because the response does not begin until you write the status line and headers.

**8. Our code reads and decodes the body.** The handler collects the chunks into a buffer, converts to a UTF-8 string, and calls `JSON.parse`. This step can fail, and the failure mode is defined: if `JSON.parse` throws, or the bytes are not valid UTF-8, the request was **syntactically** broken → **`400 Bad Request`**; if it parses but is not an object (a number, a string, `null`), that is valid JSON of the wrong shape → **`422 Unprocessable Content`**. Before any of that, we should have checked `Content-Type`: if it is `text/plain` or missing, we do not know how to interpret the bytes at all → **`415 Unsupported Media Type`**, and we can refuse without reading the body.

**9. The router matches (method, path) to a handler.** The router takes `req.method` and the path portion of `req.url` (the query string is separate) and finds a handler: it splits `/api/tasks/42` into segments, compares them against registered patterns — `/api/tasks` matches exactly (a **static** segment) while `/api/tasks/:id` matches a **dynamic** segment, capturing `42` as a path parameter — and the method must match too, since the dispatch table is keyed by **(method, path pattern)**. No matching path gives **`404 Not Found`**; a matched path with no method registered for it gives **`405 Method Not Allowed`**, with `Allow` listing what does exist.

This is the answer to "how does a URL become a function call": routing is nothing more than pattern matching over the request line, producing both a handler and the extracted parameters. `node:http` gives you no router at all — every framework, from Express to Fastify to the hand-rolled one here, is essentially a library of (pattern → handler) lookups plus body parsing, built on this one `request` event.

**10. The handler validates the extracted values.** For `POST /api/tasks` there is no path parameter; the body is the whole input. For `PUT /api/tasks/abc` the `:id` segment must be checked — it is not a valid identifier, and blindly coercing it to a number yields `NaN`, which is not a clean `404`. Validation failures here are semantic → **`422`**.

**11. The handler touches the store.** The validated data is written to the shared task store. Note two things: the store is **shared application state**, not per-client session state, so it does not violate statelessness (Section 9); and the operation may be synchronous in memory or asynchronous once it becomes a database call, which is why `node:http` callbacks and `async/await` need explicit glue rather than just being awaited by the server.

**12. The handler chooses a status code and headers.** This is Section 4 in action. For a successful create: **`201 Created`** because a new resource exists; **`Location: /api/tasks/3`** for where it lives; **`Content-Type: application/json; charset=utf-8`**; an exact **`Content-Length`**; and optionally `Cache-Control: no-store` if the response must never be cached.

**13. The response is serialized.** `JSON.stringify` converts the returned value to a string, and its byte length is measured with `Buffer.byteLength` for `Content-Length`. Fields that are `undefined` vanish here — the last silent failure point on the way out, mirroring step 2.

**14. The response bytes are written to the socket.** Writing the status line and headers flushes them, then the body is written. If `Content-Length` was set, the client knows exactly where the message ends; if not, Node falls back to chunked framing (Section 1.2) and writes a terminating zero-length chunk. In a plain `node:http` server, **nothing is sent until you explicitly write** — there is no framework magic to send a response for you, and forgetting to end the response leaves the client hanging until it times out.

**15. Node returns to the event loop.** With `keep-alive`, the socket stays open waiting for the client's next request, and the handler's local variables are gone. If another request arrives, the lifecycle restarts at step 6 with a completely fresh request and no state carried over — statelessness, observed from the inside.

**16. The client parses the response.** It reads the status line and headers, then the body (using `Content-Length`, chunked framing, or the no-body rules of Section 1.1). It sees `201`, reads `Location` to learn the new resource's URL, and calls `JSON.parse` on the body to get the created task. Only now does the calling application code resume with a value.

**17. Everything unwinds.** Any `await` in the client code resolves and the application reacts to the created task. Had the client seen a `4xx` instead, it would branch into error handling — and the specific code received (`400` vs `415` vs `422` vs `404` vs `405`) determines which branch, which is why the distinctions in Section 4 are worth getting right.

Everything in steps 5 through 7 is what `node:http` gives you for free. Steps 8 through 14 are what a framework would otherwise provide: routing, body parsing, validation, status selection, and serialization. Building them by hand means writing every line that sits between an HTTP byte stream and your application logic — which is why this document spent its time on the wire format, the semantics of methods and status codes, and the design vocabulary of resources.

## Further Reading

- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html): methods, status codes, headers. The single most important document here.
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html) and [RFC 9112 — HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112.html): caching, message framing, and the request line.
- [RFC 8259 — JSON](https://www.rfc-editor.org/rfc/rfc8259.html), [RFC 5789 — PATCH](https://www.rfc-editor.org/rfc/rfc5789.html), and [RFC 3986 — URI syntax](https://www.rfc-editor.org/rfc/rfc3986.html).
- [Roy Fielding, *Architectural Styles and the Design of Network-based Software Architectures* (2000), Chapter 5](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm): the origin of REST.
- [MDN — HTTP reference](https://developer.mozilla.org/en-US/docs/Web/HTTP) for quick lookups of individual headers and status codes, and the [Node.js `node:http` documentation](https://nodejs.org/api/http.html).
