/**
 * ALLHA-2D Custom Lovelace Card
 *
 * Встраивает ALLHA-2D через HA ingress — работает и локально, и через Nabu Casa.
 *
 * Установка:
 *   1. Скопируйте файл в /config/www/allha-card.js
 *   2. HA → Настройки → Панели → Ресурсы → Добавить:
 *        URL:  /local/allha-card.js   Тип: JavaScript-модуль
 *   3. Добавьте карточку в Lovelace:
 *        type: custom:allha-card
 *
 * Параметры:
 *   height  — высота, по умолчанию "600px". Для panel-вида — "100%"
 *   slug    — slug аддона, по умолчанию "smart_home_ui_local"
 */
class AllaCard extends HTMLElement {

  setConfig(config) {
    this._cfg = Object.assign(
      { height: '600px', slug: 'smart_home_ui_local' },
      config || {}
    );
  }

  set hass(hass) {
    if (this._hass === hass) return;
    this._hass = hass;
    if (!this._ready) {
      this._ready = true;
      this._build();
    }
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() { return 6; }

  static getStubConfig() { return { height: '600px' }; }

  /* ── DOM ──────────────────────────────────────────────────────── */

  _build() {
    const h = this._cfg.height;

    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          height: ${h};
        }
        .card {
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          overflow: hidden;
          position: relative;
          background: var(--card-background-color, #fff);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow,
            0px 2px 1px -1px rgba(0,0,0,.2),
            0px 1px 1px 0px rgba(0,0,0,.14),
            0px 1px 3px 0px rgba(0,0,0,.12));
        }
        iframe {
          display: none;
          width: 100%;
          height: 100%;
          border: none;
        }
        .msg {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: #666;
          font-size: 14px;
          font-family: sans-serif;
        }
        .spinner {
          width: 36px;
          height: 36px;
          border: 3px solid #ddd;
          border-top-color: #03a9f4;
          border-radius: 50%;
          animation: spin .8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div class="card">
        <div class="msg" id="msg">
          <div class="spinner"></div>
          <span>Загрузка ALLHA-2D…</span>
        </div>
        <iframe id="frame" allow="fullscreen" allowfullscreen></iframe>
      </div>`;

    this._frame = this.shadowRoot.getElementById('frame');
    this._msg   = this.shadowRoot.getElementById('msg');

    this._frame.addEventListener('load', () => {
      if (!this._frame.src) return;
      this._msg.style.display = 'none';
      this._frame.style.display = 'block';
    });

    this._connect();
    this._timer = setInterval(() => this._keepAlive(), 60_000);
  }

  /* ── Ingress ──────────────────────────────────────────────────── */

  async _session() {
    const data = await this._hass.callApi(
      'POST',
      `hassio/ingress/${this._cfg.slug}/session`
    );
    return data.session;
  }

  async _connect() {
    try {
      this._token = await this._session();
      this._frame.src = `/api/hassio_ingress/${this._token}/`;
    } catch (e) {
      this._showError(e);
    }
  }

  async _keepAlive() {
    if (!this._hass) return;
    try {
      const token = await this._session();
      if (token && token !== this._token) {
        this._token = token;
        this._frame.src = `/api/hassio_ingress/${token}/`;
      }
    } catch (e) {
      console.warn('[allha-card] keep-alive failed:', e.message);
    }
  }

  _showError(e) {
    const txt = e?.message || String(e);
    console.error('[allha-card]', e);
    this._msg.innerHTML = '';

    const title = document.createElement('div');
    title.style.cssText = 'color:#db4437;font-weight:500';
    title.textContent = '⚠ Не удалось подключиться к ALLHA-2D';

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;opacity:.7;max-width:300px;text-align:center';
    sub.textContent = txt;

    const btn = document.createElement('button');
    btn.textContent = 'Повторить';
    btn.style.cssText = 'margin-top:8px;padding:6px 16px;cursor:pointer;border:none;'
      + 'background:#03a9f4;color:#fff;border-radius:4px;font-size:13px';
    btn.addEventListener('click', () => this._retry());

    this._msg.append(title, sub, btn);
  }

  _retry() {
    this._msg.innerHTML = `<div class="spinner"></div><span>Загрузка ALLHA-2D…</span>`;
    this._connect();
  }
}

customElements.define('allha-card', AllaCard);

window.customCards ??= [];
window.customCards.push({
  type:        'allha-card',
  name:        'ALLHA-2D',
  description: 'Встроенная 2D-панель умного дома через HA ingress',
});
