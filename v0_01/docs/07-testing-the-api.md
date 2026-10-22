# Testing the API

The previous chapters described the API and the code behind it. This one is about what you will actually spend your career doing: **calling the API and finding out what it really does.**

That means three things, in increasing order of automation:

1. Talking to the server by hand with `curl` (the fastest feedback loop there is).
2. Reading the response correctly, so you know whether a failure is your fault or the server's.
3. Writing automated tests that check the API's promises forever, without you typing anything.

Every transcript below was captured from this project running on Windows. Where output was trimmed, it says so. Every command uses `curl.exe`, not `curl` -- Section 4 explains why that distinction is the most important thing in this chapter for a Windows user.

## 1. Before You Start

Start the server from the project root:

```powershell
npm run dev
```

That runs `node --watch src/server.ts`. Node's `--watch` restarts on every file change, so you can edit a route, save, and your next request hits the new code. Nothing is compiled: Node 24 strips the TypeScript types on the fly. If you would rather not have automatic restarts, run `node src/server.ts` yourself.

The server prints a banner when it comes up:

```
  dev_node-api  listening on http://127.0.0.1:3999
  environment   development
  node          v24.22.0
```

The address is where to point `curl.exe`. The environment label is a free-form `NODE_ENV` string shown only here. The Node version tells you which runtime is running.

**The default address is `http://127.0.0.1:3000`.** `127.0.0.1` is the loopback address: traffic to it never leaves your machine, and nothing outside can reach the server. That is the safe default while learning. Set `HOST=0.0.0.0` only when you deliberately want another machine -- or a phone on your Wi-Fi -- to reach the API.

**The store is seeded with four sample tasks at startup** (see `src/data/seed.ts`), so your first `GET /api/tasks` returns four items rather than zero. Start empty with `$env:SEED_DATA='false'; npm run dev` (that is PowerShell syntax; Section 4.3 explains why the bash form fails).

**The store is in memory, so a restart wipes everything.** There is no file and no disk. Stop and start the server and your tasks are gone, replaced by the original four. Because `--watch` restarts on every save, editing a source file also throws your test data away -- a surprise that catches everyone at least once. Two servers on two ports have two entirely separate stores.

**To change the port, set the variable and then start:**

```powershell
$env:PORT=3001; npm run dev
```

The banner reports the address actually bound, so read it rather than assuming. If the port is taken, startup fails with a message naming the port and a `Get-NetTCPConnection` command to find the culprit. Permanently, copy `.env.example` to `.env` and edit it -- the npm scripts pass `--env-file-if-exists=.env`, so Node loads it for you.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. `0` means "pick a free one" |
| `HOST` | `127.0.0.1` | Interface to bind to. `0.0.0.0` exposes it to your network |
| `CORS_ORIGIN` | `*` | Value echoed in `Access-Control-Allow-Origin` |
| `MAX_BODY_BYTES` | `100000` | Bodies larger than this get a `413` |
| `LOG_REQUESTS` | `true` | Set to `false` to silence the access log |
| `SEED_DATA` | `true` | Set to `false` to start with an empty store |
| `NODE_ENV` | `development` | Free-form label, banner only |

Booleans accept `true`/`false`, `1`/`0` and `yes`/`no`; anything else is a startup error, on purpose.

With `LOG_REQUESTS` on, every request is logged after the response is sent:

```
19:33:07.211 GET    /health 200 3.8ms
19:33:07.262 POST   /api/tasks 201 1.8ms
19:33:15.377 GET    /api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5 200 0.6ms
19:33:15.410 PUT    /api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5 200 1.0ms
19:33:15.467 DELETE /api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5 204 0.6ms
19:33:15.504 DELETE /api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5 404 0.9ms
19:33:22.877 PATCH  /api/tasks 405 0.4ms
```

Read it as time, method, path, status, duration. Two lines are instructive: the two `DELETE`s on the same path differ only in status (`204`, then `404`), which is the whole story of deleting twice; and `PATCH /api/tasks` is a `405` because `PATCH` is not routed on the collection. Keep this terminal visible in a second window while you work -- the client's view and the server's view together explain almost every surprise.

## 2. What a REST Client Actually Does

Strip away the tooling and every HTTP interaction is the same two messages.

**The request:**

| Part | Example | Required? |
| --- | --- | --- |
| Method | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | Yes |
| URL | `http://127.0.0.1:3000/api/tasks?limit=2` | Yes |
| Headers | `Content-Type: application/json` | Only some |
| Body | `{"title":"Write the docs"}` | Only for writes |

**The response:**

| Part | Example | Always present? |
| --- | --- | --- |
| Status | `201 Created` | Yes |
| Headers | `Location: /api/tasks/2164807c-...` | Varies |
| Body | `{"id":"2164807c-...","title":"Write the docs"}` | No -- `204` has none |

`curl`, Postman, the browser's Network tab, `fetch` in a test, and the mobile app someone writes next year all construct and read these same messages. The tooling differs; the messages do not. Here is a real `POST`, seen with `curl.exe -i`:

```
HTTP/1.1 201 Created
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Location: /api/tasks/2164807c-1594-4d83-85a1-16b39c5f5b5b
Content-Type: application/json; charset=utf-8
Content-Length: 203

{"id":"2164807c-1594-4d83-85a1-16b39c5f5b5b","title":"Write the docs","description":null,"priority":"high","completed":false,"createdAt":"2026-10-16T19:33:07.262Z","updatedAt":"2026-10-16T19:33:07.262Z"}
```

Everything above the blank line is the status line plus headers; everything below is the body. The blank line is the separator and it is mandatory even when the body is empty -- that is how a parser knows the headers have ended.

Mapping the pieces onto this project:

- **`HTTP/1.1 201 Created`** -- protocol version, numeric status, and a decorative reason phrase. Clients use the number; the phrase is for humans.
- **`Location: /api/tasks/2164807c-...`** -- the URL of the resource just created. It is relative, so a client resolves it against the base it requested. `POST` tells you where your new thing lives without a second round trip.
- **`X-Total-Count`** -- a custom header on `GET /api/tasks` reporting how many tasks matched *before* pagination. Not a standard; this API documents it, so clients may rely on it.
- **`Content-Length: 203`** -- the body size in **bytes**, not characters.
- **`Cache-Control: no-store`** and **`X-Content-Type-Options: nosniff`** -- on every response. The first stops caches handing you a stale list after a write; the second stops browsers second-guessing the declared content type.
- **`Access-Control-Allow-Origin: *`** -- the CORS header (Section 9).

| Method | Meaning in this API | Request body | Response body |
| --- | --- | --- | --- |
| `GET` | Read. Never changes anything | None | The resource or collection |
| `POST` | Create a new item in the collection | Full task fields | Created task, `201`, `Location` |
| `PUT` | **Replace** the item wholesale | Full task fields | The replaced task |
| `PATCH` | **Partially update** -- only the fields you send | A subset | The updated task |
| `DELETE` | Remove the item | None | None (`204`) |
| `OPTIONS` | Ask what is allowed here; browsers preflight with it | None | Headers only (`204`) |

The `PUT` versus `PATCH` distinction is the one that trips people up, and Section 6.5 shows the difference in real output.

## 3. curl From Scratch

**curl** is a command-line HTTP client. It has shipped with Windows since Windows 10 version 1803 (as `curl.exe` in `C:\Windows\System32`), exists on essentially every Linux and macOS machine, and is the closest thing to a universal way of describing an HTTP request. When someone writes a bug report containing a `curl` command, everyone can reproduce it exactly. The shape is always:

```powershell
curl.exe [flags] URL
```

| Flag | Long form | What it does |
| --- | --- | --- |
| `-i` | `--include` | Print the response **headers** as well as the body |
| `-s` | `--silent` | Suppress the progress meter and error chatter |
| `-X` | `--request` | Set the HTTP method explicitly |
| `-H` | `--header` | Add a request header |
| `-d` | `--data` | Send a body; implies `POST` |
| (none) | `--data-binary` | Send a body verbatim, byte for byte |
| `-o` | `--output` | Write the body to a file instead of stdout |
| `-w` | `--write-out` | Print a chosen value after the transfer |
| `-I` | `--head` | Send `HEAD` instead of `GET` |

**`-i` is not optional while you are learning.** Without it you see only the body, and the body of a successful `DELETE` is empty -- so you cannot tell a `204` from a failure. `-i` is what turns "prints some JSON" into a debugging tool. **`-s`** is cosmetic but earns its place: without it curl writes a progress meter to stderr, useful when uploading a large file over a slow link and pure noise the rest of the time. Combined, `curl.exe -s -i URL` means "quiet, but show me everything".

Your first request:

```powershell
curl.exe -s -i http://127.0.0.1:3000/health
```

```
HTTP/1.1 200 OK
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 98
Date: Fri, 16 Oct 2026 19:33:07 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"status":"ok","uptimeSeconds":31,"nodeVersion":"v24.22.0","timestamp":"2026-10-16T19:33:07.207Z"}
```

`Content-Type` tells you the body is UTF-8 JSON, which determines how to read the bytes. `Content-Length` lets a client detect a truncated response. `Date`, `Connection` and `Keep-Alive` are added by Node's HTTP server itself, not by the application -- they are normal and you can ignore them. `uptimeSeconds` differs on every run, so expect that one field to move when you diff output.

### 3.1 Why `-d` produces a confusing `415`

`curl.exe -d` does two things behind your back, and one of them bites everyone once:

1. It **implies `POST`**, so you never have to say `POST` -- though this guide does, for readability.
2. It **defaults `Content-Type` to `application/x-www-form-urlencoded`** -- the encoding an HTML form uses -- unless you set a different one.

This API requires JSON, so the natural-looking version fails:

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/tasks -d '{"title":"x"}' -w "`nstatus=%{http_code}`n"
```

```json
{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"This endpoint requires a JSON request body. Send the header \"Content-Type: application/json\"."}}
status=415
```

The server did the right thing: it received a body claiming to be form-encoded and refused to guess. The fix is one `-H` flag.

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" -d '{"title":"x"}'
```

**Whenever this API returns `415 Unsupported Media Type`, the cause is a missing or wrong `Content-Type` header nine times out of ten.**

### 3.2 `-o NUL` and `-w` for scripted checks

`-w` prints text after the transfer, with `%{...}` placeholders substituted. It turns `curl` from something you read into something a script can branch on:

```powershell
curl.exe -s -o NUL -w "status=%{http_code} bytes=%{size_download}`n" "http://127.0.0.1:3000/api/tasks?limit=2"
```

```
status=200 bytes=608
```

`-o NUL` throws the body away; on Windows `NUL` is the null device (the Unix `/dev/null`). Combined with `-s`, a request reduces to one line of numbers -- what you want inside a script or a CI check. The backtick-`` `n `` is a PowerShell newline escape; in bash you would write `'\n'` in single quotes.

