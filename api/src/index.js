const MAX_QUERY_LENGTH = 500;

// The production docs origin, plus common local dev-server origins.
// Requests from any other Origin are rejected server-side (browsers already
// enforce this via CORS, but a non-browser client can ignore CORS entirely,
// so we also check Origin ourselves). This is a soft deterrent, not the
// primary abuse gate — a scripted client can simply omit the Origin header
// entirely to skip this check (see the `!mcp && origin &&` guard below);
// Turnstile and the rate/budget limits are what actually gate cost.
const ALLOWED_ORIGINS = [
  "https://kernel-internals.org",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

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

// --- Free-tier budget guardrails -------------------------------------
//
// Workers AI's free allocation is 10,000 "neurons"/day, SHARED across
// every model call on the account — search's embedding call, chat's
// embedding + LLM completion, AND the ingestion script's embedding calls
// when it runs. On the Workers Free plan (not Paid), exceeding this just
// fails the call with an error; it does not bill you. This budget exists
// to keep the site itself well clear of that wall, not to protect against
// a bill (there isn't one, on Free) — the failure mode we're avoiding is
// "the AI features go dark for the rest of the day" from a single burst.
//
// Rough neuron cost per call, from Cloudflare's published per-model rates
// (bge-base-en-v1.5: ~6,058 neurons/M input tokens; llama-3.1-8b-instruct-fp8-fast:
// ~4,119/M input tokens, ~34,868/M output tokens), assuming a generously
// long query/context/answer so the estimate errs high, not low:
//   search: ~1 embedding call, short query           ->  ~3 neurons
//   chat:   ~1 embedding call + 1 LLM call w/ RAG
//           context (~1,000 input tok, ~300 output)  -> ~20 neurons
const NEURON_ESTIMATE = { search: 3, chat: 20 };

// Deliberately well under the real 10,000/day ceiling: leaves headroom
// for estimation error above, and for whatever the ingestion script
// consumes on days it's re-run (it uses the same shared daily pool).
const DAILY_NEURON_BUDGET = 7000;

function corsHeadersFor(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Vary": "Origin",
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeadersFor(origin),
    },
  });
}

