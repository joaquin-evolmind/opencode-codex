/** @jsxImportSource @opentui/solid */
import { unwatchFile, watchFile } from 'node:fs';
import type { Plugin } from '@opencode/plugin/tui';
import * as priority from '../accounts/priority.js';
import * as usageFile from '../accounts/usage-file.js';
import { AccountsView, type AccountsViewDeps } from './accounts-view.js';
import { showAccounts } from './dialog.js';
import { PromptStatus } from './prompt.js';
import { Sidebar } from './sidebar.js';

const FILE_POLL_MS = 2_000;
const REFRESH_MS = 60_000;

export const ACCOUNTS_COMMAND = {
  id: 'codex.accounts',
  title: 'Switch Codex account',
  description: 'Choose the active ChatGPT account and its fallback priority',
  group: 'Codex',
  slash: 'accounts',
} as const;

export function viewDeps(context: Plugin.Context): AccountsViewDeps {
  return {
    list: () => context.client.credential.list(),
    activate: (credentialID) => context.client.credential.activate({ credentialID }),
    order: (ids) => priority.order(ids),
    move: (ids, id, direction) => priority.move(ids, id, direction),
    usage: () => usageFile.read(),
  };
}

const plugin: Plugin.Definition = {
  id: 'opencode-codex',
  setup(context) {
    const view = new AccountsView(viewDeps(context));
    const refresh = (): void => void view.refresh().catch(() => undefined);

    const disposers: Array<() => void> = [
      context.ui.slot({
        append: 'sidebar.content',
        render: () => <Sidebar context={context} view={view} />,
      }),
      context.ui.slot({
        append: 'prompt.footer.status',
        render: () => <PromptStatus context={context} view={view} />,
      }),
      // Keymap layers need a component owner, so register the command from an app slot.
      context.ui.slot({
        append: 'app',
        render: () => {
          context.keymap.layer(() => ({
            mode: 'global',
            commands: [
              {
                id: ACCOUNTS_COMMAND.id,
                title: ACCOUNTS_COMMAND.title,
                description: ACCOUNTS_COMMAND.description,
                group: ACCOUNTS_COMMAND.group,
                palette: true,
                slash: { name: ACCOUNTS_COMMAND.slash },
                run: () => showAccounts(context, view),
              },
            ],
          }));
          return null;
        },
      }),
      context.data.on('credential.switched', refresh),
      context.data.on('credential.updated', refresh),
    ];

    // Priority (written by any TUI) and quota (written by the server) are shared files.
    const files = [priority.file(), usageFile.file()];
    const onFileChange = (): void => refresh();
    for (const file of files) watchFile(file, { interval: FILE_POLL_MS }, onFileChange).unref();
    const interval = setInterval(refresh, REFRESH_MS);
    interval.unref?.();
    refresh();

    return () => {
      clearInterval(interval);
      for (const file of files) unwatchFile(file, onFileChange);
      for (const dispose of disposers) dispose();
    };
  },
};

export default plugin;
