export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return handleOptions(req);

    try {
      if (url.pathname === "/" && req.method === "GET") {
        return jsonResponse({
          success: true,
          discord: "https://discord.gg/cwDTVKyKJz",
          website: "https://ish.junioralive.in",
          repo: "https://github.com/junioralive/gptoss-proxy",
        });
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        return listModels();
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return openAICompatible(req, env);
      }

      if (url.pathname === "/auth/status" && req.method === "GET") {
        return authStatus(req, env);
      }

      if (url.pathname === "/auth/login" && req.method === "POST") {
        return authLogin(req, env);
      }

      if (url.pathname === "/auth/logout" && req.method === "POST") {
        return authLogout(req, env);
      }

      return jsonResponse({ error: { message: "Not found", type: "invalid_request_error", code: "not_found" } }, 404);
    } catch (error) {
      console.error("WORKER ERROR", serializeError(error));
      return jsonError(500, "Internal worker error", "server_error", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

const GPT_OSS_URL = "https://api.gpt-oss.com/chatkit";
const SUPPORTED_MODELS = new Set(["gpt-oss-120b", "gpt-oss-20b"]);
const AUTH_KV_KEY = "gptoss_auth_cookie";
const AUTH_STATUS = {
  ready: "ready",
  missing: "missing",
  invalid: "invalid",
  expired: "expired",
  required: "required",
};

const BASE_HEADERS = {
  accept: "text/event-stream",
  "accept-language": "en-US,en;q=0.9,id;q=0.8",
  "content-type": "application/json",
  origin: "https://gpt-oss.com",
  referer: "https://gpt-oss.com/",
  "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="132"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "x-selected-model": "gpt-oss-120b",
};

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "content-type, x-reasoning-effort, x-gptoss-thread-id, x-gptoss-user-id, x-show-reasoning, authorization, x-gptoss-cookie",
    "access-control-expose-headers": "x-gptoss-user-id, x-gptoss-thread-id",
    ...extra,
  };
}

function handleOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ "content-type": "application/json", ...extraHeaders }),
  });
}

function jsonError(status, message, type = "invalid_request_error", extras = {}) {
  return jsonResponse(
    {
      error: {
        message,
        type,
        param: null,
        code: extras.code || null,
        ...extras,
      },
    },
    status,
  );
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function getReasoningLevel(bodyMeta, headers) {
  const hdr = headers.get("x-reasoning-effort") || "";
  const meta = bodyMeta && typeof bodyMeta === "object" ? bodyMeta.reasoning_effort : "";
  const level = (hdr || meta || "medium").toLowerCase();
  return ["none", "low", "medium", "high"].includes(level) ? level : "medium";
}

function getShowReasoning(bodyMeta, headers) {
  const hdr = (headers.get("x-show-reasoning") || "").toLowerCase();
  if (["true", "1", "yes"].includes(hdr)) return true;
  if (["false", "0", "no"].includes(hdr)) return false;
  const meta = bodyMeta && typeof bodyMeta === "object" ? bodyMeta.show_reasoning : undefined;
  if (typeof meta === "boolean") return meta;
  return true;
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && (part.type === undefined || part.type === "text")) {
            return part.text ?? "";
          }
          return "";
        })
        .join("");
    }
    return typeof content === "string" ? content : JSON.stringify(content ?? "");
  }
  return "";
}

function sseResponseHeaders() {
  return {
    ...corsHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

function cryptoRandomId(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function isTrivialReasoning(text) {
  if (!text) return true;
  const normalized = String(text).trim().toLowerCase();
  return normalized === "" || normalized === "done";
}

function sanitizeCookie(cookie) {
  if (!cookie || typeof cookie !== "string") return "";
  return cookie
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("; ");
}

function maskCookie(cookie) {
  if (!cookie) return null;
  const normalized = sanitizeCookie(cookie);
  if (!normalized) return null;
  return normalized
    .split("; ")
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx < 0) return pair;
      const key = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (value.length <= 8) return `${key}=***`;
      return `${key}=${value.slice(0, 4)}...${value.slice(-4)}`;
    })
    .join("; ");
}

