document.addEventListener("DOMContentLoaded", () => {
    // Inject the Chat UI HTML into the body
    const chatHTML = `
        <div id="ai-chat-widget">
            <div id="ai-chat-header">
                <span>🤖 Linux Kernel AI</span>
                <button id="ai-chat-toggle" style="background:none;border:none;color:white;cursor:pointer;">_</button>
            </div>
            <div id="ai-chat-body" style="display:none;">
                <div id="ai-chat-messages">
                    <div class="ai-msg">Ask me anything about Linux kernel internals!</div>
                </div>
                <div id="ai-chat-input-area">
                    <input type="text" id="ai-chat-input" placeholder="How does the clocksource watchdog work?" />
                    <button id="ai-chat-send">Send</button>
                </div>
            </div>
        </div>
        <style>
            #ai-chat-widget {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 350px;
                background: white;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                z-index: 9999;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            #ai-chat-header {
                background: #007bff;
                color: white;
                padding: 10px 15px;
                font-weight: bold;
                display: flex;
                justify-content: space-between;
                cursor: pointer;
            }
            #ai-chat-body {
                display: flex;
                flex-direction: column;
                height: 400px;
            }
            #ai-chat-messages {
                flex-grow: 1;
                padding: 15px;
                overflow-y: auto;
                background: #f8f9fa;
                font-size: 14px;
            }
            .ai-msg { background: #e9ecef; padding: 10px; border-radius: 8px; margin-bottom: 10px; }
            .user-msg { background: #007bff; color: white; padding: 10px; border-radius: 8px; margin-bottom: 10px; text-align: right; }
            #ai-chat-input-area {
                display: flex;
                padding: 10px;
                border-top: 1px solid #ddd;
            }
            #ai-chat-input {
                flex-grow: 1;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
            }
            #ai-chat-send {
                margin-left: 10px;
                padding: 8px 12px;
                background: #007bff;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
            }
        </style>
    `;

    document.body.insertAdjacentHTML('beforeend', chatHTML);

    const header = document.getElementById('ai-chat-header');
    const body = document.getElementById('ai-chat-body');
    const toggleBtn = document.getElementById('ai-chat-toggle');
    const input = document.getElementById('ai-chat-input');
    const sendBtn = document.getElementById('ai-chat-send');
    const messages = document.getElementById('ai-chat-messages');

    // TODO: point back at https://api.kernel-internals.org/api/chat once the
    // custom domain route is restored (see api/wrangler.toml). Using the
    // workers.dev URL directly for now, during local testing.
    const API_URL = "https://linux-kernel-ai-api.laveeshbansal.workers.dev/api/chat";

    // Public Turnstile site key. Obtain from the Cloudflare dashboard
    // (Turnstile product) once you've signed up, then replace this
    // placeholder. Until it's replaced, initTurnstile() below no-ops and
    // requests are sent without a token — the Worker fails open on that
    // (see TURNSTILE_SECRET_KEY in api/src/index.js) so the widget keeps
    // working during initial setup, just without bot protection yet.
    const TURNSTILE_SITE_KEY = "REPLACE_WITH_TURNSTILE_SITE_KEY";

    let turnstileWidgetId = null;
    let resolveTurnstileToken = null;

    function waitForTurnstile(attemptsLeft) {
        if (typeof turnstile !== "undefined") {
            initTurnstile();
            return;
        }
        if (attemptsLeft > 0) {
            setTimeout(() => waitForTurnstile(attemptsLeft - 1), 100);
        }
        // else: give up silently; getTurnstileToken() resolves null and
        // the server-side fail-open/fail-closed logic takes over.
    }

    function initTurnstile() {
        if (!TURNSTILE_SITE_KEY || TURNSTILE_SITE_KEY.indexOf("REPLACE_") === 0) {
            return;
        }
        const container = document.createElement('div');
        container.id = 'ai-chat-turnstile';
        container.style.display = 'none';
        document.body.appendChild(container);

        turnstileWidgetId = turnstile.render('#ai-chat-turnstile', {
            sitekey: TURNSTILE_SITE_KEY,
            size: 'invisible',
            callback: (token) => {
                if (resolveTurnstileToken) resolveTurnstileToken(token);
            },
            'error-callback': () => {
                if (resolveTurnstileToken) resolveTurnstileToken(null);
            },
        });
    }

    // Kick off Turnstile loading; harmless no-op if not yet configured.
    waitForTurnstile(50);

    function getTurnstileToken() {
        if (turnstileWidgetId === null) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            let settled = false;
            const finish = (token) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                resolve(token);
            };
            const timeoutId = setTimeout(() => finish(null), 10000);
            resolveTurnstileToken = finish;
            turnstile.execute(turnstileWidgetId);
        });
    }

    header.addEventListener('click', () => {
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'flex' : 'none';
        toggleBtn.innerText = isHidden ? '-' : '_';
    });

    const MAX_QUERY_LENGTH = 500;

    async function sendMessage() {
        const text = input.value.trim();
        if (!text) return;
        if (text.length > MAX_QUERY_LENGTH) {
            const warn = document.createElement('div');
            warn.className = 'ai-msg';
            warn.innerText = `Please keep questions under ${MAX_QUERY_LENGTH} characters.`;
            messages.appendChild(warn);
            messages.scrollTop = messages.scrollHeight;
            return;
        }

        // Build the user message via textContent, never innerHTML/insertAdjacentHTML,
        // so arbitrary user input can never be interpreted as markup.
        const userMsg = document.createElement('div');
        userMsg.className = 'user-msg';
        userMsg.textContent = text;
        messages.appendChild(userMsg);
        input.value = '';
        messages.scrollTop = messages.scrollHeight;

        const typingIndicator = document.createElement('div');
        typingIndicator.className = 'ai-msg';
        typingIndicator.innerText = 'Thinking...';
        messages.appendChild(typingIndicator);
        messages.scrollTop = messages.scrollHeight;

        try {
            const turnstileToken = await getTurnstileToken();
            const res = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: text, turnstileToken })
            });
            if (!res.ok) {
                typingIndicator.innerText = res.status === 429
                    ? "You're asking too fast — please wait a moment and try again."
                    : res.status === 403
                    ? "Verification failed — please reload the page and try again."
                    : "The AI service returned an error. Please try again.";
                messages.scrollTop = messages.scrollHeight;
                return;
            }
            const data = await res.json();

            // .innerText, not innerHTML: the model's answer is untrusted text, not markup.
            typingIndicator.innerText = data.answer || "Sorry, I couldn't process that.";
        } catch (e) {
            typingIndicator.innerText = "Error connecting to AI service.";
        }
        messages.scrollTop = messages.scrollHeight;
    }

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
});
