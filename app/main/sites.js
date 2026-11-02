// Сайты нейросетей для встроенного браузера: адрес и CSS-селекторы.
// Селекторы — списками: берётся первый подходящий. Если сайт обновил вёрстку,
// открой браузер (⚙ → «Показать браузер»), посмотри через Ctrl+Shift+I и добавь новый селектор.
// auth — как понять, что вход выполнен: кука или ключ localStorage, имя начинается с указанного.
module.exports = {
  claude: {
    name: 'Claude',
    url: 'https://claude.ai/new',
    auth: { cookie: 'sessionKey' },
    inputs: ['div[contenteditable="true"][role="textbox"]', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    sends: ['button[aria-label="Send message"]', 'button[aria-label*="Send"]', 'button[aria-label*="Отправ"]'],
    replies: ['[data-testid="assistant-message"] .standard-markdown', '.font-claude-response', '[data-testid="assistant-message"] .prose'],
    stops: ['div[data-is-streaming="true"]', 'button[aria-label="Stop response"]', 'button[aria-label*="Stop"]', 'button[aria-label*="Останов"]'],
  },
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    auth: { cookie: '__Secure-next-auth.session-token' },
    inputs: ['[data-chatgpt-composer] div[contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]', '#prompt-textarea', 'div[contenteditable="true"]'],
    sends: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]', 'button[aria-label*="Отправ"]'],
    replies: ['div[data-message-author-role="assistant"]', 'article[data-testid^="conversation-turn"] .markdown', '.markdown.prose'],
    stops: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="Останов"]'],
  },
  deepseek: {
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    auth: { storage: 'userToken' },
    inputs: ['textarea#chat-input', 'textarea'],
    sends: [],
    replies: ['div.ds-markdown', '.ds-markdown'],
    virtual: true, // старые сообщения выгружаются — новый ответ определяем по смене текста последнего блока
    stops: [],
  },
  gemini: {
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    auth: { cookie: '__Secure-1PSID' },
    inputs: ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
    sends: ['button.send-button:not(.stop)', 'button[aria-label*="Send" i]', 'button[aria-label*="Отправ" i]'],
    replies: ['model-response message-content .markdown', 'message-content .markdown', '.model-response-text'],
    stops: ['button.send-button.stop', 'button[aria-label*="Stop" i]', 'button[aria-label*="Останов" i]'],
  },
  grok: {
    name: 'Grok',
    url: 'https://grok.com/',
    auth: { cookie: 'sso' },
    inputs: ['textarea[aria-label*="Grok" i]', 'div.tiptap.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    sends: ['button[type="submit"]', 'button[aria-label="Submit"]', 'button[aria-label*="Send" i]', 'button[aria-label*="Отправ" i]'],
    replies: ['.response-content-markdown', 'div[id^="response-"] .message-bubble', '.message-bubble'],
    stops: ['button[aria-label*="Stop" i]', 'button[aria-label*="Останов" i]'],
  },
  qwen: {
    name: 'Qwen',
    url: 'https://chat.qwen.ai/',
    auth: { cookie: 'token', storage: 'token' },
    inputs: ['textarea#chat-input', '#chat-input', 'textarea.message-input-textarea', 'textarea'],
    sends: ['#send-message-button', 'button[aria-label*="Send" i]', 'button[type="submit"]'],
    replies: ['.qwen-markdown', '.response-message-content', '.chat-response-message'],
    stops: ['button[aria-label*="Stop" i]', '.stop-button', 'button[class*="stop" i]'],
  },
};
