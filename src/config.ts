/** OpenCode's provider and integration for OpenAI / ChatGPT (Codex). */
export const PROVIDER_ID = 'openai';
export const INTEGRATION_ID = 'openai';

/** OAuth methods of OpenCode's native ChatGPT integration (Codex subscription). */
export const CHATGPT_METHOD_IDS: ReadonlySet<string> = new Set([
  'chatgpt-browser',
  'chatgpt-headless',
]);

export const CODEX_USAGE_ENDPOINT =
  'https://chatgpt.com/backend-api/wham/usage';
