/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui';
import { StyledText, fg, type TextRenderable } from '@opentui/core';
import { displayName } from '../accounts/display.js';
import * as quota from '../quota/index.js';
import type { AccountsView } from './accounts-view.js';
import { bindText } from './live-text.js';

const MAX = 24;

function trim(label: string, max = MAX): string {
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

export function promptContent(context: Plugin.Context, view: AccountsView): StyledText | string {
  const active = view.active();
  if (!active) return view.snapshot().length > 0 ? new StyledText([fg(context.theme.text.muted)('no active Codex account')]) : '';
  const plan = quota.plan(active);
  return new StyledText([
    fg(context.theme.hue.accent[500])(trim(displayName(active))),
    fg(context.theme.text.muted)(plan ? ` · ${plan}` : ''),
  ]);
}

export function PromptStatus(props: { context: Plugin.Context; view: AccountsView }) {
  return (
    <text
      ref={(text: TextRenderable) => bindText(props.view, text, () => promptContent(props.context, props.view))}
      fg={props.context.theme.text.muted}
      selectable={false}
      truncate
      wrapMode="none"
    />
  );
}
