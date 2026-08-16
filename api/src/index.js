export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed. Use POST /api/search or /api/chat", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (url.pathname === "/api/search") {
      return this.handleSearch(body, env);
    }

    if (url.pathname === "/api/chat") {
      return this.handleChat(body, env);
    }

    return new Response("Not found", { status: 404 });
  },

  async handleSearch(body, env) {
    const { query } = body;
    if (!query) {
      return new Response("Missing 'query' parameter", { status: 400 });
    }

    // 1. Generate embedding for the query using BAAI model
    const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [query]
    });
    
    const queryVector = embeddingResponse.data[0];

    // 2. Query the Vectorize index
    const vectorizeResponse = await env.VECTORIZE_INDEX.query(queryVector, {
      topK: 5,
      returnValues: true,
      returnMetadata: true
    });

    // 3. Format the results
    const results = vectorizeResponse.matches.map(match => ({
      score: match.score,
      id: match.id,
      text: match.metadata.text,
      source: match.metadata.source
    }));

    return new Response(JSON.stringify({ results }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  },

  async handleChat(body, env) {
    const { query } = body;
    if (!query) {
      return new Response("Missing 'query' parameter", { status: 400 });
    }

    // 1. First, search the vector DB for context
    const embeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [query]
    });
    
    const queryVector = embeddingResponse.data[0];
    const vectorizeResponse = await env.VECTORIZE_INDEX.query(queryVector, {
      topK: 3,
      returnMetadata: true
    });

    // 2. Construct the context prompt
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

    // 3. Query Llama 3 for the final answer
    const chatResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query }
      ]
    });

    return new Response(JSON.stringify({ answer: chatResponse.response }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};
