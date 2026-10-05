/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { KeyEvent, SelectRenderable } from '@opentui/core';
import { createSignal } from 'solid-js';
import * as accounts from '../accounts/index.js';
import * as selection from '../accounts/selection.js';
import type { Store } from '../accounts/types.js';
import {
  accountRows,
  persistMove,
  type MoveDirection,
} from './account-priority.js';
import { activeNow } from './refresh.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AccountsDialog(props: {
  api: TuiPluginApi;
  store: Store;
  order: readonly string[];
}) {
  const dialog = props.api.ui.dialog;
  const initialOrder = [...props.order];
  const [confirmedOrder, setConfirmedOrder] = createSignal(initialOrder);
  const initialSelected = selection.active(props.store)?.id ?? initialOrder[0];
  const [selectedID, setSelectedID] = createSignal(initialSelected);
  const [busy, setBusy] = createSignal(false);
  let select: SelectRenderable | undefined;

  const rows = () =>
    accountRows(props.store, confirmedOrder(), accounts.displayName);
  const selectedIndex = () =>
    Math.max(
      0,
      rows().findIndex((row) => row.id === selectedID()),
    );

  const captureSelect = (value: SelectRenderable): void => {
    select = value;
  };

  const move = async (direction: MoveDirection): Promise<void> => {
    const id = selectedID();
    if (!id || busy()) return;
    const before = confirmedOrder();
    const from = before.indexOf(id);
    setBusy(true);
    try {
      const confirmed = await persistMove(
        before,
        id,
        direction,
        accounts.reorder,
      );
      setConfirmedOrder(confirmed);
      const index = confirmed.indexOf(id);
      if (index >= 0) select?.setSelectedIndex(index);
    } catch (error) {
      setConfirmedOrder(before);
      select?.setSelectedIndex(Math.max(0, from));
      props.api.ui.toast({
        variant: 'error',
        title: 'Could not update account priority',
        message: errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyEvent): void => {
    if (!event.ctrl || (event.name !== 'up' && event.name !== 'down')) return;
    event.preventDefault();
    event.stopPropagation();
    void move(event.name);
  };

  return (
    <props.api.ui.Dialog onClose={() => dialog.clear()}>
      <box flexDirection="column" gap={1} flexGrow={1}>
        <text fg={props.api.theme.current.text}>Codex accounts</text>
        <text fg={props.api.theme.current.textMuted}>
          Fallback priority (1 is tried first). Ctrl+↑/↓ moves the highlighted
          account; Enter selects it.
        </text>
        <select
          ref={captureSelect}
          focused
          height={rows().length * 2}
          flexGrow={1}
          options={rows().map((row) => ({
            name: row.title,
            description: row.description ?? '',
            value: row.id,
          }))}
          selectedIndex={selectedIndex()}
          onChange={(_, option) => {
            if (typeof option?.value === 'string') setSelectedID(option.value);
          }}
          onSelect={(_, option) => {
            if (typeof option?.value !== 'string' || busy()) return;
            selection.select(option.value);
            void activeNow();
            dialog.clear();
          }}
          onKeyDown={onKeyDown}
        />
      </box>
    </props.api.ui.Dialog>
  );
}

export function showAccounts(api: TuiPluginApi): void {
  const dialog = api.ui.dialog;
  void accounts.load().then((store) => {
    if (store.accounts.length === 0) {
      dialog.replace(() => (
        <api.ui.DialogAlert
          title="Codex accounts"
          message="No accounts yet. Use /connect → openai to add one."
          onConfirm={() => dialog.clear()}
        />
      ));
      return;
    }
    const order = accounts.order();
    dialog.setSize('large');
    dialog.replace(() => (
      <AccountsDialog api={api} store={store} order={order} />
    ));
  });
}
