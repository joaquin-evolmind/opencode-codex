import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-codex-test-'));
process.env.XDG_DATA_HOME = dataHome;
process.env.OPENCODE_CODEX_TRACE = '0';
const authPath = path.join(dataHome, 'opencode', 'auth.json');
await fs.mkdir(path.dirname(authPath), { recursive: true });

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.`;
}

function entry({ subject, accountId, email, access = jwt({ sub: subject, chatgpt_account_id: accountId, email }) }) {
  return {
    type: 'oauth',
    refresh: `refresh-${subject ?? accountId}`,
    access,
    expires: Date.now() + 3_600_000,
    accountId,
  };
}

const plusLegacy = entry({
  accountId: 'plus-account',
  email: 'plus@example.com',
  access: 'opaque-plus-token',
});
const ambiguousTeamA = entry({
  accountId: 'legacy-team-workspace',
  access: 'opaque-team-a',
});
const ambiguousTeamB = entry({
  accountId: 'legacy-team-workspace',
  access: 'opaque-team-b',
});
await fs.writeFile(
  authPath,
  JSON.stringify({
    'openai/plus@example.com': plusLegacy,
    'openai/legacy-team-a': ambiguousTeamA,
    'openai/legacy-team-b': ambiguousTeamB,
    openai: ambiguousTeamB,
  }),
);

const accounts = await import('../dist/accounts/index.js');
const { create: createCodexFetch } = await import('../dist/codex/fetch.js');
const selection = await import('../dist/accounts/selection.js');
const token = await import('../dist/codex/token.js');
const usage = await import('../dist/codex/usage.js');
const { identify, localId } = await import('../dist/oauth/jwt.js');
const { accountFromTokens } = await import('../dist/oauth/index.js');

function teamAccount(subject, accountId = 'team-workspace', access) {
  return {
    id: localId(subject, accountId),
    subject,
    accountId,
    email: `${subject}@example.com`,
    refresh: `refresh-${subject}`,
    access: access ?? `access-${subject}-${accountId}`,
    expires: Date.now() + 3_600_000,
    addedAt: Date.now(),
  };
}

test('uses OAuth subject and workspace as local membership identity', () => {
  const identity = identify({
    id_token: jwt({
      sub: 'user-a',
      chatgpt_account_id: 'team-workspace',
      email: 'user-a@example.com',
    }),
    access_token: 'opaque',
    refresh_token: 'refresh',
  });
  assert.deepEqual(identity, {
    subject: 'user-a',
    accountId: 'team-workspace',
    email: 'user-a@example.com',
  });
  assert.equal(
    localId(identity.subject, identity.accountId),
    'oauth-v2:user-a:team-workspace',
  );
  assert.equal(localId(identity.subject), 'oauth-sub-v1:user-a');
});

test('resolves canonical active to the matching opaque legacy credential', async () => {
  const store = await accounts.load();
  assert.equal(accounts.active(store)?.access, 'opaque-team-b');
  assert.equal(
    store.accounts.filter(
      (account) => account.accountId === 'legacy-team-workspace',
    ).length,
    2,
  );
  assert.equal(
    store.accounts.find((account) => account.id === 'plus-account')?.email,
    'plus@example.com',
  );
});

test('uses persisted OAuth metadata for display without exposing local IDs', async () => {
  const oauthAccount = accountFromTokens({
    id_token: jwt({
      sub: 'display-user',
      chatgpt_account_id: 'display-workspace',
      email: 'display@example.com',
    }),
    access_token: 'opaque-display-token',
    refresh_token: 'refresh-display',
  });
  assert.equal(accounts.displayName(oauthAccount), 'display@example.com');
  assert.equal(
    accounts.displayName({ ...oauthAccount, email: undefined }),
    'Codex account …orkspace',
  );
  assert.equal(
    accounts.displayName({ ...oauthAccount, email: undefined, accountId: undefined }),
    'Codex account',
  );
});

test('keeps two Team subjects and a legacy Plus account through reload and selection', async () => {
  await accounts.save(teamAccount('user-a'), { activate: true });
  await accounts.save(teamAccount('user-b'));

  let store = await accounts.reload();
  assert.deepEqual(
    store.accounts
      .filter((account) => account.accountId !== 'legacy-team-workspace')
      .map((account) => account.id)
      .sort(),
    [
      'oauth-v2:user-a:team-workspace',
      'oauth-v2:user-b:team-workspace',
      'plus-account',
    ],
  );
  assert.equal(
    store.accounts.filter(
      (account) => account.accountId === 'legacy-team-workspace',
    ).length,
    2,
  );
  assert.equal(store.active, 'oauth-v2:user-a:team-workspace');
  assert.equal(accounts.active(store)?.subject, 'user-a');

  await accounts.activate('oauth-v2:user-b:team-workspace');
  store = await accounts.reload();
  assert.equal(store.active, 'oauth-v2:user-b:team-workspace');
  assert.equal(accounts.active(store)?.subject, 'user-b');
  assert.deepEqual(
    store.accounts
      .filter((account) => account.accountId === 'team-workspace')
      .map(accounts.displayName)
      .sort(),
    ['user-a@example.com', 'user-b@example.com'],
  );
  assert.equal(
    store.accounts.filter(
      (account) => account.accountId === 'legacy-team-workspace',
    ).length,
    2,
  );
});

test('keeps the same subject in two workspaces and updates only one membership', async () => {
  await accounts.save(teamAccount('user-a', 'other-workspace'));
  await accounts.save(
    teamAccount('user-a', 'team-workspace', 'replacement-access'),
  );
  const memberships = accounts
    .list()
    .filter((account) => account.subject === 'user-a');
  assert.equal(memberships.length, 2);
  assert.equal(
    accounts.find('oauth-v2:user-a:team-workspace')?.access,
    'replacement-access',
  );
  assert.equal(
    accounts.find('oauth-v2:user-a:other-workspace')?.access,
    'access-user-a-other-workspace',
  );
});

test('same-subject login updates without merging a different Team user', async () => {
  await accounts.save(
    {
      ...teamAccount('user-a', 'team-workspace', 'newest-access'),
      email: 'renamed@example.com',
    },
    { activate: true },
  );
  const store = accounts.snapshot();
  assert.equal(
    store.accounts.filter(
      (account) =>
        account.subject === 'user-a' &&
        account.accountId === 'team-workspace',
    ).length,
    1,
  );
  assert.equal(
    accounts.find('oauth-v2:user-a:team-workspace')?.access,
    'newest-access',
  );
  assert.equal(
    accounts.find('oauth-v2:user-b:team-workspace')?.access,
    'access-user-b-team-workspace',
  );
  assert.equal(
    accounts.find('oauth-v2:user-a:team-workspace')?.email,
    'renamed@example.com',
  );
  assert.equal(
    accounts.find('oauth-v2:user-b:team-workspace')?.email,
    'user-b@example.com',
  );
  assert.ok(accounts.find('plus-account'));
});

test('request, usage, refresh, and rate-limit state stay isolated by local identity', async () => {
  await accounts.activate('oauth-v2:user-a:team-workspace');
  await selection.select('oauth-v2:user-a:team-workspace');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, headers, body: init.body });
    if (url.includes('/oauth/token')) {
      const refresh = new URLSearchParams(String(init.body)).get('refresh_token');
      return Response.json({
        access_token: jwt({ sub: 'user-a', chatgpt_account_id: 'team-workspace' }),
        refresh_token: `${refresh}-next`,
        expires_in: 3600,
      });
    }
    if (url.includes('/wham/usage')) {
      return Response.json({
        plan_type: 'team',
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
            reset_after_seconds: 60,
          },
        },
      });
    }
    return new Response('{}', { status: 200 });
  };

  try {
    await createCodexFetch()('https://example.test/v1/responses', { method: 'POST' });
    assert.equal(calls.at(-1).headers.get('ChatGPT-Account-Id'), 'team-workspace');

    const userB = accounts.find('oauth-v2:user-b:team-workspace');
    await usage.fetch(userB);
    assert.equal(calls.at(-1).headers.get('ChatGPT-Account-Id'), 'team-workspace');
    assert.equal(
      accounts.find('oauth-v2:user-b:team-workspace')?.usage?.planType,
      'team',
    );
    assert.equal(
      accounts.find('oauth-v2:user-a:team-workspace')?.usage,
      undefined,
    );

    const userA = accounts.find('oauth-v2:user-a:team-workspace');
    await token.ensure({ ...userA, expires: 0 });
    let reloaded = await accounts.reload();
    assert.match(
      accounts.find('oauth-v2:user-a:team-workspace', reloaded)?.refresh ?? '',
      /-next$/,
    );
    assert.equal(
      accounts.find('oauth-v2:user-b:team-workspace', reloaded)?.refresh,
      'refresh-user-b',
    );

    await accounts.rateLimit(
      'oauth-v2:user-a:team-workspace',
      Date.now() + 60_000,
    );
    assert.ok(
      accounts.find('oauth-v2:user-a:team-workspace')?.rateLimitUntilMs,
    );
    assert.equal(
      accounts.find('oauth-v2:user-b:team-workspace')?.rateLimitUntilMs,
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('accepts no id token and opaque access while retaining identity and refresh token', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      access_token: 'opaque-refreshed-token',
      expires_in: 3600,
    });
  try {
    const refreshed = await token.ensure({ ...account, expires: 0 });
    assert.equal(refreshed.id, account.id);
    assert.equal(refreshed.subject, account.subject);
    assert.equal(refreshed.accountId, account.accountId);
    assert.equal(refreshed.refresh, account.refresh);

    const reloaded = await accounts.reload();
    assert.equal(accounts.find(account.id, reloaded)?.access, 'opaque-refreshed-token');
    assert.equal(accounts.find(account.id, reloaded)?.refresh, account.refresh);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('accepts parseable tokens with absent identity claims', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id_token: jwt({ email: 'user-a@example.com' }),
      access_token: jwt({ exp: 1 }),
      expires_in: 3600,
    });
  try {
    const refreshed = await token.ensure({ ...account, expires: 0 });
    assert.equal(refreshed.id, account.id);
    assert.equal(refreshed.subject, account.subject);
    assert.equal(refreshed.accountId, account.accountId);
    assert.equal(refreshed.email, 'user-a@example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshes email metadata only for the matching membership', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id_token: jwt({
        sub: account.subject,
        chatgpt_account_id: account.accountId,
        email: 'refreshed-user-a@example.com',
      }),
      access_token: 'opaque-email-refresh',
    });
  try {
    const refreshed = await token.ensure({ ...account, expires: 0 });
    assert.equal(refreshed.id, 'oauth-v2:user-a:team-workspace');
    assert.equal(refreshed.email, 'refreshed-user-a@example.com');
    const reloaded = await accounts.reload();
    assert.equal(accounts.find(account.id, reloaded)?.email, refreshed.email);
    assert.equal(
      accounts.find('oauth-v2:user-b:team-workspace', reloaded)?.email,
      'user-b@example.com',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates refresh identity present only in the id token', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id_token: jwt({ sub: account.subject, chatgpt_account_id: account.accountId }),
      access_token: 'opaque-access-token',
    });
  try {
    await token.ensure({ ...account, expires: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates refresh identity present only in the access token', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      access_token: jwt({ sub: account.subject, chatgpt_account_id: account.accountId }),
    });
  try {
    await token.ensure({ ...account, expires: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('persists a replacement refresh token when returned', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      access_token: jwt({ sub: account.subject, chatgpt_account_id: account.accountId }),
      refresh_token: 'replacement-refresh-token',
    });
  try {
    const refreshed = await token.ensure({ ...account, expires: 0 });
    assert.equal(refreshed.refresh, 'replacement-refresh-token');
    const reloaded = await accounts.reload();
    assert.equal(accounts.find(account.id, reloaded)?.refresh, 'replacement-refresh-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects contradictory refresh identity without changing persisted credentials', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const before = { access: account.access, refresh: account.refresh };
  const originalFetch = globalThis.fetch;
  let response = {
    access_token: jwt({
      sub: 'different-user',
      chatgpt_account_id: 'team-workspace',
    }),
    refresh_token: 'mismatched-refresh',
    expires_in: 3600,
  };
  globalThis.fetch = async () => Response.json(response);
  try {
    await assert.rejects(
      token.ensure({ ...account, expires: 0 }),
      /OAuth subject does not match/,
    );
    response = {
      access_token: jwt({
        sub: 'user-a',
        chatgpt_account_id: 'different-workspace',
      }),
      refresh_token: 'wrong-workspace-refresh',
      expires_in: 3600,
    };
    await assert.rejects(
      token.ensure({ ...account, expires: 0 }),
      /workspace does not match/,
    );
    response = {
      id_token: jwt({
        sub: 'different-user',
        chatgpt_account_id: 'team-workspace',
      }),
      access_token: 'opaque-id-subject-test',
      refresh_token: 'id-token-mismatched-refresh',
      expires_in: 3600,
    };
    await assert.rejects(
      token.ensure({ ...account, expires: 0 }),
      /OAuth subject does not match/,
    );
    response = {
      id_token: jwt({
        sub: 'user-a',
        chatgpt_account_id: 'different-workspace',
      }),
      access_token: 'opaque-id-workspace-test',
      refresh_token: 'id-token-wrong-workspace-refresh',
      expires_in: 3600,
    };
    await assert.rejects(
      token.ensure({ ...account, expires: 0 }),
      /workspace does not match/,
    );
    const reloaded = await accounts.reload();
    assert.deepEqual(
      {
        access: accounts.find(account.id, reloaded)?.access,
        refresh: accounts.find(account.id, reloaded)?.refresh,
      },
      before,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects cross-token identity contradictions without stored identity fields', async () => {
  const account = accounts.find('oauth-v2:user-a:team-workspace');
  const before = { access: account.access, refresh: account.refresh };
  const originalFetch = globalThis.fetch;
  let response = {
    id_token: jwt({ sub: 'id-user', chatgpt_account_id: 'team-workspace' }),
    access_token: jwt({
      sub: 'access-user',
      chatgpt_account_id: 'team-workspace',
    }),
    refresh_token: 'cross-subject-refresh',
  };
  globalThis.fetch = async () => Response.json(response);
  const accountWithoutIdentity = {
    ...account,
    subject: undefined,
    accountId: undefined,
    expires: 0,
  };
  try {
    await assert.rejects(
      token.ensure(accountWithoutIdentity),
      /OAuth subjects contradict/,
    );
    response = {
      id_token: jwt({ sub: 'user-a', chatgpt_account_id: 'id-workspace' }),
      access_token: jwt({
        sub: 'user-a',
        chatgpt_account_id: 'access-workspace',
      }),
      refresh_token: 'cross-workspace-refresh',
    };
    await assert.rejects(
      token.ensure(accountWithoutIdentity),
      /workspace claims contradict/,
    );
    const reloaded = await accounts.reload();
    assert.deepEqual(
      {
        access: accounts.find(account.id, reloaded)?.access,
        refresh: accounts.find(account.id, reloaded)?.refresh,
      },
      before,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps subject-only identity stable without synthesizing an account header', async () => {
  const subjectOnly = accountFromTokens({
    id_token: jwt({ sub: 'subject-only', email: 'subject-only@example.com' }),
    access_token: jwt({ sub: 'subject-only' }),
    refresh_token: 'refresh-subject-only',
    expires_in: 3600,
  });
  assert.equal(subjectOnly.id, 'oauth-sub-v1:subject-only');
  assert.equal(subjectOnly.accountId, undefined);

  await accounts.save(subjectOnly, { activate: true });
  const reloaded = await accounts.reload();
  const persisted = accounts.find('oauth-sub-v1:subject-only', reloaded);
  assert.equal(persisted?.id, subjectOnly.id);
  assert.equal(persisted?.accountId, undefined);

  const auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(auth.openai.localId, subjectOnly.id);
  assert.equal('accountId' in auth.openai, false);

  await selection.select(subjectOnly.id);
  const originalFetch = globalThis.fetch;
  let upstreamHeaders;
  globalThis.fetch = async (_input, init = {}) => {
    upstreamHeaders = new Headers(init.headers);
    return new Response('{}', { status: 200 });
  };
  try {
    await createCodexFetch()('https://example.test/v1/responses', {
      method: 'POST',
    });
    assert.equal(upstreamHeaders.get('ChatGPT-Account-Id'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps migrated legacy IDs and canonical credential selection stable', async () => {
  const first = await accounts.reload();
  const legacy = first.accounts
    .filter((account) => account.accountId === 'legacy-team-workspace')
    .map((account) => ({ id: account.id, access: account.access }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const second = await accounts.reload();
  assert.deepEqual(
    second.accounts
      .filter((account) => account.accountId === 'legacy-team-workspace')
      .map((account) => ({ id: account.id, access: account.access }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    legacy,
  );
  assert.equal(
    second.accounts.find((account) => account.id === 'plus-account')?.email,
    'plus@example.com',
  );
});

test.after(async () => {
  await accounts.reload();
  await fs.rm(dataHome, { recursive: true, force: true });
});
