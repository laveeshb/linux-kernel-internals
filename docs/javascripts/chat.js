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

    // Replace this with the actual deployed Cloudflare Worker URL
    const API_URL = "https://linux-kernel-ai-api.YOUR-USERNAME.workers.dev/api/chat";

    header.addEventListener('click', () => {
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'flex' : 'none';
        toggleBtn.innerText = isHidden ? '-' : '_';
    });

    async function sendMessage() {
        const text = input.value.trim();
        if (!text) return;

        messages.insertAdjacentHTML('beforeend', `<div class="user-msg">${text}</div>`);
        input.value = '';
        messages.scrollTop = messages.scrollHeight;

        const typingIndicator = document.createElement('div');
        typingIndicator.className = 'ai-msg';
        typingIndicator.innerText = 'Thinking...';
        messages.appendChild(typingIndicator);
        messages.scrollTop = messages.scrollHeight;

        try {
            const res = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: text })
            });
            const data = await res.json();
            
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