function errorResponse(message, status, origin) {
  return jsonResponse({ error: message }, status, origin);
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

// Best-effort fixed-window counters backed by KV. Two important caveats
// this design is built around:
//
// 1. KV writes aren't strongly consistent across edge locations, so these
//    counters deter casual/scripted/distributed abuse rather than
//    providing an exact global limit — acceptable for a soft budget gate,
//    not something to rely on for hard billing-critical accounting.
// 2. Workers KV's own FREE plan caps WRITES at 1,000/day (reads are far
//    more generous at 100,000/day). Every counter increment here is a
//    write, so the counter design itself has to stay well under that —
//    this is why there are exactly TWO KV writes per request that reaches
//    this function (one per-IP, one shared daily budget), not one per
//    logical thing we might want to track. Requests rejected earlier by
//    the Origin or Turnstile checks never reach here, so blind/scripted
//    floods don't consume any KV write quota at all.
async function readCounter(env, key) {
  if (!env.RATE_LIMIT_KV) return 0; // No KV binding (e.g. local dev) — fail open.
  return parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
}

async function incrementCounter(env, key, amount, expirationTtl) {
  if (!env.RATE_LIMIT_KV) return;
  const current = await readCounter(env, key);
  await env.RATE_LIMIT_KV.put(key, String(current + amount), { expirationTtl });
}

async function checkRateLimit(env, clientId, bucket, mcp) {
  const limitKey = mcp ? `${bucket}:mcp` : bucket;
  const perIpLimit = RATE_LIMITS[limitKey] || RATE_LIMITS[bucket];
  const neuronCost = NEURON_ESTIMATE[bucket];

  const minuteWindow = Math.floor(Date.now() / 60000);
  const dayWindow = Math.floor(Date.now() / 86400000);
  const perIpKey = `rl:${limitKey}:${clientId}:${minuteWindow}`;
  const budgetKey = `budget:neurons:${dayWindow}`;

  // Reads are cheap (100,000/day free) — check both before deciding
  // whether either write is even worth making.
  const [perIpCount, neuronsSpent] = await Promise.all([
    readCounter(env, perIpKey),
    readCounter(env, budgetKey),
  ]);

  if (neuronsSpent + neuronCost > DAILY_NEURON_BUDGET) {
    return { ok: false, reason: "Daily AI usage budget reached. Please try again tomorrow." };
  }
  if (perIpCount >= perIpLimit.max) {
    return { ok: false, reason: "Rate limit exceeded. Please slow down." };
  }

  // Only now, having decided to allow the request, spend the two writes.
  await Promise.all([
    incrementCounter(env, perIpKey, 1, Math.max(perIpLimit.windowSeconds, 60)),
    incrementCounter(env, budgetKey, neuronCost, 86400),
  ]);

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
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeadersFor(origin) });
    }

    if (request.method !== "POST") {
      return errorResponse("Method not allowed. Use POST /api/search or /api/chat", 405, origin);
    }

    const mcp = isAuthenticatedMcp(request, env);

    // Anonymous (non-MCP) callers must present an allowed Origin. MCP
    // traffic doesn't send an Origin header at all (it's not a browser
    // request), so it's exempt from this check and relies on the API key
    // instead.
    if (!mcp && origin && !ALLOWED_ORIGINS.includes(origin)) {
      return errorResponse("Origin not allowed", 403, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return errorResponse("Invalid JSON body", 400, origin);
    }

    if (url.pathname === "/api/search") {
      return this.handleSearch(body, env, request, mcp);
    }

    if (url.pathname === "/api/chat") {
      return this.handleChat(body, env, request, mcp);
    }

    return errorResponse("Not found", 404, origin);
  },

  async handleSearch(body, env, request, mcp) {
    const origin = request.headers.get("Origin");
    const { query, error } = validateQuery(body);
    if (error) {
      return errorResponse(error, 400, origin);
    }

    const clientId = getClientId(request);

    // Browser callers must pass a Turnstile challenge; MCP callers are
    // exempt (they authenticate via the shared key instead, and can't run
    // a browser challenge from a stdio process).
    if (!mcp) {
      const turnstileOk = await verifyTurnstile(body.turnstileToken, clientId, env);
      if (!turnstileOk) {
        return errorResponse("Bot verification failed. Please reload the page and try again.", 403, origin);
      }
    }

    const rl = await checkRateLimit(env, clientId, "search", mcp);
    if (!rl.ok) {
      return errorResponse(rl.reason, 429, origin);
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

      return jsonResponse({ results }, 200, origin);
    } catch (e) {
      console.error("handleSearch failed:", e);
      return errorResponse("Search temporarily unavailable. Please try again.", 502, origin);
    }
  },

  async handleChat(body, env, request, mcp) {
    const origin = request.headers.get("Origin");
    const { query, error } = validateQuery(body);
    if (error) {
      return errorResponse(error, 400, origin);
    }

    const clientId = getClientId(request);

    if (!mcp) {
      const turnstileOk = await verifyTurnstile(body.turnstileToken, clientId, env);
      if (!turnstileOk) {
        return errorResponse("Bot verification failed. Please reload the page and try again.", 403, origin);
      }
    }

    const rl = await checkRateLimit(env, clientId, "chat", mcp);
    if (!rl.ok) {
      return errorResponse(rl.reason, 429, origin);
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

      // Only feed the model matches that are actually relevant. Forcing it
      // to answer from the top-3 regardless of score leads to it treating
      // barely-related chunks (or even a bare greeting's nearest neighbor)
      // as ground truth and confidently answering off-topic.
      const RELEVANCE_THRESHOLD = 0.55;
      const relevantMatches = vectorizeResponse.matches.filter((m) => m.score >= RELEVANCE_THRESHOLD);

      let contextStr = "";
      for (const match of relevantMatches) {
        contextStr += `Source: ${match.metadata.source}\nText: ${match.metadata.text}\n\n`;
      }

      const systemPrompt = contextStr
        ? `You are the documentation assistant for kernel-internals.org, a site about Linux kernel internals.
Answer the user's question using ONLY the documentation context below — do not use outside knowledge.
If the context doesn't actually answer the question, say so plainly instead of guessing.

Context:
${contextStr}`
        : `You are the documentation assistant for kernel-internals.org, a site about Linux kernel internals.
No documentation matched this question closely enough to answer from it.
If this is a greeting or small talk, respond naturally and briefly, and mention you can
answer questions about Linux kernel internals. Otherwise, say plainly that you don't have
documentation covering this yet, and suggest the user try a more specific kernel topic.`;

      const chatResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
      });

      return jsonResponse({ answer: chatResponse.response }, 200, origin);
    } catch (e) {
      console.error("handleChat failed:", e);
      return errorResponse("Chat temporarily unavailable. Please try again.", 502, origin);
    }
  },
};