### 3.3 Two more footnotes

**`-X` only sets the method.** `curl.exe -X POST URL` with no `-d` or `--data-binary` sends a `POST` with **no body at all**. If you need an empty-but-valid body (a `PATCH` with `{}`), you must send it explicitly: `-X POST -H "Content-Type: application/json" -d '{}' URL`.

**`-I` sends `HEAD`, not `GET`.** It is easy to misread as "GET, but show me the headers". Since this API does not route `HEAD`, you get a `405`:

```powershell
curl.exe -s -I http://127.0.0.1:3000/api/tasks
```

```
HTTP/1.1 405 Method Not Allowed
Allow: GET, OPTIONS, POST
Content-Type: application/json; charset=utf-8
```

Use lowercase `-i` to see the headers of the request you actually meant to send.

## 4. PowerShell on Windows: Five Real Traps

Each of these was reproduced on this machine, and each produces a confusing symptom if you do not know about it. They are listed roughly by how much time they cost people.

### 4.1 Trap 1: `curl` is an alias for `Invoke-WebRequest`

**Symptom.** You copy a `curl` command from a tutorial and get something that looks nothing like the tutorial:

```powershell
curl -i http://127.0.0.1:3000/health
```

```
cmdlet Invoke-WebRequest at command pipeline position 1
Supply values for the following parameters:
Uri:
```

Or, with a URL present, a table of properties (`StatusCode`, `StatusDescription`, `Headers`, `RawContent`) instead of raw HTTP text. **You are not running curl at all.**

**Cause.** Windows PowerShell 5.1 ships a built-in alias mapping the name `curl` to the cmdlet `Invoke-WebRequest`. Alias resolution happens before anything else, so typing `curl` never reaches `C:\Windows\System32\curl.exe`.

**See it for yourself:**

```powershell
Get-Command curl
```

```
Name        : curl
CommandType : Alias
Source      :
Definition  : Invoke-WebRequest
```

`CommandType : Alias` and `Definition : Invoke-WebRequest` are the tell. The alias table shows it more compactly:

```powershell
Get-Alias -Name curl
```

```
CommandType Name                      Version Source
----------- ----                      ------- ------
Alias       curl -> Invoke-WebRequest
```

**The fix: always type `curl.exe`.** The `.exe` extension bypasses alias resolution and runs the real program. Compare:

```powershell
Get-Command curl         # -> Alias       : Invoke-WebRequest
Get-Command curl.exe     # -> Application : C:\Windows\System32\curl.exe
```

Two things make this worse in the wild. `wget` is aliased the same way, and **`curl` is not aliased in PowerShell 7 or later** -- so a tutorial author on PowerShell 7 can write `curl` and be correct while you, on 5.1, are not. Typing `curl.exe` is correct on both, which is why it should be a habit rather than a workaround. You can confirm what you have:

```powershell
curl.exe --version
```

```
curl 8.21.0 (Windows) libcurl/8.21.0 Schannel zlib/1.3.2 WinIDN WinLDAP
```

### 4.2 Trap 2: `Invoke-WebRequest` cannot easily show a `4xx` body

**Symptom.** The API returns a `404` with a helpful JSON explanation, and PowerShell shows an exception instead of the body:

```
Invoke-WebRequest : The remote server returned an error: (404) Not Found.
    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebResponse:HttpWebResponse)
   [Invoke-WebRequest], WebException
```

**Cause.** In PowerShell 5.1, `Invoke-WebRequest` raises a terminating error for any `4xx` or `5xx` response. PowerShell 7 added `-SkipHttpErrorCheck` to return the response instead of throwing. That flag **does not exist in 5.1**:

```powershell
(Get-Command Invoke-WebRequest).Parameters.Keys -contains 'SkipHttpErrorCheck'
```

```
False
```

This machine reports `$PSVersionTable.PSVersion` as `5.1.26100.9711`, so you are in the version without it.

**The fix, and the honest caveat.** The pattern most blog posts recommend catches the exception and reads `$_.Exception.Response`. On this machine it gives you the status code but **not the body** -- `Invoke-WebRequest` consumes the response stream internally while building its error record, so reading it afterwards returns zero bytes:

```powershell
try {
  Invoke-WebRequest -Uri http://127.0.0.1:3000/api/tasks/nope -UseBasicParsing -ErrorAction Stop
} catch {
  $response = $_.Exception.Response
  Write-Output "status: $([int]$response.StatusCode)"                                              # 404
  Write-Output "body:   $((New-Object System.IO.StreamReader($response.GetResponseStream())).ReadToEnd())"  # empty
}
```

The version that genuinely works skips the cmdlet and uses the .NET HTTP client underneath it, where nothing reads the stream for you:

```powershell
$request = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:3000/api/tasks/nope')
try { $response = $request.GetResponse() } catch [System.Net.WebException] { $response = $_.Exception.Response }
Write-Output "status: $([int]$response.StatusCode)"
$reader = New-Object System.IO.StreamReader($response.GetResponseStream())
Write-Output "body:   $($reader.ReadToEnd())"
$reader.Dispose(); $response.Dispose()
```

```
status: 404
body:   {"error":{"code":"NOT_FOUND","message":"No task exists with id \"nope\"."}}
```

Note the catch block: `GetResponse()` throws on `4xx`/`5xx` just like the cmdlet, and the catch is where the response actually lives.

**Recommendation: use `curl.exe` and sidestep the whole problem.** curl does not treat an error status as exceptional -- it prints the status line and the body and exits normally, so a `404` transcript looks exactly like a `200` one:

```powershell
curl.exe -s -i http://127.0.0.1:3000/api/tasks/nope
```

```
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Content-Length: 75

{"error":{"code":"NOT_FOUND","message":"No task exists with id \"nope\"."}}
```

That is the behavior you want when debugging. Section 5.2 has a PowerShell helper if you truly need to stay in PowerShell.

### 4.3 Trap 3: `PORT=3001 npm run dev` does not work

**Symptom.** The bash-style inline assignment is not recognized:

```powershell
PORT=3001 npm run dev
```

```
PORT=3001 : The term 'PORT=3001' is not recognized as the name of a cmdlet, function,
script file, or operable program.
```

**Cause.** Putting an assignment before a command is a **bash** feature: bash sets the variable for the duration of that one command. PowerShell has no such syntax and reads `PORT=3001` as the name of a program to run.

**The fix.** Set the variable as its own statement:

```powershell
$env:PORT=3001; npm run dev
```

`$env:PORT` is PowerShell's syntax for the process environment, and the semicolon separates the statements. The variable stays set for the rest of the session, so every command in that window now targets port 3001. For one command only:

```powershell
$env:PORT='3001'; npm run dev; Remove-Item Env:PORT
```

The cleanest option for this project is `.env`, since the npm scripts already load it and it is git-ignored. The same problem applies to every other variable in Section 1 and to any guide showing `VAR=value command`: translate it to `$env:VAR='value'; command`.

### 4.4 Trap 4: PowerShell mangles JSON passed to `curl.exe`

**Symptom.** The server rejects your body as invalid JSON, or curl complains about braces:

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" -d "{"title":"Write the docs"}"
```

```
curl: (3) unmatched close brace/bracket in URL position 8:
Write the docs"}
```

**Cause.** Two layers of quoting fight each other. PowerShell parses the command line first, then hands the pieces to `curl.exe` through a Windows command line which curl re-parses. Double quotes inside double quotes terminate each other, so that is not one argument -- it is a fragment of several, and curl tries to interpret the middle pieces as URLs. Backslash-escaping (`\"`) helps inconsistently across PowerShell versions, because 5.1 removes some backslashes before curl ever sees them.

**The fix: never put JSON on the command line.** Write it to a file and hand curl the file:

```powershell
$body = '{"title":"  Write the docs  ","description":"","priority":"high"}'
Set-Content -Path "$env:TEMP\task.json" -Value $body -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" --data-binary "@$env:TEMP\task.json"
```

Three details make this work. `$body = '...'` uses **single** quotes, so PowerShell treats the contents literally. `-NoNewline` stops `Set-Content` appending a trailing newline, which is harmless for JSON but makes byte counts confusing. And `"@$env:TEMP\task.json"` uses curl's `@` prefix -- "read the body from this file" -- in double quotes so PowerShell expands `$env:TEMP` first.

There is a harder reason to prefer files. **Windows limits a command line to roughly 32,000 characters**, so a 200,000-byte body cannot be passed with `-d` at all, however you quote it:

```
Program 'curl.exe' failed to run: The filename or extension is too long
```

Sending the same bytes from a file works, and produces exactly the failure you were trying to test:

```powershell
Set-Content -Path "$env:TEMP\big.json" -Value ('{"title":"' + ('a' * 200000) + '"}') -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" --data-binary "@$env:TEMP\big.json"
```

```
HTTP/1.1 413 Payload Too Large
Content-Type: application/json; charset=utf-8

{"error":{"code":"PAYLOAD_TOO_LARGE","message":"The request body is larger than the 100000 byte limit."}}
```

### 4.5 Trap 5: `NUL` is the null device

Following a Unix tutorial's `-o /dev/null` fails on Windows, because that path does not exist. The Windows equivalent is `NUL`, spelled with no path at all and handled by Windows itself, so it works in `cmd.exe` and PowerShell alike:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3000/health
```

```
200
```

If you want the body later, use a real path instead:

```powershell
curl.exe -s -o "$env:TEMP\tasks.json" http://127.0.0.1:3000/api/tasks
Get-Content "$env:TEMP\tasks.json" | ConvertFrom-Json | Select-Object -First 1
```

### 4.6 One more: `node -e` is CommonJS

Not a PowerShell trap, but you will use it constantly. `node -e "..."` runs a one-liner in CommonJS mode regardless of `"type": "module"` in `package.json`, so `require` works:

```powershell
node -e "console.log(process.version); const os = require('node:os'); console.log(os.platform())"
```

```
v24.22.0
win32
```

Files still follow `package.json`, so a `.ts` file in this project is an ES module using `import`. Add `--input-type=module` if a one-liner ever needs ESM semantics.

## 5. A Reusable Request-Body Pattern

You will send a lot of JSON while learning this API. Pick one pattern and reuse it, so you spend your time debugging the API rather than the shell:

```powershell
# 1. Put the JSON in a PowerShell single-quoted string. Nothing is expanded.
$json = '{"title":"Write the docs","priority":"high"}'

# 2. Write it to a temp file. -NoNewline keeps the byte count exact.
Set-Content -Path "$env:TEMP\body.json" -Value $json -NoNewline