function getCookieValue(cookie, key) {
  const normalized = sanitizeCookie(cookie);
  if (!normalized) return null;
  for (const pair of normalized.split("; ")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    if (name !== key) continue;
    return pair.slice(idx + 1).trim() || null;
  }
  return null;
}

async function loadStoredCookie(env) {
  if (env.GPTOSS_AUTH_COOKIE) return sanitizeCookie(env.GPTOSS_AUTH_COOKIE);
  if (env.HF_COOKIE) return sanitizeCookie(env.HF_COOKIE);
  if (env.AUTH_KV && typeof env.AUTH_KV.get === "function") {
    return sanitizeCookie((await env.AUTH_KV.get(AUTH_KV_KEY)) || "");
  }
  return "";
}

async function saveStoredCookie(env, cookie) {
  if (!env.AUTH_KV || typeof env.AUTH_KV.put !== "function") {
    throw new Error("AUTH_KV binding missing; cannot persist login session");
  }
  await env.AUTH_KV.put(AUTH_KV_KEY, sanitizeCookie(cookie));
}

async function clearStoredCookie(env) {
  if (env.AUTH_KV && typeof env.AUTH_KV.delete === "function") {
    await env.AUTH_KV.delete(AUTH_KV_KEY);
  }
}

async function resolveAuthCookie(req, env) {
  const headerCookie = sanitizeCookie(req.headers.get("x-gptoss-cookie") || "");
  if (headerCookie) return { source: "request_header", cookie: headerCookie };

  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = sanitizeCookie(authHeader.slice(7).trim());
    if (bearer.includes("=")) return { source: "authorization", cookie: bearer };
  }

  const storedCookie = await loadStoredCookie(env);
  if (storedCookie) {
    return {
      source: env.GPTOSS_AUTH_COOKIE ? "env:GPTOSS_AUTH_COOKIE" : env.HF_COOKIE ? "env:HF_COOKIE" : "kv:AUTH_KV",
      cookie: storedCookie,
    };
  }

  return { source: null, cookie: "" };
}

function extractWidgetText(widget) {
  if (!widget || typeof widget !== "object") return "";
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.value === "string") out.push(node.value);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(widget);
  return out.join(" ").trim();
}

