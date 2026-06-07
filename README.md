# GPTOSS-Proxy OpenAI-Compatible

> ## Leave a ⭐ if this helped you

A tiny Cloudflare Worker that exposes a **single OpenAI-compatible endpoint**:

- `POST /v1/chat/completions` → supports `stream: true|false`, token streaming, and **reasoning** (CoT) as `reasoning_content`.
- `GET /v1/models` → lists available models: `gpt-oss-120b`, `gpt-oss-20b`.
- `GET /` → returns `{ success: true, discord, website, repo }`.

## 🚀 One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ndeso17/gptoss-proxy)

## 🚀 Deploy with Wrangler

### 1) Install Wrangler

```bash
npm install -g wrangler
```

### 2) Log in to Cloudflare

```bash
wrangler login
```

### 3) Deploy worker

```bash
cd /path/to/gptoss-proxy-main
wrangler deploy
```

This Worker requires a Hugging Face / GPT-OSS cookie. Set this secret first.

**How to get cookie from browser:**

1. Login to `https://gpt-oss.com`
2. Open `F12` → `Application` tab (`Storage` in Firefox/Chrome)
3. Open `Cookies` → select `https://gpt-oss.com`
4. Copy values from these cookies:
   - `user_id`
   - `session`
5. Combine them in this format:

`user_id=YOUR_USER_ID; session=YOUR_SESSION`

Run this command:

```bash
wrangler secret put HF_COOKIE
```

Paste full cookie in this format:

```text
user_id=...; session=...
```

Notes:

- do not enter only `user_id`
- do not enter only raw UUID
- do not enter only `session`
- it must be combined as `user_id=...; session=...`

### 4) Verify endpoint

```bash
curl https://<your-worker>.workers.dev/auth/status
```

NOTE: You can [join our Discord](https://discord.gg/cwDTVKyKJz) server if you run into deployment issues.

## 🔐 Auth patch

This forked repo has already been updated for latest GPT-OSS auth. See also:

- [`AUTH_ANALYSIS&PATCH.md`](./AUTH_ANALYSIS&PATCH.md)

Note: original repo may fail requests because of newer Hugging Face auth flow. Use fork `ndeso17` + this auth patch for deployment.

## ✨ Features

- OpenAI-compatible `/v1/chat/completions` (streaming & non-stream)
- CoT **reasoning stream** → `choices[0].delta.reasoning_content`
- **Models**: `gpt-oss-120b` (larger) and `gpt-oss-20b` (faster)
- **Reasoning effort** control: `none | low | medium | high`
- **Thread persistence** via headers or payload metadata
- CORS enabled for browser clients

## ▶️ Endpoints

### `GET /`

Returns:

```json
{
  "success": true,
  "discord": "https://discord.gg/cwDTVKyKJz",
  "website": "https://ish.junioralive.in",
  "repo": "https://github.com/junioralive/gptoss-proxy"
}
```

### `GET /v1/models`

Lists supported models:

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-oss-120b", "object": "model" },
    { "id": "gpt-oss-20b", "object": "model" }
  ]
}
```

### `POST /v1/chat/completions`

OpenAI-style body:

```json
{
  "model": "gpt-oss-20b",
  "messages": [{ "role": "user", "content": "Say hi and then a space fact." }],
  "stream": true,
  "metadata": {
    "gptoss_user_id": "u123", // optional
    "gptoss_thread_id": "thr_456", // optional
    "reasoning_effort": "medium" // none|low|medium|high
  }
}
```

**Optional headers** (override metadata):

- `X-GPTOSS-User-Id: <uuid>`
- `X-GPTOSS-Thread-Id: thr_...`
- `X-Reasoning-Effort: none|low|medium|high`

**Streaming response:** OpenAI-style SSE

- token deltas → `choices[0].delta.content`
- reasoning updates → `choices[0].delta.reasoning_content`
- terminates with chunk where `finish_reason = "stop"` then `data: [DONE]`

**Non-streaming:** standard `chat.completion` JSON.

## 🧪 Quick start (cURL)

**Streaming:**

```bash
curl -N https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Reasoning-Effort: medium" \
  -d '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"hello!"}],"stream":true}'
```

**Non-stream:**

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss-20b","messages":[{"role":"user","content":"One short sentence."}],"stream":false}'
```

## 🐍 Python example

```python
import os, json, requests

BASE = "https://<your-worker>.workers.dev"

# stream
payload = {
    "model": "gpt-oss-120b",
    "messages": [{"role":"user","content":"Say hi, then a fun space fact."}],
    "stream": True,
    "metadata": {"reasoning_effort": "medium"}
}
with requests.post(f"{BASE}/v1/chat/completions",
                   headers={"Content-Type":"application/json"},
                   data=json.dumps(payload), stream=True, timeout=120) as r:
    r.raise_for_status()
    for line in r.iter_lines(decode_unicode=True):
        if not line: continue
        if line.startswith("data: "):
            data = line[6:].strip()
            if data == "[DONE]":
                print("\n[DONE]"); break
            obj = json.loads(data)
            delta = obj["choices"][0]["delta"]
            if "reasoning_content" in delta:
                print("\n[reasoning]", delta["reasoning_content"])
            if "content" in delta:
                print(delta["content"], end="", flush=True)

# non-stream
payload = {"model":"gpt-oss-20b","messages":[{"role":"user","content":"Now reply in one short sentence."}],"stream":False}
print("\n\nNon-stream result:")
print(requests.post(f"{BASE}/v1/chat/completions",
                    headers={"Content-Type":"application/json"},
                    json=payload, timeout=60).json())
```

## 🤝 Use with OpenAI SDKs

Point SDK to your Worker:

**Python**

```python
from openai import OpenAI
client = OpenAI(base_url="https://<your-worker>.workers.dev/v1", api_key="dummy")
stream = client.chat.completions.create(
  model="gpt-oss-20b",
  messages=[{"role":"user","content":"hello!"}],
  stream=True,
  metadata={"reasoning_effort": "low"}
)
for chunk in stream:
    d = chunk.choices[0].delta
    if getattr(d, "reasoning_content", None): print("\n[reasoning]", d.reasoning_content)
    if getattr(d, "content", None): print(d.content, end="")
```

**Node**

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "https://<your-worker>.workers.dev/v1",
  apiKey: "dummy",
});
const stream = await client.chat.completions.create({
  model: "gpt-oss-120b",
  messages: [{ role: "user", content: "hello!" }],
  stream: true,
  metadata: { reasoning_effort: "medium" },
});
for await (const chunk of stream) {
  const d = chunk.choices[0].delta;
  if (d.reasoning_content) console.log("\n[reasoning]", d.reasoning_content);
  if (d.content) process.stdout.write(d.content);
}
```

## ⚠️ Disclaimer

This script is provided **as proof of concept**.
It is **not intended to cause harm or be misused**.

If you encounter any issues or have concerns, please contact:
📧 [support@junioralive.in](mailto:support@junioralive.in)
💬 [Join our Discord](https://discord.gg/cwDTVKyKJz)

## 🔧 Notes & tips

- **Models**: choose `gpt-oss-20b` for speed; `gpt-oss-120b` for quality.
- **Reasoning effort**: set via header or `metadata.reasoning_effort` (default `medium`).
- **Threads / Users**: pass `X-GPTOSS-Thread-Id` + `X-GPTOSS-User-Id` (or `metadata.gptoss_*`) to keep conversation history.
- **CORS**: enabled by default. If you add auth, include `authorization` in `access-control-allow-headers`.