# 3. Send the file. The @ prefix means "read the body from here".
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\body.json"
```

The backtick is PowerShell's line-continuation character, so the command can span lines for readability.

### 5.1 Why `--data-binary` and not `-d`

Both read a file when given `@path`, but they differ in what they do to the bytes:

| | `-d @file` | `--data-binary @file` |
| --- | --- | --- |
| Newlines in the file | Stripped | Preserved |
| Binary bytes | May be altered | Passed through exactly |
| Sets `Content-Type` default | Yes, form-urlencoded | No |
| Sends the file byte for byte | No | Yes |

`-d` is designed around HTML form submissions and performs the cleanup form encoding expects. `--data-binary` sends the contents untouched -- which is what you want for JSON, where an alteration changes the byte count and can change the meaning. You still need the explicit `-H "Content-Type: application/json"`.

### 5.2 A small PowerShell helper

If you would rather stay inside PowerShell, this function -- verified against this project -- sends a request and returns the status, the `Location` header and the body without throwing on `4xx`/`5xx`:

```powershell
function Send-ApiRequest {
  param(
    [string]$Method,
    [string]$Url,
    [string]$Json
  )

  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.Method  = $Method
  $request.Accept  = 'application/json'
  $request.Timeout = 10000

  if ($PSBoundParameters.ContainsKey('Json')) {
    $request.ContentType = 'application/json'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Dispose()
  }

  try   { $response = $request.GetResponse() }
  catch [System.Net.WebException] { $response = $_.Exception.Response }

  $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
  $body    = $reader.ReadToEnd()
  $reader.Dispose()

  $result = [pscustomobject]@{
    Status   = [int]$response.StatusCode
    Location = $response.Headers['Location']
    Body     = $body
  }
  $response.Dispose()
  return $result
}
```

Used like this:

```powershell
$created = Send-ApiRequest -Method POST -Url 'http://127.0.0.1:3000/api/tasks' -Json '{"title":"From PowerShell","priority":"low"}'
$created.Status      # 201
$created.Location    # /api/tasks/83625226-cd3c-4def-818f-6205ca085bb0
$created.Body | ConvertFrom-Json | Select-Object title, priority

$missing = Send-ApiRequest -Method GET -Url 'http://127.0.0.1:3000/api/tasks/nope'
$missing.Status      # 404
$missing.Body        # {"error":{"code":"NOT_FOUND",...}}
```

Three things it gets right that are easy to get wrong. It sends the body as **UTF-8 bytes with a matching `ContentLength`**, not as a string -- getting that length wrong by one byte causes a hang where the server waits for a body that never finishes arriving, and non-ASCII text makes the discrepancy easy to produce (`{"title":"Café"}` is longer in bytes than in characters). It **catches `[System.Net.WebException]` and keeps the response**, which is where the `404` body lives, with nothing having consumed the stream (Section 4.2). And it returns the status as a number, so a test reads `if ($created.Status -eq 201)` rather than pattern-matching a string.

`curl.exe` remains the better default for interactive exploration: one line, no function to paste, output directly comparable with this document. Keep this helper for when you want a result *value* in a script.

## 6. A Guided Tour of Every Endpoint

Every command assumes the server is at `http://127.0.0.1:3000`. `-i` is included throughout. Where a transcript is long, headers are trimmed and it says so.

### 6.1 `GET /health`

```powershell
curl.exe -s -i http://127.0.0.1:3000/health
```

```
HTTP/1.1 200 OK
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 98
Date: Fri, 16 Oct 2026 19:33:07 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"status":"ok","uptimeSeconds":31,"nodeVersion":"v24.22.0","timestamp":"2026-10-16T19:33:07.207Z"}
```

**Notice:** `/health` is not under `/api`, deliberately -- it is infrastructure, not part of the API surface, and `/api/health` returns a `404`. A health endpoint is the one URL you can poll without knowing anything about the application, which is why load balancers and container orchestrators want it. The body also names the runtime, which makes it useful for "am I talking to the server I think I am?" checks.

### 6.2 `GET /api/tasks` -- the collection

```powershell
curl.exe -s -i "http://127.0.0.1:3000/api/tasks?limit=2"
```

```
HTTP/1.1 200 OK
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
X-Total-Count: 4
Content-Type: application/json; charset=utf-8
Content-Length: 620

[{"id":"f7ac5960-ef8f-492e-90a1-56b178916057","title":"Read the HTTP and REST fundamentals chapter","description":"docs/01-http-and-rest-fundamentals.md covers methods, status codes and headers from first principles.","priority":"high","completed":false,"createdAt":"2026-10-16T19:32:36.535Z","updatedAt":"2026-10-16T19:32:36.535Z"},{"id":"8f83ce2d-3e99-4246-9676-abe415bb546e","title":"Send a request with curl","description":"Try the examples in docs/07-testing-the-api.md against your local server.","priority":"medium","completed":false,"createdAt":"2026-10-16T19:32:36.536Z","updatedAt":"2026-10-16T19:32:36.536Z"}]
```

**Notice four things:**

1. **The body is a bare JSON array**, not an object with a `tasks` key. That changes how clients parse it: `await res.json()` is the array, not `(await res.json()).tasks`.
2. **`X-Total-Count: 4` while only two tasks came back.** This reports how many tasks matched *before* `limit` was applied. Without it a client cannot distinguish "there are 2 tasks" from "there are 4 and you are seeing page 1", so correct pagination is impossible.
3. **Ids are UUID strings**, not integers. Never assume they are sequential or guessable -- use the `id` the server gave you.
4. **`description` may be `null`**, but `priority` and `completed` never are. `priority` is `"low"`, `"medium"` or `"high"`; timestamps are ISO 8601 UTC strings ending in `Z`.

#### Filtering

```powershell
curl.exe -s -i "http://127.0.0.1:3000/api/tasks?completed=true"
```

```
HTTP/1.1 200 OK
X-Total-Count: 1
Content-Type: application/json; charset=utf-8

[{"id":"85590fb8-0e89-4a3a-a0c4-5dc2c105edbb","title":"Install a Node version with nvm","description":"Run `nvm use` in the project root; it reads the version from .nvmrc.","priority":"low","completed":true,"createdAt":"2026-10-16T19:37:25.526Z","updatedAt":"2026-10-16T19:37:25.526Z"}]
```

Filters combine: `?completed=false&priority=high`. The supported parameters:

| Parameter | Accepted values | Notes |
| --- | --- | --- |
| `completed` | `true` or `false` | Any other value is a `400` |
| `priority` | `low`, `medium`, `high` | Case-sensitive |
| `limit` | Whole number, 1 to 100 | Default `20` |
| `offset` | Whole number, 0 to 1000000 | Default `0` |

**Unknown parameters are rejected with a `400`, not ignored.** That is deliberate: `?completd=true` silently returning everything is a nasty bug to chase.

```powershell
curl.exe -s -i "http://127.0.0.1:3000/api/tasks?completd=true"
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"error":{"code":"BAD_REQUEST","message":"One or more query parameters are invalid.","details":[{"field":"completd","message":"Unknown query parameter. Supported parameters are: completed, priority, limit, offset."}]}}
```

The error names the offending parameter and lists the supported ones. Read the `details` array -- it answers exactly the question you are about to ask.

#### Paging through the collection

```powershell
curl.exe -s "http://127.0.0.1:3000/api/tasks?limit=2&offset=0"   # tasks 1-2
curl.exe -s "http://127.0.0.1:3000/api/tasks?limit=2&offset=2"   # tasks 3-4
curl.exe -s "http://127.0.0.1:3000/api/tasks?limit=2&offset=4"   # []
```

The third request returns an empty array with a `200`, and `X-Total-Count` is still `4`. Running off the end of the list is a normal successful state: you have read everything. A client loops until the page is empty, or until `offset + limit >= X-Total-Count`; both work.

### 6.3 `POST /api/tasks` -- create

```powershell
$body = '{"title":"  Write the docs  ","description":"","priority":"high"}'
Set-Content -Path "$env:TEMP\create.json" -Value $body -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\create.json"
```

```
HTTP/1.1 201 Created
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Location: /api/tasks/2164807c-1594-4d83-85a1-16b39c5f5b5b
Content-Type: application/json; charset=utf-8
Content-Length: 203

{"id":"2164807c-1594-4d83-85a1-16b39c5f5b5b","title":"Write the docs","description":null,"priority":"high","completed":false,"createdAt":"2026-10-16T19:33:07.262Z","updatedAt":"2026-10-16T19:33:07.262Z"}
```

**Notice three things:**

1. **`201`, not `200`.** `200 OK` means "here is what you asked for"; `201 Created` means "I made a new thing, and here is where it lives". That is how a client can tell a create from an update without knowing which request it sent.
2. **`Location: /api/tasks/2164807c-...`** is the new resource's URL. A client that only wants the id reads the header instead of parsing the body. It is **relative** (no scheme or host), so resolve it against the base you requested -- `new URL(location, baseUrl)` does that correctly.
3. **The request and the response do not match, on purpose.** The request sent `"  Write the docs  "` and got back `"Write the docs"` -- **the title was trimmed.** The request sent `""` for `description` and got back `null` -- **an empty string is normalized to no description**, because the two are the same idea and this API refuses to store both. `completed` was omitted and came back `false`, the documented default.

That last point is the one to internalize: **the response is the truth, not your request.** Always read the created resource out of the response rather than assuming the server stored exactly what you sent. The body rules for `POST` and `PUT`:

| Field | Required | Rules |
| --- | --- | --- |
| `title` | Yes | String, trimmed, must not be empty, max 200 characters |
| `description` | No | String or `null`, max 2000 characters, `""` becomes `null` |
| `priority` | No | `"low"`, `"medium"` or `"high"`; defaults to `"medium"` |
| `completed` | No | Boolean; defaults to `false` |

Anything else is **rejected**, not ignored (Section 7.4).

### 6.4 `GET /api/tasks/:id` -- read one

```powershell
curl.exe -s -i http://127.0.0.1:3000/api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5
```

```
HTTP/1.1 200 OK
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 206

{"id":"4656e53e-35e3-4314-b863-6cc1c05d7fd5","createdAt":"2026-10-16T19:33:15.253Z","title":"Totally replaced","description":null,"priority":"medium","completed":true,"updatedAt":"2026-10-16T19:33:15.439Z"}
```

**Notice:** the body is a **single JSON object**, whereas the collection returned a **bare array**. Same resource, different shape depending on whether you addressed one item or the collection. A task's URL is `<collection>/<id>` -- the same URL that `Location` gave you after the `POST`, and the same one you use with `PUT`, `PATCH` and `DELETE`. An unknown id gives a `404` naming the id (Section 7.6).

### 6.5 `PUT /api/tasks/:id` -- replace wholesale

Here is the trap. Take a task that currently has `priority: "high"` and send a `PUT` with only a title:

```powershell
$body = '{"title":"Totally replaced"}'
Set-Content -Path "$env:TEMP\put.json" -Value $body -NoNewline
curl.exe -s -i -X PUT http://127.0.0.1:3000/api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5 `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\put.json"
```

```
HTTP/1.1 200 OK
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 207

