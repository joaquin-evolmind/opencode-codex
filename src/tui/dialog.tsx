/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui';
import type { KeyEvent, SelectRenderable } from '@opentui/core';
import type { MoveDirection } from '../accounts/order.js';
import { accountRows, type AccountsView } from './accounts-view.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function options(view: AccountsView) {
  return accountRows(view.snapshot()).map((row) => ({
    name: row.title,
    description: row.description ?? '',
    value: row.id,
  }));
}

/**
 * Enter activates the highlighted credential (OpenCode's manual selection).
 * Ctrl+Up/Down only changes the fallback priority. Neither does the other.
 */
export function AccountsDialog(props: { context: Plugin.Context; view: AccountsView }) {
  const { context, view } = props;
  let select: SelectRenderable | undefined;
  let busy = false;
  let highlighted = view.active()?.id ?? view.snapshot()[0]?.id;

  const show = (): void => {
    if (!select) return;
    select.options = options(view);
    const index = view.snapshot().findIndex((account) => account.id === highlighted);
    if (index >= 0) select.setSelectedIndex(index);
  };

  const move = async (direction: MoveDirection): Promise<void> => {
    if (!highlighted || busy) return;
    busy = true;
    try {
      await view.move(highlighted, direction);
    } catch (error) {
      context.ui.toast.show({
        variant: 'error',
        title: 'Could not update account priority',
        message: errorMessage(error),
      });
    } finally {
      busy = false;
      show();
    }
  };

  const activate = async (id: string): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await view.activate(id);
    } catch (error) {
      context.ui.toast.show({
        variant: 'error',
        title: 'Could not select Codex account',
        message: errorMessage(error),
      });
      return;
    } finally {
      busy = false;
    }
    context.ui.dialog.clear();
  };

  const onKeyDown = (event: KeyEvent): void => {
    if (!event.ctrl || (event.name !== 'up' && event.name !== 'down')) return;
    event.preventDefault();
    event.stopPropagation();
    void move(event.name);
  };

  const initial = options(view);
  return (
    <box flexDirection="column" gap={1} flexGrow={1} paddingLeft={2} paddingRight={2}>
      <text fg={context.theme.text.base}>Codex accounts</text>
      <text fg={context.theme.text.muted}>
        Enter makes the highlighted account active. Ctrl+↑/↓ changes fallback priority (1 is tried
        first when the active account is out of quota).
      </text>
      <select
        ref={(value: SelectRenderable) => {
          select = value;
        }}
        focused
        height={Math.max(2, initial.length * 2)}
        flexGrow={1}
        options={initial}
        selectedIndex={Math.max(
          0,
          view.snapshot().findIndex((account) => account.id === highlighted),
        )}
        onChange={(_, option) => {
          if (typeof option?.value === 'string') highlighted = option.value;
        }}
        onSelect={(_, option) => {
          if (typeof option?.value === 'string') void activate(option.value);
        }}
        onKeyDown={onKeyDown}
      />
    </box>
  );
}

export async function showAccounts(context: Plugin.Context, view: AccountsView): Promise<void> {
  try {
    await view.refresh();
  } catch (error) {
    context.ui.toast.show({ variant: 'error', title: 'Could not load Codex accounts', message: errorMessage(error) });
    return;
  }
  if (view.snapshot().length === 0) {
    await context.ui.dialog.alert({
      title: 'Codex accounts',
      message: 'No ChatGPT accounts yet. Use /connect → OpenAI → ChatGPT Pro/Plus to add one.',
    });
    return;
  }
  context.ui.dialog.show(() => <AccountsDialog context={context} view={view} />);
  context.ui.dialog.set({ size: 'large' });
}
