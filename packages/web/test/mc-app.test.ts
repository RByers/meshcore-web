import { afterEach, expect, it } from 'vitest';
import '../src/mc-app.js';

afterEach(() => {
  document.body.innerHTML = '';
});

it('renders the app title', async () => {
  const el = document.createElement('mc-app');
  document.body.append(el);
  await el.updateComplete;
  expect(el.shadowRoot?.querySelector('h1')?.textContent).toBe('MeshCore Web');
  expect(el.shadowRoot?.textContent).toContain('MeshCore Web');
});
