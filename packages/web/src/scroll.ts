/**
 * The nearest ancestor that scrolls vertically, walking the composed tree (out of shadow roots).
 * In the app shell that is <main>; null means the document scrolls (an element mounted on its own).
 */
export function scrollParent(el: Element): HTMLElement | null {
  let node: Node | null = el.parentNode;
  while (node) {
    if (node instanceof ShadowRoot) {
      node = node.host;
      continue;
    }
    if (!(node instanceof HTMLElement) || node === document.body || node === document.documentElement) break;
    const oy = getComputedStyle(node).overflowY;
    if (oy === 'auto' || oy === 'scroll') return node;
    node = node.parentNode;
  }
  return null;
}
