/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui';
import { StyledText, bold, fg, type TextChunk, type TextRenderable } from '@opentui/core';
import * as quota from '../quota/index.js';
import type { AccountsView } from './accounts-view.js';
import { bindText } from './live-text.js';

const BAR_WIDTH = 17;

interface Line {
  label: string;
  remaining: number;
  reset?: string;
}

export function sidebarContent(context: Plugin.Context, view: AccountsView): StyledText {
  const theme = context.theme;
  const accounts = view.snapshot();
  if (accounts.length === 0) {
    return new StyledText([
      bold(fg(theme.text.base)('Codex')),
      fg(theme.text.muted)('\nNo ChatGPT accounts. Use /connect → OpenAI to add one.'),
    ]);
  }
  const chunks: TextChunk[] = [];
  const appendRows = (title: string, rows: Line[]): void => {
    if (chunks.length > 0) chunks.push(fg(theme.text.muted)('\n\n'));
    chunks.push(bold(fg(theme.text.base)(title)));
    for (const line of rows) {
      const parts = quota.bar(line.remaining, BAR_WIDTH);
      const pct = Math.round(line.remaining);
      const tail =
        line.reset && pct < 100 ? `  ${line.label} · ${pct}% (${line.reset})` : `  ${line.label} · ${pct}%`;
      chunks.push(
        fg(theme.text.muted)('\n'),
        fg(theme.hue.accent[500])(parts.filled),
        fg(theme.border.base)(parts.empty),
        fg(theme.text.muted)(tail),
      );
    }
  };
  const active = view.active();
  if (active?.usage) {
    appendRows(
      'Quota',
      active.usage.windows.map((w) => ({
        label: quota.label(w.windowMinutes),
        remaining: quota.left(w.usedPercent) ?? 0,
        reset: quota.countdown(w.resetAtMs),
      })),
    );
  }
  if (accounts.length > 1) {
    appendRows(
      'All Quota',
      quota.aggregate(accounts).map((row) => ({ label: quota.label(row.windowMinutes), remaining: row.remaining })),
    );
  }
  if (chunks.length === 0) chunks.push(bold(fg(theme.text.base)('Codex')), fg(theme.text.muted)('\nQuota not loaded yet.'));
  return new StyledText(chunks);
}

export function Sidebar(props: { context: Plugin.Context; view: AccountsView }) {
  return (
    <text
      ref={(text: TextRenderable) => bindText(props.view, text, () => sidebarContent(props.context, props.view))}
      selectable={false}
      wrapMode="none"
    />
  );
}
