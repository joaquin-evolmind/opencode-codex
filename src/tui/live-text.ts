import { RenderableEvents, type StyledText, type TextRenderable } from '@opentui/core';
import type { AccountsView } from './accounts-view.js';

/**
 * Keep an OpenTUI text node in sync imperatively. A plugin may load its own
 * Solid runtime, so a signal update could fail to invalidate the host tree.
 */
export function bindText(
  view: AccountsView,
  text: TextRenderable,
  render: () => StyledText | string,
): void {
  let disposed = false;
  const update = (): void => {
    if (disposed) return;
    text.content = render();
    text.requestRender();
  };
  const unsubscribe = view.subscribe(update);
  text.once(RenderableEvents.DESTROYED, () => {
    disposed = true;
    unsubscribe();
  });
  update();
}