{"id":"4656e53e-35e3-4314-b863-6cc1c05d7fd5","createdAt":"2026-10-16T19:33:15.253Z","title":"Totally replaced","description":null,"priority":"medium","completed":false,"updatedAt":"2026-10-16T19:33:15.409Z"}
```

**Notice: `priority` fell from `"high"` to `"medium"` even though the request never mentioned priority.**

That is `PUT`'s semantics, and it is why `PUT` and `PATCH` are separate methods. `PUT` means "make the resource look exactly like this"; omitted fields are not preserved but **reset to their defaults** (`priority` to `"medium"`, `completed` to `false`, `description` to `null`). Had `description` held text, that text would be gone too. Everything the server owns is preserved -- `id`, `createdAt` -- and `updatedAt` moved forward because the resource did change.

`PUT` is also **idempotent**: sending the same body twice leaves the same state after the second request as after the first, with only `updatedAt` advancing. That property is what makes a `PUT` safe to retry after a network failure, and the test suite checks it. Use `PUT` when you are sending a complete resource; use `PATCH` when you are changing a field.

### 6.6 `PATCH /api/tasks/:id` -- update part of it

The same task, immediately after the `PUT` above. Send only the field you care about:

```powershell
$body = '{"completed":true}'
Set-Content -Path "$env:TEMP\patch.json" -Value $body -NoNewline
curl.exe -s -i -X PATCH http://127.0.0.1:3000/api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5 `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\patch.json"
```

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{"id":"4656e53e-35e3-4314-b863-6cc1c05d7fd5","createdAt":"2026-10-16T19:33:15.253Z","title":"Totally replaced","description":null,"priority":"medium","completed":true,"updatedAt":"2026-10-16T19:33:15.439Z"}
```

**Notice the contrast with Section 6.5.** The title is still `"Totally replaced"`, because `PATCH` preserved it -- whereas the `PUT` had reset that same field. In one pair of transcripts:

| | `PUT` | `PATCH` |
| --- | --- | --- |
| Omitted field | Reset to its default | Left untouched |
| Meaning | "Here is the new resource" | "Change these fields" |
| Body | Complete task content | Any subset |

`PATCH` accepts any subset of `title`, `description`, `priority` and `completed`. `id`, `createdAt` and `updatedAt` belong to the server; sending them is rejected as unknown fields.

**Clearing a field.** Because an omitted field means "leave it alone", there must be a separate way to say "remove the description". That is an explicit `null`:

```powershell
$body = '{"description":null}'
Set-Content -Path "$env:TEMP\clear.json" -Value $body -NoNewline
curl.exe -s -X PATCH http://127.0.0.1:3000/api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5 `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\clear.json"
```

```json
{"id":"4656e53e-35e3-4314-b863-6cc1c05d7fd5","createdAt":"2026-10-16T19:33:15.253Z","title":"Totally replaced","description":null,"priority":"medium","completed":true,"updatedAt":"2026-10-16T19:33:15.460Z"}
```

That is a genuine three-way distinction worth being precise about:

| Body | Meaning |
| --- | --- |
| `{}` | Rejected with `422` -- nothing to update, so the request is meaningless |
| `{"description":null}` | Clear the description |
| `{"title":"x"}` | Change the title, leave `description` exactly as it was |

An empty `PATCH` is a `422`, not a no-op:

```json
{"error":{"code":"VALIDATION_FAILED","message":"The request body must contain at least one field to update.","details":[{"field":"(body)","message":"Provide at least one of: title, description, priority, completed."}]}}
```

`PATCH` is **not** required to be idempotent -- `completed: true` twice gives the same result, but a patch meaning "increment the count" would not.

### 6.7 `DELETE /api/tasks/:id`

```powershell
curl.exe -s -i -X DELETE http://127.0.0.1:3000/api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5
```

```
HTTP/1.1 204 No Content
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *

```

**Notice: the body is completely empty, and there is no `Content-Length` header at all.**

That absence is not an oversight; it is the correct encoding of `204 No Content`, which says "it worked and there is deliberately nothing to say". The header is omitted precisely so a client does not read `Content-Length: 0` as some other response with an empty body. This matters a great deal in code:

```js
const response = await fetch(url, { method: 'DELETE' });
// response.status === 204
const text = await response.text();   // '' -- fine
const data = JSON.parse(text);        // SyntaxError: Unexpected end of JSON input
```

`JSON.parse('')` throws, so a client that blindly parses every body crashes on every successful `DELETE`. The rule is in Section 8: check the status first.

Deleting the same id twice is where the API's choice becomes visible:

```powershell
curl.exe -s -i -X DELETE http://127.0.0.1:3000/api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5
```

```
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8

{"error":{"code":"NOT_FOUND","message":"No task exists with id \"4656e53e-35e3-4314-b863-6cc1c05d7fd5\"."}}
```

A `204` would also be defensible -- the resource is absent, which is what you asked for. This API returns `404` because it surfaces client bugs: if you delete the same thing twice, you probably have a double-click handler or a retry loop that did not check first, and a `404` is how you find out. Either behavior is legitimate; what matters is that it is deliberate, documented, and handled by your client.

### 6.8 `OPTIONS /api/tasks` -- what is allowed here

```powershell
curl.exe -s -i -X OPTIONS http://127.0.0.1:3000/api/tasks `
  -H "Origin: https://example.com" `
  -H "Access-Control-Request-Method: POST"
```

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Accept
Access-Control-Max-Age: 86400
Allow: GET, POST, PUT, PATCH, DELETE, OPTIONS
```

**Notice:** this is a CORS **preflight**. Before a browser sends a cross-origin `POST` with a JSON content type, it sends this `OPTIONS` first to ask whether the real request is permitted, and the `Access-Control-Allow-*` headers are the answer. The `Allow` header is the plain HTTP version of the same information, and `Access-Control-Max-Age: 86400` tells the browser it may cache the answer for a day. Preflight is answered before routing, which is why `OPTIONS` on a path with no routes still returns `204`: the browser is asking about the API, not about a specific resource.

## 7. A Guided Tour of the Failure Modes

An API is defined as much by its errors as by its successes. Every error uses the same envelope, so one client-side parser handles all of them:

```json
{"error":{"code":"SOMETHING_WENT_WRONG","message":"Human-readable explanation.","details":[{"field":"...","message":"..."}]}}
```

`code` is a stable machine-readable string, `message` is for the human reading a log, and `details` is an optional per-field breakdown. Branch on `code`, display `message`, and show `details` next to the relevant form fields.

### 7.1 `400` -- the body is not JSON at all

```powershell
Set-Content -Path "$env:TEMP\broken.json" -Value '{"title":' -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\broken.json"
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Content-Length: 109

{"error":{"code":"BAD_REQUEST","message":"The request body is not valid JSON: Unexpected end of JSON input"}}
```

**What the client should do:** this is a client bug, not a data problem -- the body never reached validation. Fix the serializer; do not retry, and do not show this to an end user. A common real cause is a JavaScript object being `.toString()`ed into `"[object Object]"` because `JSON.stringify` was never called. The useful distinction is `400` versus `422`: `400` means "I could not even read what you sent", `422` means "I read it perfectly and the values are not acceptable".

### 7.2 `415` -- the content type is not JSON

```powershell
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: text/plain" `
  --data-binary "@$env:TEMP\create.json"
```

```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/json; charset=utf-8
Content-Length: 151

{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"This endpoint requires a JSON request body. Send the header \"Content-Type: application/json\"."}}
```

**What the client should do:** add `Content-Type: application/json`. This is the error produced by the `-d` trap in Section 3.1. The message states the exact fix, which is what a good error message does. The API does accept `application/json` with a charset parameter and structured-syntax JSON types like `application/vnd.api+json`; it just will not accept a type that is not JSON.

### 7.3 `400` -- a query parameter is invalid

```powershell
curl.exe -s -i "http://127.0.0.1:3000/api/tasks?limit=abc"
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Content-Length: 188

{"error":{"code":"BAD_REQUEST","message":"One or more query parameters are invalid.","details":[{"field":"limit","message":"Must be a whole number between 1 and 100. Received \"abc\"."}]}}
```

**What the client should do:** read `details`, fix the parameter, stop sending it. Note the message quotes back what you actually sent, which is invaluable when the value came from a form field rather than your keyboard. `?limit=0`, `?limit=101`, `?offset=-1` and `?completed=yes` all fail the same way. Query values arrive as **strings**, always: `?completed=false` is the string `"false"`, and the API compares it as text rather than coercing it.

### 7.4 `422` -- validation failed, possibly in several ways at once

```powershell
$body = '{"title":"","titel":"oops"}'
Set-Content -Path "$env:TEMP\bad.json" -Value $body -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\bad.json"
```

```
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json; charset=utf-8
Content-Length: 275

{"error":{"code":"VALIDATION_FAILED","message":"The request body failed validation.","details":[{"field":"titel","message":"Unknown field. This endpoint accepts: title, description, priority, completed."},{"field":"title","message":"Must not be empty or whitespace only."}]}}
```

**Two things to notice.** First, **both problems came back at once**: `titel` is a typo for `title`, so the body has an unknown field *and* an empty required field, and the API reports the whole set rather than making you fix one thing at a time. That is the difference between one round trip and five, and the reason `details` is an array rather than a string. Second, **the order of `details` is not guaranteed** -- these two entries are not in a predictable order, so neither a test nor a client should depend on one. Treat `details` as a set keyed by `field`:

```js
const titleIssue = details.find((issue) => issue.field === 'title');
```

Three separate rules produced that response:

| Rule | Example that fails it |
| --- | --- |
| Unknown fields are rejected | `titel`, `id`, `createdAt` |
| `title` must be present and non-empty after trimming | `""`, `"   "`, omitted |
| Values must be within limits and of the right type | a 201-character title, `priority: "urgent"` |

**What the client should do:** this is user-facing. Map each `details` entry onto its form field by `field`, fix all of them, and re-submit once. Do not retry blindly -- nothing changes without a different body.

### 7.5 `400` -- a malformed percent-escape

```powershell
curl.exe -s -i "http://127.0.0.1:3000/api/tasks/%zz"
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Content-Length: 114

{"error":{"code":"BAD_REQUEST","message":"The URL contains an invalid percent-encoded escape sequence: \"%zz\"."}}
```

**What the client should do:** encode the path segment properly. A `%` in a URL introduces a two-hex-digit escape (`%20` for a space), so a literal `%zz` is not a valid URL. When you build a URL from a value, encode it -- `encodeURIComponent(id)` in JavaScript -- rather than concatenating. A correctly encoded space behaves as expected:

```powershell
curl.exe -s "http://127.0.0.1:3000/api/tasks/hello%20world"
```

```json
{"error":{"code":"NOT_FOUND","message":"No task exists with id \"hello world\"."}}
```

Note the message echoes the **decoded** value, which is how you can tell decoding happened before the lookup rather than the request being rejected.

### 7.6 `404` -- no such route, and `404` -- no such id

Two different `404`s with different messages, and the difference matters when you are debugging a URL typo versus a stale id.

```powershell
curl.exe -s -i http://127.0.0.1:3000/api/nothing-here
```

```
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Content-Length: 87

