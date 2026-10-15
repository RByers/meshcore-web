import { LitElement, css, html } from 'lit';
import { VERSION } from '@meshcore-web/core';

export class McApp extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      padding: 16px;
    }
    .version {
      opacity: 0.6;
      font-size: 0.85em;
    }
  `;

  override render() {
    return html`
      <h1>MeshCore Web</h1>
      <p class="version">core v${VERSION}</p>
    `;
  }
}

customElements.define('mc-app', McApp);

declare global {
  interface HTMLElementTagNameMap {
    'mc-app': McApp;
  }
}
