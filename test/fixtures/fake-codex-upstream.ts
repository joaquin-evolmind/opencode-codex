// Fake ChatGPT Codex upstream (HTTP + WebSocket) for the opt-in end-to-end test.
// Logs which credential each handshake/request carried. Tokens are fake.
import { appendFileSync } from 'node:fs';
const log = (o: Record<string, unknown>) => appendFileSync(process.env.SPIKE_LOG!, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const events = () => {
  const resp = { id: 'resp_1', object: 'response', created_at: 1, status: 'in_progress', model: 'gpt-5.5', output: [] as unknown[] };
  const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
  return [
    { type: 'response.created', response: resp },
    { type: 'response.output_item.added', output_index: 0, item: { ...msg, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item: msg },
    { type: 'response.completed', response: { ...resp, status: 'completed', output: [msg], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
};
const quota = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 120 } });
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.SPIKE_UPSTREAM_PORT),
  fetch(req, server) {
    const auth = req.headers.get('authorization') ?? undefined;
    const account = req.headers.get('chatgpt-account-id') ?? undefined;
    const session = req.headers.get('session-id') ?? undefined;
    const url = new URL(req.url);
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      log({ kind: 'ws.handshake', path: url.pathname, authorization: auth, account, session });
      if (auth?.includes('limited')) {
        log({ kind: 'ws.rejected', status: 429, authorization: auth, session });
        return new Response(quota, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } });
      }
      if (server.upgrade(req, { data: { auth, account, session } })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    log({ kind: 'http', method: req.method, path: url.pathname, authorization: auth, account, session });
    if (auth?.includes('limited')) {
      return new Response(quota, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } });
    }
    const body = events().map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  },
  websocket: {
    message(ws, raw) {
      const data = ws.data as { auth?: string; account?: string; session?: string };
      let frame: { type?: string } = {};
      try { frame = JSON.parse(String(raw)); } catch {}
      log({ kind: 'ws.frame', type: frame.type, authorization: data.auth, account: data.account, session: data.session });
      if (frame.type !== 'response.create') return;
      if (data.auth?.includes('wsquota')) {
        // Quota signalled inside the socket, the way a Responses stream reports errors.
        ws.send(JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'The usage limit has been reached' } }));
        return;
      }
      const delay = data.auth?.includes('slow') ? 1500 : 0;
      setTimeout(() => { for (const e of events()) ws.send(JSON.stringify(e)); }, delay);
    },
    open(ws) { const d = ws.data as { auth?: string; session?: string }; log({ kind: 'ws.open', authorization: d.auth, session: d.session }); },
    close(ws, code) { const d = ws.data as { auth?: string; session?: string }; log({ kind: 'ws.close', code, authorization: d.auth, session: d.session }); },
  },
});