{"error":{"code":"NOT_FOUND","message":"No resource exists at GET /api/nothing-here."}}
```

The message includes the **method and path**, so it tells you what the server thought you asked for. If you expected this to work, compare the path character by character with Section 6. A wrong method produces a very different message (Section 7.7), so "no resource exists" means the path itself matched nothing.

```powershell
curl.exe -s -i http://127.0.0.1:3000/api/tasks/nope
```

```
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Content-Length: 75

{"error":{"code":"NOT_FOUND","message":"No task exists with id \"nope\"."}}
```

**What the client should do:** for a collection route, fix the path. For an id, the resource is gone or never existed -- a normal outcome, not an exception. Show "not found" in the UI, and if you were about to update it, stop. Note that **`404` bodies are JSON**, unlike `204`, so they should be parsed. The one thing a `404` cannot tell you is whether the resource was deleted by someone else or simply never existed; distinguishing those needs a different API design (a tombstone, or `410 Gone`).

### 7.7 `405` -- the method is not routed here

```powershell
curl.exe -s -i -X PATCH http://127.0.0.1:3000/api/tasks
```

```
HTTP/1.1 405 Method Not Allowed
Content-Type: application/json; charset=utf-8
Content-Length: 127
Allow: GET, OPTIONS, POST

{"error":{"code":"METHOD_NOT_ALLOWED","message":"This URL does not support that method. Allowed methods: GET, OPTIONS, POST."}}
```

**Notice the `Allow` header.** RFC 9110 requires a `405` response to state which methods *are* allowed, and this API does -- in the header and in the human-readable message. That is not decoration: `405` means "this URL is real and I understood your method, but it is not routed here", which is a completely different diagnosis from `404` "this URL is not real". Without `Allow`, a client has no way to discover the correct method. Concretely, `PATCH` on the collection is a mistake because `PATCH` updates *an item*; the correct call is `PATCH /api/tasks/<id>`.

**What the client should do:** read `Allow` and change the method. Do not retry the same request. `GET /health` gives `Allow: GET, OPTIONS` for the same reason, which is a neat way to see that `/health` has a different route table from `/api/tasks`.

### 7.8 `413` -- the body is too large

```powershell
Set-Content -Path "$env:TEMP\big.json" -Value ('{"title":"' + ('a' * 200000) + '"}') -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\big.json"
```

```
HTTP/1.1 413 Payload Too Large
Content-Type: application/json; charset=utf-8
Content-Length: 105

{"error":{"code":"PAYLOAD_TOO_LARGE","message":"The request body is larger than the 100000 byte limit."}}
```

**What the client should do:** send less. The limit is `MAX_BODY_BYTES` (default `100000` bytes), and it exists so one request cannot make the server buffer an unbounded amount of memory. The server checks the declared `Content-Length` *before* transferring the body, which is why the rejection is immediate rather than arriving after 200 KB of upload. The message states the limit in bytes, which is what you need to decide whether to chunk an upload or reject it client-side.

### 7.9 The error table

| Status | `code` | Cause | Client action |
| --- | --- | --- | --- |
| `400` | `BAD_REQUEST` | Body is not valid JSON | Fix the serializer; never retry |
| `400` | `BAD_REQUEST` | Invalid query parameter value | Fix the parameter using `details` |
| `400` | `BAD_REQUEST` | Unknown query parameter | Fix the typo; read the listed parameters |
| `400` | `BAD_REQUEST` | Malformed `%` escape in the URL | Encode the path segment |
| `404` | `NOT_FOUND` | No route matches method + path | Fix the URL |
| `404` | `NOT_FOUND` | No task with that id | Treat as absent; do not retry |
| `405` | `METHOD_NOT_ALLOWED` | Method not routed on a real path | Read `Allow`, change method |
| `413` | `PAYLOAD_TOO_LARGE` | Body over `MAX_BODY_BYTES` | Send less or raise the limit |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` is not JSON | Add `Content-Type: application/json` |
| `422` | `VALIDATION_FAILED` | Well-formed JSON, bad values | Map `details` to fields and fix them |

## 8. Reading a Response Like a Professional

Beginners read the body and hope. Professionals read a response in a fixed order, because each step can make the next one meaningless:

1. **Status code** -- did the request succeed at all?
2. **`Content-Type`** -- is the body what I think it is?
3. **`Location`, `Allow`, `X-Total-Count`** -- metadata that changes what the body means.
4. **The body** -- only now.

### 8.1 Status first, always

| Range | Meaning | What to do |
| --- | --- | --- |
| `2xx` | Success | Parse the body |
| `3xx` | Redirect | `fetch` follows most of these for you |
| `4xx` | The client did something wrong | Read the error body and fix the request |
| `5xx` | The server broke | Report it; retrying may help |

Check the status **before** parsing, because parsing is not safe in every case and its failure mode is unhelpful:

```js
// Wrong: this explodes on a successful DELETE.
const data = await response.json();

// Right: check what happened, then decide whether there is a body.
if (!response.ok) {
  const problem = await response.json();      // this API always sends JSON on errors
  throw new Error(`${response.status} ${problem.error.code}: ${problem.error.message}`);
}
if (response.status === 204) {
  return null;                                // deliberately nothing to parse
}
return response.json();
```

`response.ok` is `true` for `200`-`299`. Note the careful asymmetry: **an error response always has a JSON body in this API, and a `204` never does.** That is why the code parses the error body but short-circuits the `204`. `JSON.parse('')` throws `SyntaxError: Unexpected end of JSON input`, and the stack trace points at your parse call rather than at the `204` that caused it -- exactly the kind of bug that costs an hour.

### 8.2 `Content-Type` next

Check it before parsing, especially when the response looks wrong. If you asked for JSON and got `text/html`, you are almost certainly looking at a proxy error page, a login redirect, or a different server than you think -- and `JSON.parse` will fail with a confusing message about `<`. Reading `Content-Type` first turns "JSON parse error" into "I am talking to the wrong thing". This API always sends `application/json; charset=utf-8`, including on errors and including on `404`, so a client needs exactly one parser.

### 8.3 Headers that change the meaning of the body

| Header | On | Means |
| --- | --- | --- |
| `Location` | `POST` `201` | URL of the created resource; read this instead of parsing the id |
| `Allow` | `405` and `OPTIONS` | Which methods this URL supports |
| `X-Total-Count` | `GET /api/tasks` | Matches **before** `limit`/`offset`; without it you cannot paginate |
| `Access-Control-Allow-*` | `OPTIONS` preflight | What a browser is permitted to do |
| `Content-Length` | Most responses | Body size in bytes; **absent** on `204` |

`X-Total-Count` deserves the emphasis: a paginated client that ignores it can only ever say "here are 20 tasks", whereas with it the client can render "showing 1-20 of 137" and know when to stop asking for more pages.

### 8.4 Then the body

Only now does it make sense to look at the JSON, and when you do, check the shape rather than trusting the type you assumed:

- `GET /api/tasks` returns a **bare array**, with no wrapper object.
- `GET /api/tasks/:id` returns an object.
- `description` is sometimes `null`, and `typeof null === 'object'` in JavaScript -- so test it explicitly rather than by truthiness.
- `createdAt` and `updatedAt` are strings, because JSON has no date type. Parse them with `new Date(str)`.

### 8.5 A production-shaped example

```js
async function getTasks(baseUrl, { completed, priority, limit, offset } = {}) {
  const url = new URL('/api/tasks', baseUrl);
  if (completed !== undefined) url.searchParams.set('completed', String(completed));
  if (priority !== undefined) url.searchParams.set('priority', priority);
  if (limit !== undefined) url.searchParams.set('limit', String(limit));
  if (offset !== undefined) url.searchParams.set('offset', String(offset));

  const response = await fetch(url);

  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    const code = problem?.error?.code ?? 'UNKNOWN';
    throw new Error(`GET ${url.pathname} failed: ${response.status} ${code}`);
  }

  // Read the total BEFORE consuming the body -- one response, one read.
  const total = Number(response.headers.get('x-total-count') ?? 0);
  const items = await response.json();
  return { items, total };
}
```

Four habits worth copying. Build the URL with `URL` and `searchParams` so encoding is handled for you -- never concatenate query strings by hand. Use `String(completed)`, because query values are text and `false` must become `"false"` rather than being dropped. Read headers **before** the body, since a `Response` body can only be consumed once. And `.catch(() => null)` on the error-body parse, because a `502` from a proxy is HTML and would otherwise turn a clean error into a parse exception.

## 9. Browser DevTools

You do not need a separate tool to inspect HTTP. Open DevTools (`F12` or `Ctrl+Shift+I`), go to the **Network** tab, and every request the page makes -- including `fetch` calls from your own code -- appears with its method, URL, status, request headers, request body, response headers and response body. As an HTTP inspector it equals `curl`, with a GUI.

Two features are immediately useful:

- **Right-click a request, then "Copy as cURL".** You get a `curl` command reproducing the request exactly, including every header the browser sent. It is the bridge from browser to terminal, to a bug report, or to a test. On Windows, change `curl` to `curl.exe` (Section 4.1) and expect the JSON quoting to be awkward -- the file pattern from Section 5 is easier once you have the request.
- **Right-click a request, then "Copy as fetch".** You get the JavaScript `fetch(...)` call for the same request, headers and body included. It is the fastest way to get a correct `fetch` into a test.

