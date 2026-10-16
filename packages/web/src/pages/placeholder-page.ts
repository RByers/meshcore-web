/** "Coming soon" page used by the registry for features of later phases. */
import { css, html } from 'lit';
import { AppElement } from '../app-context.js';
import { shared } from '../styles.js';

export class McPlaceholderPage extends AppElement {
  static override properties = { feature: { type: String }, phase: { type: String } };
  declare feature: string;
  declare phase: string;

  constructor() {
    super();
    this.feature = '';
    this.phase = '';
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      .card {
        max-width: 40rem;
      }
    `,
  ];

  override render() {
    return html`<section class="card">
      <h2>${this.feature}</h2>
      <p>Coming soon${this.phase ? html` (roadmap phase ${this.phase})` : ''}.</p>
      <p class="muted">This part of the app is not built yet. Everything the radio sends is already being recorded.</p>
    </section>`;
  }
}

customElements.define('mc-placeholder-page', McPlaceholderPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-placeholder-page': McPlaceholderPage;
  }
}
