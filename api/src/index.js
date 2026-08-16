const MAX_QUERY_LENGTH = 500;

// The production docs origin. Requests from any other Origin are rejected
// server-side (browsers already enforce this via CORS, but a non-browser
// client can ignore CORS entirely, so we also check Origin ourselves).
const ALLOWED_ORIGIN = "https://kernel-internals.org";

// Per-IP fixed-window limits. Chat is limited harder than search since it
// triggers both an embedding call and an LLM completion.
const RATE_LIMITS = {
  search: { max: 20, windowSeconds: 60 },
  chat: { max: 5, windowSeconds: 60 },
  // MCP traffic is identified by a shared key (see isAuthenticatedMcp) and
  // gets its own, more generous bucket since it's a legitimate dev tool
  // rather than anonymous browser traffic.
  "search:mcp": { max: 60, windowSeconds: 60 },
};

// Aggregate limits across ALL callers combined, independent of source IP.
// This is the backstop against distributed abuse (many IPs, or a botnet)
// that would otherwise slip under the per-IP limits above.
const GLOBAL_RATE_LIMITS = {
  search: { max: 300, windowSeconds: 60 },
  chat: { max: 60, windowSeconds: 60 },
};

// Hard daily ceiling on AI invocations, regardless of how requests are
// distributed across IPs or time. This bounds worst-case Workers AI spend
// even if every other layer of defense is somehow evaded.
const DAILY_BUDGET = {
  search: 20000,
  chat: 3000,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Vary": "Origin",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

function getClientId(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// The MCP server sends a shared key so its traffic can be recognized and
// given its own rate-limit bucket instead of being treated as anonymous
// browser traffic. This key ships in a public npm package, so it is NOT a
// secret in the cryptographic sense — anyone who reads the package source
// can extract and reuse it. Its value is (a) segmenting legitimate MCP
// traffic from anonymous scraping for rate-limit purposes, and (b) giving
// us a kill switch: if it leaks and gets abused, rotating MCP_SHARED_KEY
// immediately invalidates every copy in the wild without touching the
// chat widget's Origin-based access.
function isAuthenticatedMcp(request, env) {
  const key = request.headers.get("X-API-Key");
  return !!key && !!env.MCP_SHARED_KEY && key === env.MCP_SHARED_KEY;
}

// Best-effort fixed-window counters backed by KV. KV writes aren't strongly
// consistent across edge locations, so these deter casual/scripted/
// distributed abuse rather than providing an exact global limit — an
// acceptable tradeoff for protecting a free-tier AI/Vectorize budget.
async function incrementCounter(env, key, windowSeconds) {
  if (!env.RATE_LIMIT_KV) {
    // KV binding not configured (e.g. local dev) — fail open rather than
    // block all traffic, but this should never happen in production.
    return 0;
  }
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  // expirationTtl must be >= 60s per KV constraints.
  await env.RATE_LIMIT_KV.put(key, String(current + 1), {
    expirationTtl: Math.max(windowSeconds, 60),
  });
  return current;
}

async function checkRateLimit(env, clientId, bucket, mcp) {
  const limitKey = mcp ? `${bucket}:mcp` : bucket;
  const perIpLimit = RATE_LIMITS[limitKey] || RATE_LIMITS[bucket];
  const globalLimit = GLOBAL_RATE_LIMITS[bucket];
  const dailyLimit = DAILY_BUDGET[bucket];

  const minuteWindow = Math.floor(Date.now() / 60000);
  const dayWindow = Math.floor(Date.now() / 86400000);

  const [perIpCount, globalCount, dailyCount] = await Promise.all([
    incrementCounter(env, `rl:${limitKey}:${clientId}:${minuteWindow}`, 60),
    incrementCounter(env, `rl:global:${bucket}:${minuteWindow}`, 60),
    incrementCounter(env, `budget:${bucket}:${dayWindow}`, 86400),
  ]);

  if (dailyCount >= dailyLimit) {
    return { ok: false, reason: "Daily usage budget reached. Please try again tomorrow." };
  }
  if (globalCount >= globalLimit.max) {
    return { ok: false, reason: "Service is under heavy load. Please try again shortly." };
  }
  if (perIpCount >= perIpLimit.max) {
    return { ok: false, reason: "Rate limit exceeded. Please slow down." };
  }
  return { ok: true };
}

// Verifies a Cloudflare Turnstile token server-side. Turnstile is a
// CAPTCHA-like challenge that's solved invisibly for most real browser
// visitors but can't be completed by a plain HTTP client (curl, a Python
// script, etc.) without running a real browser — it's the main defense
// against a scripted REST client hammering the chat/search endpoints
// directly, since Origin-header checks alone are trivially spoofed by
// any non-browser caller.
async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY) {
    // Not configured yet (e.g. before initial Cloudflare setup) — fail
    // open so the site keeps working, but this should be filled in before
    // going live publicly.
    return true;
  }
  if (!token) return false;

  const formData = new URLSearchParams();
  formData.append("secret", env.TURNSTILE_SECRET_KEY);
  formData.append("response", token);
  if (ip) formData.append("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
    });
    const outcome = await res.json();
    return outcome.success === true;
  } catch (e) {
    console.error("Turnstile verification failed:", e);
    // Verification service itself errored — fail closed, since the whole
    // point of this check is to gate the expensive path.
    return false;
  }
}