You can also edit and resend (Firefox's "Edit and Resend"), or run a `fetch` in the Console and watch it appear in the Network tab.

### 9.1 The CORS caveat

This is the most important thing to understand about browser-based API testing, and the source of the most common false alarm in web development:

> **The same-origin policy applies to requests made *from a browser page*. It does not apply to `curl`, to Postman, or to your test suite.**

A browser only lets JavaScript on `https://example.com` read a response from `http://127.0.0.1:3000` if the API sends a CORS header naming that origin. This API sends `Access-Control-Allow-Origin: *` by default, so cross-origin reads work -- but the *rules* are enforced by the browser, and only by the browser.

The practical consequence: **when a request works in `curl` and fails in the browser, the cause is almost always CORS, not the API.**

That failure looks distinctive once you know it. In the Network tab the request appears with a status like `(failed)` or `CORS error` rather than an HTTP status, and the Console shows something like:

```
Access to fetch at 'http://127.0.0.1:3000/api/tasks' from origin 'http://localhost:5173'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
on the requested resource.
```

Read that carefully, because it is counterintuitive in an important way: the server may well have received the request and returned a perfectly good `200`. The browser is refusing to hand the response to your JavaScript, and there is nothing the server can do about a response the browser has already decided to hide. That is why CORS is configured on the server -- here via `CORS_ORIGIN` and the `cors` middleware.

Two more facts that save time. **A cross-origin `POST` with `Content-Type: application/json` needs a preflight**, which is why `OPTIONS /api/tasks` exists (Section 6.8); the browser sends it invisibly, so you see it as a separate request immediately before the real one. And **a failed preflight means the real request is never sent** -- if you see an `OPTIONS` with an error and no `POST` after it, the browser stopped before your code's request went out. The server's access log settles this instantly: no log line for the `POST` means the request never arrived.

To allow one specific origin instead of everything:

```powershell
$env:CORS_ORIGIN='http://localhost:5173'; npm run dev
```

`*` is fine for learning and wrong for anything with credentials, because a wildcard origin cannot be combined with cookies or `Authorization` headers.

## 10. GUI Clients

`curl` is the lowest common denominator and the best thing to have in your fingers, but a GUI client earns its place for one reason: **saving and re-running a set of requests without retyping them.**

| Tool | What it is | Good for |
| --- | --- | --- |
| **Postman** | Standalone app, the most widely used API client | Team collections, per-stage environment variables, scripted pre-request and test assertions, mock servers. Heavy but the most capable |
| **Insomnia** | Standalone app, lighter and cleaner | Quick manual exploration, GraphQL support, a pleasant editing experience for one-off requests |
| **Thunder Client** | VS Code extension | Staying in the editor; no separate app, collections stored in the workspace |
| **VS Code REST Client** | VS Code extension for `.http` files | Requests as plain text files that live in the repo and can be committed and reviewed |

The last one deserves a longer look, because `.http` files are text, which means they work with git, code review and the rest of your tooling. Create `tests/requests.http`, write the request as text, and a small "Send Request" link appears above it:

```http
@baseUrl = http://127.0.0.1:3000

### Health check
GET {{baseUrl}}/health

### List the first two tasks
GET {{baseUrl}}/api/tasks?limit=2

### Create a task
POST {{baseUrl}}/api/tasks
Content-Type: application/json

{
  "title": "Write the docs",
  "priority": "high"
}

### Read one task (paste an id from a previous response)
GET {{baseUrl}}/api/tasks/2164807c-1594-4d83-85a1-16b39c5f5b5b

### Partially update it
PATCH {{baseUrl}}/api/tasks/2164807c-1594-4d83-85a1-16b39c5f5b5b
Content-Type: application/json

{
  "completed": true
}

### Delete it
DELETE {{baseUrl}}/api/tasks/2164807c-1594-4d83-85a1-16b39c5f5b5b

### A deliberate failure: PATCH is not routed on the collection
PATCH {{baseUrl}}/api/tasks
Content-Type: application/json

{
  "title": "This should be a 405"
}
```

`###` separates requests, `@baseUrl = ...` declares a variable used as `{{baseUrl}}`, and each request is `METHOD URL`, then headers, then a blank line, then the body written exactly as you want it sent. That last point is the format's best feature: there is no shell involved, so the quoting problems of Section 4.4 cannot happen. The response appears in a pane beside the file with status, headers and body. If you find yourself fighting quoting more than once a day, a `.http` file is a reasonable response to that.

## 11. The Automated Test Suite

Everything up to here required you to be present and typing. Tests are how you get the same confidence without the typing -- and how you find out that a change broke something you had forgotten about.

### 11.1 `npm test`

```powershell
npm test
```

That runs `node --test "tests/**/*.test.ts"`. **`node --test` is Node's built-in test runner**: it discovers test files matching its default patterns, runs them, and reports results. It is part of the Node binary -- no Jest, no Mocha, no Vitest, and no testing dependency at all. The only dependencies in this project are `typescript` and `@types/node`, and neither is needed to *run* the tests; they exist for editor support and the `build`/`typecheck` scripts.

You can point the runner at one file, or filter by test name with a regular expression:

```powershell
node --test tests/api.test.ts
node --test --test-name-pattern="paginates" "tests/**/*.test.ts"
```

`--test-name-pattern` is the most useful flag when you are iterating on one behavior: everything whose name does not match is skipped, so a two-second run becomes a fraction of a second. `describe` block names count too, so `--test-name-pattern="DELETE"` runs that whole suite.

### 11.2 The API: `describe`, `it`, and assertions

There are two halves to a test file: the **structure** (which test is which, and what runs around them) and the **assertions** (what has to be true).

| From `node:test` | Purpose |
| --- | --- |
| `describe(name, fn)` | Groups related tests; nests arbitrarily |
| `it(name, fn)` | One test. Also available as `test(name, fn)` |
| `before(fn)` / `after(fn)` | Runs once before / after the tests in this scope |
| `beforeEach(fn)` / `afterEach(fn)` | Runs before / after **every** test in this scope |

| From `node:assert/strict` | Checks |
| --- | --- |
| `assert.equal(actual, expected)` | `Object.is` equality -- strict, no type coercion |
| `assert.deepEqual(actual, expected)` | Structural equality of objects and arrays |
| `assert.ok(value)` | The value is truthy; handy for "this exists" |
| `assert.match(string, regex)` | A string matches a pattern |
| `assert.throws(fn)` | Calling `fn` throws |

A minimal example:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('arithmetic', () => {
  it('adds', () => {
    assert.equal(1 + 1, 2);
  });

  it('rejects a bad title', () => {
    assert.throws(() => parseTaskWriteInput({ title: '   ' }));
  });
});
```

Use `node:assert/strict` rather than plain `node:assert`: the strict variant makes `assert.equal` use `Object.is` rather than `==`, so `assert.equal('1', 1)` fails instead of passing, which is nearly always what you meant. `assert.deepEqual` from the strict module is strict too, so `{ a: 1 }` does not deep-equal `{ a: '1' }`.

If you have seen testing tutorials, they were probably written for Jest or Mocha. The concepts transfer directly; the differences are worth knowing:

| | Jest | Mocha | `node:test` (this project) |
| --- | --- | --- | --- |
| Install | Large dev dependency | Mocha plus an assertion library | Built into Node |
| Globals | `describe`/`it` injected globally | Injected globally | **Imported** from `node:test` |
| Assertions | `expect(x).toBe(y)` | `chai`, usually | `node:assert/strict` |
| Mocks | `jest.fn()`, built in | `sinon`, separate | `mock` from `node:test` |
| TypeScript | Needs `ts-jest` or Babel | Needs `ts-node` or a loader | Runs `.ts` natively on Node 24 |

Two of these actually change how you write code. **Nothing is global**: Jest injects `describe` and `it` into every file, while `node:test` requires `import { after, before, beforeEach, describe, it } from 'node:test'`. That is a little extra ceremony in exchange for no magic global namespace, and your editor knows exactly where `it` came from. And **`expect(x).toBe(y)` becomes `assert.equal(x, y)`**, read as "assert that these are equal", with the expected value *second*. There is no configuration file anywhere in this project -- no `jest.config.js`, no `.mocharc.yml`. The runner is the runtime.

### 11.3 The two test files

The suite is split by how much of the system a test exercises, and the split is deliberate.

**`tests/unit.test.ts`** (about 380 lines) tests the two modules with real logic in them, directly, with no HTTP involved:

- `TaskStore` from `src/data/task.store.ts`: creating a task generates a distinct UUID with matching `createdAt`/`updatedAt`; `findById` returns `undefined` for an unknown id; filtering by `completed` and `priority` works; pagination cuts the page but reports the pre-pagination `total`; an empty page past the end is returned rather than an error; `delete` reports whether anything was removed.
- The validators from `src/validation/task.validation.ts`: `parseTaskWriteInput`, `parseTaskUpdateInput` and `parseTaskListQuery`. These tests are the specification of every rule -- title trimming and length limits, `""` becoming `null`, the priority allow-list, unknown-field rejection, the empty-patch rejection, the query parameter bounds.

A unit test failure points at a function. That is the value: when `parseTaskListQuery` rejects `?limit=101`, the failing test names the rule rather than "something in the response was wrong".

**`tests/api.test.ts`** (about 670 lines) is end-to-end. Every test starts a real server on a real port and sends a real HTTP request. Its `describe` blocks map one-to-one onto the endpoint table:

```
the tasks API over HTTP
  GET /health
  GET /api/tasks
  GET /api/tasks/:id
  POST /api/tasks
  PUT /api/tasks/:id
  PATCH /api/tasks/:id
  DELETE /api/tasks/:id
  routing
  request body limits
  CORS
```

Read this file as executable documentation: each `it` name states one promise the API makes, and the body shows exactly how much has to be true for the promise to hold. `it('returns 204 with a completely empty body')` describes the DELETE contract better than any prose, because it is also enforced.

### 11.4 Why the integration tests use a real socket

It is entirely possible to test a handler without HTTP: call it with a fake request object and inspect the fake response. This project does not. `tests/api.test.ts` starts an actual `http.Server`, listens on an actual port, and uses Node's global `fetch` to talk to it over a real TCP socket.

The reason is that **the thing worth testing is the contract a client experiences**, and most of that contract does not exist in the handler at all:

- **Status codes.** A handler returns a body; the status is set by the response helper, the route registration and the error handler. A unit test of the handler never sees it.
- **Headers.** `Location` on a `201`, `Allow` on a `405`, `X-Total-Count` on a list, `Cache-Control` and `X-Content-Type-Options` everywhere -- all added by middleware. Mocking around the middleware means testing a system no client will ever talk to.
- **Body serialization.** The bytes on the wire are what matter. `Content-Length` has to match `Buffer.byteLength(body, 'utf8')` or a client truncates or hangs.
- **Middleware ordering.** Logger, error handler, default headers, CORS, router -- the order is load-bearing (the comment in `src/app.ts` argues exactly this). A unit test cannot see an ordering bug; a real request through the real stack can.
- **Whether the response is valid HTTP at all.** A malformed header value or a double `writeHead` is invisible to a mocked response and fatal in production.

Mocking is not wrong -- it is a tool for isolating a unit and for simulating conditions you cannot create, such as a timeout or a disk error. But when the thing you are shipping is an HTTP contract, testing it through HTTP is the honest test. The cost is a few milliseconds per test, which is why the whole suite finishes in under a second.

### 11.5 `tests/helpers/testServer.ts` explained

The helper is 73 lines and every one of them is doing something:

```ts
import { createServer } from 'node:http';
import { buildApp, type App, type BuildAppOptions } from '../../src/app.ts';

export interface TestServer {
  readonly app: App;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export async function startTestServer(overrides: BuildAppOptions = {}): Promise<TestServer> {
  const app = buildApp({ logRequests: false, seed: false, ...overrides });
  const server = createServer(app.listener);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to be listening on a TCP address.');
  }

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
```

**`buildApp()` instead of `src/server.ts`.** `src/app.ts` wires up the store, middleware and routes and returns an object with a `listener` function, and deliberately does *not* listen on a port. `src/server.ts` is the file that listens, and it runs at import time. So tests import the **app factory**; importing `server.ts` would immediately bind port 3000 and print a startup banner. This split is the single most important structural decision that makes the suite possible, and it is why `buildApp` exists at all. The helper also overrides `logRequests: false` (so test output is not flooded with access logs) and `seed: false` (so tests do not depend on the four sample tasks, which are free to change). Any test can override again -- `startTestServer({ maxBodyBytes: 40 })` gives a server with a deliberately tiny body limit.

**`createServer(app.listener)`.** `http.createServer` takes a `(req, res) => void` function and wraps it in a server. Nothing is listening yet: the server object exists but is bound to nothing.

**`server.listen(0, '127.0.0.1', resolve)`.** The `0` is the point -- it means "operating system, pick any free port". Three things follow. Tests never collide with a real dev server on port 3000 or with each other, so two test files can run their servers simultaneously. You never have to free a port or wait for `TIME_WAIT`. And the chosen port is unknown until the server is bound, which is why it is read back.

**Reading the port back.** `server.address()` returns `null` before binding, a `string` for a Unix domain socket, or an object with `port` for TCP. The guard handles all three, which TypeScript requires, and it is what produces the real port:

```ts
baseUrl: `http://127.0.0.1:${address.port}`,
```

The test never hardcodes a port number; it asks the server where it listened.

**`closeAllConnections()` before `close()` -- the real trap.**

```ts
server.closeAllConnections();
await new Promise<void>((resolve, reject) => {
  server.close((error) => { /* ... */ });
});
```

`server.close(cb)` stops accepting new connections and calls `cb` once **every existing connection has closed**. The catch is that it does not close idle keep-alive connections for you -- it waits for them. And `fetch` (undici, Node's built-in HTTP client) keeps sockets alive in a connection pool after the response arrives, precisely so the next request to the same host can reuse the socket instead of doing another TCP handshake. Those pooled sockets are, from the server's point of view, idle but open. So the naive shutdown deadlocks:

```
server.close()  --  stops listening, then waits for the pooled sockets to close
pooled sockets  --  would be closed by the fetch pool eventually
test process    --  waits for close() to call its callback, so it never exits
```

That is a **hang, not a failure**. There is no assertion error and no stack trace; the process simply never finishes, and in a terminal it looks like the run froze at the end. It is the kind of bug that costs an afternoon the first time, which is why `closeAllConnections()` is always called first when a test server stops in this suite. (The alternative is disabling keep-alive on the client, but then you are testing HTTP behavior no real client uses. Forcing the sockets shut from the server side is simpler and closer to what a real shutdown does.)

Finally, `close` is wrapped in a `Promise` so tests can `await server.close()` in an `after` hook, and it rejects on error so a shutdown failure fails the suite rather than being silently swallowed.

### 11.6 Why `beforeEach` clears the store

```ts
beforeEach(() => {
  server.app.store.clear();
});
```

One line, and it is the difference between a suite you can trust and one you cannot. The store is shared state inside the app that `before(...)` created once for the whole file. If test 3 creates a task and test 4 asserts "the collection contains one task", test 4 passes only because test 3 ran first. Those tests are not testing the API; they are testing the order the tests happen to run in.

That failure mode is nasty because of how it presents. Run the whole file: green. Run one test with `--test-name-pattern`: red, because its setup was really coming from a previous test. Shuffle the order, run tests in parallel, or add a test between two others: red, in a file you did not touch. A test that depends on execution order is the worst kind of test, because its failures are not reproducible in isolation and its causes are nowhere near its symptoms. `store.clear()` in `beforeEach` makes every test start from an empty store, so each test's setup is entirely contained in its own body and its result depends on nothing but the server code.

`beforeEach` runs before *every* test in the enclosing `describe`, including the first. The store is also empty at that point (because `seed: false`), so the first clear is a no-op -- which is fine, and far simpler than special-casing the first run. Note also what is *not* reset: the server itself. Rebuilding and restarting it per test would be slower and buy nothing, since the only mutable state in the app is the store. Knowing exactly what state exists is what lets you reset the minimum.

### 11.7 Test isolation: one process per file

By default, `node --test` runs **each test file in its own child process**. What that buys:

- **No state leakage between files.** `tests/unit.test.ts` creating stores and `tests/api.test.ts` starting servers cannot interfere, because they are not in the same process. Modules are loaded separately, so module-level state -- including the config object, which is built once per process -- is independent.
- **Crash isolation.** If one file hits an unhandled exception, leaves a server listening or exhausts memory, the other files still run and still report.
- **Real parallelism.** Files run concurrently, which is why the suite finishes in a fraction of a second instead of the sum of its files.

The alternative is a single process:

```powershell
npm run test:single-process
```

which runs `node --test --test-isolation=none "tests/**/*.test.ts"`. Every test file then runs in one process, one after another. The trade-off is exactly what you would expect: no parallelism and no crash isolation (one file can take down the run), in exchange for not spawning child processes at all. That matters in **restricted environments where spawning child processes is blocked** -- sandboxes, some CI containers, hardened build systems -- where the default multi-process mode fails before a single test executes.

The failure is distinctive when you hit it. `node --test` tries to start a child process per file and gets a permission error, so the reported failure is about spawning rather than about your code:

```
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:487:11)
    ...
test at tests\unit.test.ts:1:1
✖ tests\unit.test.ts (2.8065ms)
```

Every test file reports this and nothing else runs. If you see `spawn EPERM` and no assertion failures, the runner is blocked by the environment, not by a bug in the tests -- switch to `npm run test:single-process`.

### 11.8 The passing summary

Both modes report the same counts. A full run ends with:

```
ℹ tests 78
ℹ suites 15
ℹ pass 78
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 366.6933
```

**78 tests** across the two files. **15 suites** -- the `describe` blocks, nested ones included. `pass`/`fail`/`cancelled` are the outcomes that matter, and `fail 0` is the only line you need when checking whether a change broke something. `skipped` and `todo` are both `0`, which is worth aiming for: a suite with permanently skipped tests teaches you to ignore the summary. `duration_ms` is under a second because nothing touches the network beyond loopback and nothing touches the disk. For a verbose per-test listing when something fails:

```powershell
node --test --test-reporter=spec "tests/**/*.test.ts"
```

### 11.9 How to add your own test

The rest of this section is a complete worked example. Suppose you want to verify a behavior no current test covers:

> **`PUT /api/tasks/:id` with an id that does not exist returns `404`.**

Find out what the API actually does before writing the test. There is already a test for this, so the behavior is known -- but checking by hand first is the right discipline, and it takes one command:

```powershell
curl.exe -s -i -X PUT http://127.0.0.1:3000/api/tasks/00000000-0000-4000-8000-000000000000 `
  -H "Content-Type: application/json" -d '{"title":"Nope"}'
```

```
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8

{"error":{"code":"NOT_FOUND","message":"No task exists with id \"00000000-0000-4000-8000-000000000000\"."}}
```

Now the test. It goes in `tests/api.test.ts`, inside the existing `describe('PUT /api/tasks/:id', ...)` block:

```ts
    it('returns 404 for an id that does not exist', async () => {
      // A well-formed id that was never created. The path matched and the handler
      // ran -- this is "the task is missing", not "the URL is wrong".
      const response = await fetch(`${baseUrl}/api/tasks/00000000-0000-4000-8000-000000000000`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Nope' }),
      });

      assert.equal(response.status, 404);

      const body = await readJson<ErrorPayload>(response);
      assert.equal(body.error.code, 'NOT_FOUND');
      // The message echoes the id, which is what makes a stale-id bug findable
      // in a log rather than a mystery.
      assert.match(body.error.message, /00000000-0000-4000-8000-000000000000/);
    });
