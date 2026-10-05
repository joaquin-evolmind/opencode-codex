// Test-only OpenCode 2 plugin: send OpenAI traffic to the local fake upstream.
export default {
  id: 'test.redirect-openai',
  async setup(ctx) {
    const upstream = process.env.FAKE_CODEX_UPSTREAM;
    await ctx.session.hook('model.request', (request) => { request.baseURL = upstream; }, { providerID: 'openai' });
  },
};