function detectAuthOrUpstreamIssue(evt) {
  if (!evt || typeof evt !== "object") return null;

  const candidateText = [
    evt.message,
    evt.error,
    evt.detail,
    evt.item && evt.item.text,
    evt.item && evt.item.widget ? extractWidgetText(evt.item.widget) : "",
    evt.widget ? extractWidgetText(evt.widget) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (evt.type === "thread.item_done" && evt.item && evt.item.type === "widget") {
    if (candidateText.includes("sign in") && candidateText.includes("hugging face")) {
      return {
        kind: "auth_required",
        status: 401,
        authStatus: AUTH_STATUS.required,
        message: "GPT-OSS authentication required",
        detail: extractWidgetText(evt.item.widget),
      };
    }
    if (candidateText.includes("captcha")) {
      return {
        kind: "captcha_required",
        status: 403,
        authStatus: AUTH_STATUS.invalid,
        message: "GPT-OSS rejected session with CAPTCHA challenge",
        detail: extractWidgetText(evt.item.widget),
      };
    }
  }

  if (candidateText.includes("rate limit") || candidateText.includes("too many requests")) {
    return {
      kind: "rate_limit",
      status: 429,
      authStatus: AUTH_STATUS.ready,
      message: "GPT-OSS rate limit reached",
      detail: candidateText,
    };
  }

  if (candidateText.includes("session expired") || candidateText.includes("login expired")) {
    return {
      kind: "session_expired",
      status: 401,
      authStatus: AUTH_STATUS.expired,
      message: "GPT-OSS session expired",
      detail: candidateText,
    };
  }

  if (candidateText.includes("invalid session") || candidateText.includes("not authenticated")) {
    return {
      kind: "invalid_session",
      status: 401,
      authStatus: AUTH_STATUS.invalid,
      message: "GPT-OSS session invalid",
      detail: candidateText,
    };
  }

  return null;
}

function logUpstream(meta) {
  console.log(
    JSON.stringify({
      event: "gptoss_upstream",
      upstream_status: meta.upstreamStatus,
      upstream_content_type: meta.contentType,
      auth_status: meta.authStatus,
      auth_required: meta.authRequired,
      thread_id: meta.threadId,
      model: meta.model,
      auth_source: meta.authSource,
      cookie_preview: meta.cookiePreview,
    }),
  );
}

function listModels() {
  const now = Math.floor(Date.now() / 1000);
  const models = [...SUPPORTED_MODELS].map((id) => ({
    id,
    object: "model",
    created: now,
    owned_by: "gpt-oss",
    permission: [],
    root: id,
    parent: null,
  }));
  return jsonResponse({ object: "list", data: models });
}

async function authStatus(req, env) {
  const resolved = await resolveAuthCookie(req, env);
  const cookie = resolved.cookie;
  const status = cookie ? AUTH_STATUS.ready : AUTH_STATUS.missing;
  return jsonResponse({
    ok: status === AUTH_STATUS.ready,
    auth_status: status,
    source: resolved.source,
    has_cookie: Boolean(cookie),
    cookie_preview: maskCookie(cookie),
    has_user_id: Boolean(getCookieValue(cookie, "user_id")),
    notes: [
      "Provide full GPT-OSS/Hugging Face session cookie string.",
      "Prefer `wrangler secret put HF_COOKIE` or `wrangler secret put GPTOSS_AUTH_COOKIE`.",
      "Use KV binding AUTH_KV if you want `/auth/login` and `/auth/logout` to persist state.",
    ],
  });
}

async function authLogin(req, env) {
  const body = await req.json().catch(() => ({}));
  const cookie = sanitizeCookie(
    body.cookie || body.hf_cookie || req.headers.get("x-gptoss-cookie") || "",
  );

  if (!cookie) {
    return jsonError(400, "Missing cookie", "invalid_request_error", {
      hint: "Send JSON body with `cookie` or set `x-gptoss-cookie` header.",
    });
  }

  if (!getCookieValue(cookie, "user_id")) {
    return jsonError(400, "Cookie missing `user_id`", "invalid_request_error", {
      hint: "Use full browser cookie string copied after successful Hugging Face login on gpt-oss.com.",
    });
  }

  try {
    await saveStoredCookie(env, cookie);
  } catch (error) {
    return jsonError(500, "Failed to persist cookie", "server_error", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return jsonResponse({
    ok: true,
    auth_status: AUTH_STATUS.ready,
    source: "kv:AUTH_KV",
    cookie_preview: maskCookie(cookie),
  });
}

async function authLogout(req, env) {
  await clearStoredCookie(env);
  return jsonResponse({
    ok: true,
    auth_status: AUTH_STATUS.missing,
    cleared: true,
  });
}

async function openAICompatible(req, env) {
  const body = await req.json().catch(() => ({}));
  const model = body.model || "gpt-oss-120b";
  const stream = Boolean(body.stream);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const metadata = body && typeof body.metadata === "object" ? body.metadata : {};
  const streamOptions = body && typeof body.stream_options === "object" ? body.stream_options : null;
  const includeUsage = streamOptions && streamOptions.include_usage === true;

  if (!SUPPORTED_MODELS.has(model)) {
    return jsonError(400, `Unsupported model: ${model}`, "invalid_request_error", {
      supported: [...SUPPORTED_MODELS],
    });
  }

  const reasoning = getReasoningLevel(metadata, req.headers);
  const showReasoning = getShowReasoning(metadata, req.headers);
  const threadId = req.headers.get("x-gptoss-thread-id") || metadata.gptoss_thread_id || null;
  const text = lastUserText(messages);
  const auth = await resolveAuthCookie(req, env);

  if (!auth.cookie) {
    return jsonError(401, "GPT-OSS authentication required", "authentication_error", {
      auth_status: AUTH_STATUS.missing,
      code: "auth_required",
      hint: "Set `HF_COOKIE` or `GPTOSS_AUTH_COOKIE` secret, or POST `/auth/login` with browser cookie.",
    });
  }

  const upstreamBody = JSON.stringify({
    op: threadId ? "threads.addMessage" : "threads.create",
    params: {
      input: {
        text,
        content: [{ type: "input_text", text }],
        quoted_text: "",
        attachments: [],
      },
      threadId,
    },
  });

  const headers = {
    ...BASE_HEADERS,
    "x-selected-model": model,
    "x-reasoning-effort": reasoning,
    "x-show-reasoning": showReasoning ? "true" : "false",
    cookie: auth.cookie,
  };

  const upstream = await fetch(GPT_OSS_URL, {
    method: "POST",
    headers,
    body: upstreamBody,
  });

  const contentType = upstream.headers.get("content-type") || "";
  const created = Math.floor(Date.now() / 1000);
  const openaiId = `chatcmpl_${cryptoRandomId(24)}`;

  if (!upstream.ok || !upstream.body) {
    logUpstream({
      upstreamStatus: upstream.status,
      contentType,
      authStatus: AUTH_STATUS.invalid,
      authRequired: false,
      threadId,
      model,
      authSource: auth.source,
      cookiePreview: maskCookie(auth.cookie),
    });
    return jsonError(502, `GPT-OSS upstream rejected request`, "api_error", {
      upstream_status: upstream.status,
      auth_status: AUTH_STATUS.invalid,
    });
  }

  const promptTokens = Math.max(1, Math.ceil(text.length / 4.5));

  if (!stream) {
    const aggregated = await collectFromSSE(upstream.body);

    logUpstream({
      upstreamStatus: upstream.status,
      contentType,
      authStatus: aggregated.authIssue ? aggregated.authIssue.authStatus : AUTH_STATUS.ready,
      authRequired: Boolean(aggregated.authIssue),
      threadId: aggregated.threadOut || threadId,
      model,
      authSource: auth.source,
      cookiePreview: maskCookie(auth.cookie),
    });

    if (aggregated.authIssue) {
      return jsonError(aggregated.authIssue.status, aggregated.authIssue.message, "authentication_error", {
        auth_status: aggregated.authIssue.authStatus,
        detail: aggregated.authIssue.detail,
        thread_id: aggregated.threadOut,
        code: "auth_required",
      });
    }

    if (!aggregated.textOut) {
      return jsonError(502, "GPT-OSS returned empty response", "api_error", {
        auth_status: AUTH_STATUS.ready,
        thread_id: aggregated.threadOut,
      });
    }

    const completionTokens = Math.max(1, Math.ceil(aggregated.textOut.length / 4.5));
    const totalTokens = promptTokens + completionTokens;

    return jsonResponse({
      id: openaiId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: aggregated.textOut,
            ...(aggregated.reasoningOut.length > 0 ? { reasoning_content: aggregated.reasoningOut.join("\n") } : {})
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      system_fingerprint: aggregated.threadOut || "fp_gptoss",
    }, 200, {
      "x-gptoss-thread-id": aggregated.threadOut || "",
    });
  }

  return streamOpenAIResponse({
    upstream,
    openaiId,
    created,
    model,
    auth,
    threadId,
    contentType,
    promptTokens,
    includeUsage,
  });
}

function toSSEErrorChunk({ openaiId, created, model, message, type = "server_error" }) {
  return `data: ${JSON.stringify({
    id: openaiId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
    error: { message, type },
  })}\n\n`;
}

function streamOpenAIResponse({ upstream, openaiId, created, model, auth, threadId, contentType, promptTokens, includeUsage }) {
  const streamOut = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader = upstream.body.getReader();
      let buffer = "";
      let resolvedThreadId = threadId;
      let authIssue = null;
      let generatedTextLength = 0;

      // 9router & LiteLLM compatibility: chunk pertama mengirimkan delta yang berisi role: assistant
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: openaiId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          })}\n\n`,
        ),
      );

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data: ")) continue;

            const payload = line.slice(6).trim();
            if (!payload || payload === "[DONE]") continue;

            let evt;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }

            if (!resolvedThreadId) {
              resolvedThreadId = evt.threadId || evt.thread?.id || resolvedThreadId;
            }

            const issue = detectAuthOrUpstreamIssue(evt);
            if (issue) {
              authIssue = issue;
              controller.enqueue(
                encoder.encode(
                  toSSEErrorChunk({
                    openaiId,
                    created,
                    model,
                    message: issue.message,
                    type: issue.kind,
                  }),
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              logUpstream({
                upstreamStatus: upstream.status,
                contentType,
                authStatus: issue.authStatus,
                authRequired: true,
                threadId: resolvedThreadId,
                model,
                authSource: auth.source,
                cookiePreview: maskCookie(auth.cookie),
              });
              controller.close();
              return;
            }

            if (
              evt.type === "thread.item_updated" &&
              evt.update &&
              evt.update.type === "cot.entry_added"
            ) {
              const entry = evt.update.entry || {};
              const text = (entry.content || entry.summary || "").trim();
              if (!isTrivialReasoning(text)) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: openaiId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: { reasoning_content: text },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`,
                  ),
                );
              }
              continue;
            }

            const isDeltaType =
              evt.type === "assistant_message.content_part.text_delta" ||
              (evt.type === "thread.item_updated" &&
                evt.update &&
                evt.update.type === "assistant_message.content_part.text_delta");

            if (isDeltaType) {
              const delta = evt.delta !== undefined ? evt.delta : evt.update ? evt.update.delta : undefined;
              if (typeof delta === "string" && delta.length > 0) {
                generatedTextLength += delta.length;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: openaiId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: { content: delta },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`,
                  ),
                );
              }
              continue;
            }

            if (evt.type === "thread.item_done" && evt.item && evt.item.type === "assistant_message") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: openaiId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  })}\n\n`,
                ),
              );

              if (includeUsage) {
                const completionTokens = Math.max(1, Math.ceil(generatedTextLength / 4.5));
                const totalTokens = promptTokens + completionTokens;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: openaiId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [],
                      usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: totalTokens,
                      },
                    })}\n\n`,
                  ),
                );
              }

              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              logUpstream({
                upstreamStatus: upstream.status,
                contentType,
                authStatus: AUTH_STATUS.ready,
                authRequired: false,
                threadId: resolvedThreadId,
                model,
                authSource: auth.source,
                cookiePreview: maskCookie(auth.cookie),
              });
              controller.close();
              return;
            }
          }
        }

        if (!authIssue) {
          controller.enqueue(
            encoder.encode(toSSEErrorChunk({
              openaiId,
              created,
              model,
              message: "GPT-OSS stream ended without assistant content",
              type: "empty_response",
            })),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          logUpstream({
            upstreamStatus: upstream.status,
            contentType,
            authStatus: AUTH_STATUS.ready,
            authRequired: false,
            threadId: resolvedThreadId,
            model,
            authSource: auth.source,
            cookiePreview: maskCookie(auth.cookie),
          });
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(toSSEErrorChunk({
            openaiId,
            created,
            model,
            message: error instanceof Error ? error.message : String(error),
          })),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(streamOut, {
    status: 200,
    headers: sseResponseHeaders(),
  });
}

async function collectFromSSE(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let textOut = "";
  const reasoningOut = [];
  let threadOut = null;
  let authIssue = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;

      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      if (!threadOut) {
        threadOut = evt.threadId || evt.thread?.id || threadOut;
      }

      const issue = detectAuthOrUpstreamIssue(evt);
      if (issue) {
        authIssue = issue;
        continue;
      }

      if (
        evt.type === "thread.item_updated" &&
        evt.update &&
        evt.update.type === "cot.entry_added"
      ) {
        const entry = evt.update.entry || {};
        const text = (entry.content || entry.summary || "").trim();
        if (!isTrivialReasoning(text)) reasoningOut.push(text);
        continue;
      }

      const isDeltaType =
        evt.type === "assistant_message.content_part.text_delta" ||
        (evt.type === "thread.item_updated" &&
          evt.update &&
          evt.update.type === "assistant_message.content_part.text_delta");

      if (isDeltaType) {
        const delta = evt.delta !== undefined ? evt.delta : evt.update ? evt.update.delta : "";
        if (typeof delta === "string") textOut += delta;
      }
    }
  }

  return { textOut, reasoningOut, threadOut, authIssue };
}