```

Every line is doing something worth explaining:

- **It uses `baseUrl`, not a hardcoded port.** `baseUrl` came from `startTestServer()`, which read the OS-assigned port off `server.address()`. A hardcoded `3000` would work locally and fail wherever the port is taken.
- **The body is a valid task write.** That is deliberate: the request must be acceptable *apart* from the missing id, or a `422` would be indistinguishable from the `404` being tested. A test should fail for exactly one reason.
- **`assert.equal(response.status, 404)` comes first.** If the status is wrong, nothing else is worth asserting, and a failure here gives the clearest possible message: `expected 404, actual 422`.
- **`readJson<ErrorPayload>(response)`** is the file's existing helper. `Response.json()` is typed `Promise<unknown>`, which is correct but tedious; the helper takes the type the caller knows it expects. That is an act of faith on the test's part -- the assertions that follow are what actually verify the shape.
- **`assert.match(..., /regex/)`** checks the message. Asserting the exact string would be brittle (the message will be reworded someday), but asserting that the id appears in it checks the property that matters.
- **There is no cleanup in the test body.** `beforeEach` at the file level already empties the store, so the test neither knows nor cares.
- **The test is `async`**, and every `await` is a real network round trip. The runner handles async tests natively.

Three mistakes are worth naming, because they are the ones people make:

| Don't | Why |
| --- | --- |
| Hardcode `http://127.0.0.1:3000` | Breaks the moment the port is taken; `baseUrl` exists to avoid it |
| Assert the whole error object with `deepEqual` | Any wording change breaks an unrelated test; assert the status, the `code` and the property you care about |
| Create a task first "just in case" | Unnecessary setup hides what the test is about -- and here it would be actively wrong, since the id must *not* exist |

Run just that test, or the whole suite:

```powershell
node --test --test-name-pattern="PUT" tests/api.test.ts
npm test
```

Expected: `pass 78`, `fail 0` -- this test replaces one that already existed, so the count is unchanged. A genuinely new test would make it `79`.

#### Step 2: the unit test, when the logic is not HTTP

That integration test proves the endpoint returns `404`; it does not prove *why*. If the underlying store returned the wrong thing the test would still fail, but it would point at the HTTP layer rather than the function. For logic with a real decision in it, a unit test alongside is worth the few lines. Take a rule the validator enforces -- Section 7.4 shows the message for an all-whitespace title:

```ts
  it('rejects a title that is only whitespace', () => {
    const error = captureHttpError(() => parseTaskWriteInput(validInput({ title: '   ' })));

    assert.equal(error.status, 422);
    assert.equal(error.code, 'VALIDATION_FAILED');
    const issue = error.details.find((detail) => detail.field === 'title');
    assert.ok(issue, 'expected a validation issue for the title field');
    assert.match(issue.message, /whitespace/);
  });
```