function validateQuery(body) {
  const query = body && body.query;
  if (typeof query !== "string" || !query.trim()) {
    return { error: "Missing 'query' parameter" };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { error: `'query' exceeds maximum length of ${MAX_QUERY_LENGTH} characters` };
  }
  return { query: query.trim() };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return errorResponse("Method not allowed. Use POST /api/search or /api/chat", 405);
    }

    const mcp = isAuthenticatedMcp(request, env);
    const origin = request.headers.get("Origin");

    // Anonymous (non-MCP) callers must present the expected browser Origin.
    // MCP traffic doesn't send an Origin header at all (it's not a browser
    // request), so it's exempt from this check and relies on the API key
    // instead.
    if (!mcp && origin && origin !== ALLOWED_ORIGIN) {
      return errorResponse("Origin not allowed", 403);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return errorResponse("Invalid JSON body", 400);
    }

    if (url.pathname === "/api/search") {
      return this.handleSearch(body, env, request, mcp);
    }

    if (url.pathname === "/api/chat") {
      return this.handleChat(body, env, request, mcp);
    }

    return errorResponse("Not found", 404);
  },

  async handleSearch(body, env, request, mcp) {
    const { query, error } = validateQuery(body);
    if (error) {
      return errorResponse(error, 400);
    }

    const clientId = getClientId(request);

    // Browser callers must pass a Turnstile challenge; MCP callers are
    // exempt (they authenticate via the shared key instead, and can't run
    // a browser challenge from a stdio process).
    if (!mcp) {
      const turnstileOk = await verifyTurnstile(body.turnstileToken, clientId, env);
      if (!turnstileOk) {
        return errorResponse("Bot verification failed. Please reload the page and try again.", 403);
      }
    }

    const rl = await checkRateLimit(env, clientId, "search", mcp);
    if (!rl.ok) {
      return errorResponse(rl.reason, 429);
    }

    try {
      const embeddingResponse = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [query],
      });
      const queryVector = embeddingResponse.data[0];

      const vectorizeResponse = await env.VECTORIZE_INDEX.query(queryVector, {
        topK: 5,
        returnValues: true,
        returnMetadata: true,
      });

      const results = vectorizeResponse.matches.map((match) => ({
        score: match.score,
        id: match.id,
        text: match.metadata.text,
        source: match.metadata.source,
      }));

      return jsonResponse({ results });
    } catch (e) {
      console.error("handleSearch failed:", e);
      return errorResponse("Search temporarily unavailable. Please try again.", 502);
    }
  },

  async handleChat(body, env, request, mcp) {
    const { query, error } = validateQuery(body);
    if (error) {
      return errorResponse(error, 400);
    }

    const clientId = getClientId(request);

    if (!mcp) {
      const turnstileOk = await verifyTurnstile(body.turnstileToken, clientId, env);
      if (!turnstileOk) {
        return errorResponse("Bot verification failed. Please reload the page and try again.", 403);
      }
    }

    const rl = await checkRateLimit(env, clientId, "chat", mcp);
    if (!rl.ok) {
      return errorResponse(rl.reason, 429);
    }

    try {
      const embeddingResponse = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [query],
      });
      const queryVector = embeddingResponse.data[0];

      const vectorizeResponse = await env.VECTORIZE_INDEX.query(queryVector, {
        topK: 3,
        returnMetadata: true,
      });

      let contextStr = "";
      for (const match of vectorizeResponse.matches) {
        contextStr += `Source: ${match.metadata.source}\nText: ${match.metadata.text}\n\n`;
      }

      const systemPrompt = `You are a helpful expert on Linux kernel internals.
Answer the user's question using ONLY the provided documentation context below.
If the answer is not in the context, say you do not know.

Context:
${contextStr}
`;

      const chatResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
      });

      return jsonResponse({ answer: chatResponse.response });
    } catch (e) {
      console.error("handleChat failed:", e);
      return errorResponse("Chat temporarily unavailable. Please try again.", 502);
    }
  },
};