Two things to copy. **`captureHttpError` is the file's own helper**, defined at the top of `tests/unit.test.ts`: `assert.throws` can do something similar but does not hand the error back, and asserting on `status` and `code` is the entire point of most of these tests, so use the helper rather than reinventing `try`/`catch`. And **`error.details.find(...)` rather than `details[0]`** -- the order of `details` is not guaranteed, as Section 7.4 shows, so indexing into the array is a test that passes by luck.

Note the honest framing of exercise 12.8: if the rule already exists in the validator, this test passes the first time you run it, and you have learned the rule is already covered rather than written new code. That is a good outcome, and the test is still worth keeping. If it *fails*, you have found a real gap.

#### Step 3: run everything

```powershell
npm test
```

```
ℹ tests 79
ℹ suites 15
ℹ pass 79
ℹ fail 0
```

If the count went up by one and `fail` is `0`, you are done. If `fail` is not `0`, read the assertion message: it names expected and actual, which is usually enough to see whether the test is wrong or the code is.

**One last habit.** When you fix a bug, write the test that fails because of it *before* the fix, confirm it fails for the right reason, then fix the code and watch it pass. A test written after a fix often encodes what the code now does rather than what it should do, and it will happily pass over the same bug if it returns.

## 12. A Suggested Practice Progression

Work through these in order. Each is small, and each teaches something the previous ones did not. Do them against a running server with `curl.exe -s -i`, keeping the server's terminal visible so you can compare the access log with your requests.

### 12.1 Make a `422` happen, then fix it

Send a `POST` with an empty title, then fix the body and send it again.

```powershell
$bad = '{"title":""}'
Set-Content -Path "$env:TEMP\bad.json" -Value $bad -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" --data-binary "@$env:TEMP\bad.json"

$good = '{"title":"A real title"}'
Set-Content -Path "$env:TEMP\good.json" -Value $good -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" --data-binary "@$env:TEMP\good.json"
```

**Teaches:** how a `4xx` looks from the client side, that the error body tells you how to fix the request, and that a rejected request has no side effects -- compare `X-Total-Count` before and after to confirm the first attempt created nothing.

### 12.2 Create three tasks and page through them

Create three tasks, then request `?limit=2` and `?limit=2&offset=2`. Check `X-Total-Count` on both responses and compare it with the number of items in the body.

```powershell
foreach ($n in 1..3) {
  Set-Content -Path "$env:TEMP\t$n.json" -Value "{`"title`":`"Practice task $n`"}" -NoNewline
  curl.exe -s -o NUL -w "created: %{http_code}`n" -X POST http://127.0.0.1:3000/api/tasks `
    -H "Content-Type: application/json" --data-binary "@$env:TEMP\t$n.json"
}
curl.exe -s -i "http://127.0.0.1:3000/api/tasks?limit=2"
curl.exe -s -i "http://127.0.0.1:3000/api/tasks?limit=2&offset=2"
```

**Teaches:** the difference between the page size and the total, and why `X-Total-Count` must exist for pagination to be possible at all. Try `?limit=2&offset=4` and confirm you get `[]` with a `200` -- running off the end is not an error.

### 12.3 Delete the same task twice

```powershell
$body = '{"title":"Delete me twice"}'
Set-Content -Path "$env:TEMP\del.json" -Value $body -NoNewline
$created = curl.exe -s -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" --data-binary "@$env:TEMP\del.json" | ConvertFrom-Json

curl.exe -s -i -X DELETE "http://127.0.0.1:3000/api/tasks/$($created.id)"
curl.exe -s -i -X DELETE "http://127.0.0.1:3000/api/tasks/$($created.id)"
```

**Teaches:** `204` with no `Content-Length` header, then `404` on the retry. Watch the access log show the same path twice with two different statuses, then decide what *your* client should do about it -- retrying a delete that already succeeded is a bug you want to know about.

### 12.4 Clear a description with `null`

Create a task with a description, read it, `PATCH` it with `{"description":null}`, read it again.

```powershell
$body = '{"title":"Has a description","description":"This text should disappear."}'
Set-Content -Path "$env:TEMP\desc.json" -Value $body -NoNewline
$task = curl.exe -s -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" --data-binary "@$env:TEMP\desc.json" | ConvertFrom-Json
$task.description   # This text should disappear.

$clear = '{"description":null}'
Set-Content -Path "$env:TEMP\clear.json" -Value $clear -NoNewline
curl.exe -s -X PATCH "http://127.0.0.1:3000/api/tasks/$($task.id)" -H "Content-Type: application/json" --data-binary "@$env:TEMP\clear.json" | ConvertFrom-Json | Select-Object -ExpandProperty description
```

**Teaches:** the three-way distinction between omitting a field, sending `null` and sending an empty string. Then send `{"description":""}` and confirm it also becomes `null` -- empty string and no description are the same thing to this API. Finally send `{}` and confirm the `422`.

### 12.5 `PUT` on an id that does not exist

```powershell
curl.exe -s -i -X PUT http://127.0.0.1:3000/api/tasks/00000000-0000-4000-8000-000000000000 `
  -H "Content-Type: application/json" -d '{"title":"Nothing here"}'
```

**Teaches:** a `404` from a *write*, which is different in kind from a `404` on a read. Note that this API does not offer "create on PUT", so there is no way to accidentally create a task under the wrong id. Compare the message with the `404` from `GET /api/tasks/nope`.

### 12.6 Send a body over the size limit

```powershell
Set-Content -Path "$env:TEMP\huge.json" -Value ('{"title":"' + ('a' * 200000) + '"}') -NoNewline
curl.exe -s -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: application/json" --data-binary "@$env:TEMP\huge.json"
```

**Teaches:** `413`, a limit expressed in bytes, and why this test *requires* the file pattern from Section 5 -- a 200,000-byte body cannot be passed on a Windows command line at all. Then restart with a smaller limit and try the same request:

```powershell
$env:MAX_BODY_BYTES=500; npm run dev
```

A body of 600 bytes now gets a `413`. **Teaches:** the difference between a client bug and a server configuration choice.

### 12.7 `PATCH` the collection and read `Allow`

```powershell
curl.exe -s -i -X PATCH http://127.0.0.1:3000/api/tasks
curl.exe -s -i -X PATCH http://127.0.0.1:3000/api/nothing-here
```

**Teaches:** the difference between `404` ("no such URL") and `405` ("that URL exists, but not for that method"), and how `Allow` is what makes the second one actionable. The second command shows the `Allow` header disappearing, because there is no route to describe.

### 12.8 Write a unit test for a validator rule that may not exist yet

Pick a rule and test it. A good candidate: **"a title that is only whitespace is rejected."** Write the test first, without checking the validator source. Add it to `tests/unit.test.ts` inside `describe('parseTaskWriteInput', ...)`:

```ts
  it('rejects a title that is only whitespace', () => {
    const error = captureHttpError(() => parseTaskWriteInput(validInput({ title: '   ' })));

    assert.equal(error.status, 422);
    const issue = error.details.find((detail) => detail.field === 'title');
    assert.ok(issue, 'expected a validation issue for the title field');
    assert.match(issue.message, /whitespace/);
  });
```

```powershell
node --test --test-name-pattern="whitespace" tests/unit.test.ts
```

**Teaches two things, and the second is the real lesson.** The first is mechanics: how to assert that a function throws the *right* error, using `captureHttpError` so you can inspect `status`, `code` and `details` rather than just "something threw".

The second is more valuable. **The rule already exists, so this test passes the first time you run it** -- and that is a legitimate outcome, not a wasted exercise. You have verified a rule you had only read about, you now have a regression test for it, and you have learned to check what the code does before assuming it does nothing. Finding that a behavior is already covered is a real result.

Now try a rule that genuinely does **not** exist, and watch a test fail for the right reason. Candidate: **"a description longer than 2000 characters is rejected."** Check the limit first (`MAX_DESCRIPTION_LENGTH` is exported from the validator module), write the test, run it. If it passes, find the line in the validator that makes it pass. If it fails, you have found a gap -- and the failure message (`expected 422, actual undefined`) tells you exactly which promise the code does not keep. The habit to build is: **write the assertion you believe should hold, then find out.** That is what testing is, and it is more useful than reading the code and agreeing with it.

### 12.9 Add a `?sort=` parameter and test it

This one touches the whole stack and is the natural next step.

1. **Decide the contract.** Which fields, which directions, what happens on an unknown value? Write it down before writing code -- for example `?sort=createdAt` and `?sort=-createdAt`, where a leading `-` means descending, and an unknown field is a `400` with the same `details` shape as `?limit=abc`.
2. **Validation first.** Add `sort` to the allow-list in `parseTaskListQuery` in `src/validation/task.validation.ts`. Unknown parameters are currently rejected, so `?sort=title` returns a `400` until you do this. Confirm the current behavior before your change:

   ```powershell
   curl.exe -s -i "http://127.0.0.1:3000/api/tasks?sort=title"
   ```
3. **Sorting in the store.** Apply the sort in `TaskStore.list` **before** slicing for `limit`/`offset`. Sorting a page instead of the whole result set is a classic bug: the page looks sorted, but page 2 contains items that belong on page 1.
4. **A unit test** in `tests/unit.test.ts` proving the order, and specifically that the whole set is sorted before pagination -- create three tasks, sort descending, take `limit=2`, and assert you got the correct two.
5. **An integration test** in `tests/api.test.ts` proving the HTTP behavior, including the `400` for an unknown sort field:

   ```ts
   it('sorts before paginating', async () => {
     for (const title of ['a', 'b', 'c']) {
       await createTask({ title });
     }

     const response = await fetch(`${baseUrl}/api/tasks?sort=-title&limit=2`);
     assert.equal(response.status, 200);

     const body = await readJson<TaskPayload[]>(response);
     assert.deepEqual(
       body.map((task) => task.title),
       ['c', 'b'],
     );
   });
   ```

**Teaches:** the full loop -- decide a contract, validate the input, implement the behavior, unit-test the logic, integration-test the contract. It also shows why the two test files exist: the unit test proves the sort is correct, and the integration test proves it is correct *and* reachable over HTTP with the right status codes. Skipping either leaves a real gap.

### 12.10 Where to go next

The suite deliberately does not test a few things, and each is a good exercise:

- **Middleware ordering.** The order in `src/app.ts` is argued in its comments but not asserted, because asserting on it would mean asserting on log output. Could a test check it structurally instead -- for instance, that an error response still carries `Cache-Control: no-store`?
- **Graceful shutdown.** `src/server.ts` runs at import time, so a test cannot import it without binding port 3000. Extracting a `startServer(config)` function would make it testable and would make the startup banner assertable -- the natural next refactor for this codebase.
- **Concurrent writes.** Node runs your JavaScript on one thread, so there is no true parallelism to test against an in-memory `Map`. The moment a real database is involved, that changes, and so does what you need to test.
