class CircuitBreakdownCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
  }

  setConfig(config) {
    if (!config || !config.circuit_entity) {
      throw new Error('Please define circuit_entity in your card config');
    }
    this._config = {
      title: config.title || 'Circuit Breakdown',
      subtitle: config.subtitle || 'Real-Time Load Disaggregation',
      icon: config.icon || 'mdi:flash',
      circuit_entity: config.circuit_entity,
      loads: config.loads || []
    };
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    this.update();
  }

  getCardSize() {
    return 3;
  }

  getGridOptions() {
    return {
      columns: 'full',
      rows: 'auto'
    };
  }

  render() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          background: rgba(15, 23, 42, 0.75) !important;
          backdrop-filter: blur(16px) !important;
          -webkit-backdrop-filter: blur(16px) !important;
          border: 1px solid rgba(255, 255, 255, 0.10) !important;
          border-radius: 18px !important;
          padding: 16px 18px !important;
          color: #f8fafc;
          font-family: var(--ha-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
          box-sizing: border-box;
          overflow: hidden;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          gap: 10px;
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1;
        }
        .header-icon-box {
          width: 38px;
          height: 38px;
          border-radius: 10px;
          background: rgba(56, 189, 248, 0.12);
          border: 1px solid rgba(56, 189, 248, 0.25);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #38bdf8;
          font-size: 20px;
          flex-shrink: 0;
        }
        .header-titles {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .header-title {
          font-size: 15px;
          font-weight: 700;
          color: #f8fafc;
          letter-spacing: -0.2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .header-subtitle {
          font-size: 11px;
          color: #94a3b8;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .header-right {
          text-align: right;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 1px;
          flex-shrink: 0;
        }
        .total-watts {
          font-size: 22px;
          font-weight: 800;
          color: #38bdf8;
          line-height: 1.1;
          white-space: nowrap;
        }
        .total-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: #94a3b8;
          font-weight: 600;
          white-space: nowrap;
        }
        /* Multi-segment Progress Bar */
        .progress-track {
          display: flex;
          height: 10px;
          width: 100%;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 6px;
          overflow: hidden;
          margin-bottom: 14px;
        }
        .progress-segment {
          height: 100%;
          transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        /* Itemized Load Rows */
        .items-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .item-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          padding: 8px 12px;
          transition: all 0.2s ease;
          cursor: pointer;
          gap: 8px;
        }
        .item-row:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        .item-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1;
        }
        .item-icon-box {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          flex-shrink: 0;
        }
        .item-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .item-name {
          font-size: 13px;
          font-weight: 600;
          color: #f1f5f9;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .item-desc {
          font-size: 11px;
          color: #64748b;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .item-right {
          text-align: right;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 2px;
          flex-shrink: 0;
        }
        .item-watts {
          font-size: 14px;
          font-weight: 700;
          white-space: nowrap;
        }
        .item-pct {
          font-size: 10px;
          color: #94a3b8;
          font-weight: 600;
          white-space: nowrap;
        }
        @media (max-width: 480px) {
          ha-card {
            padding: 12px 14px !important;
          }
          .header {
            margin-bottom: 10px;
          }
          .total-watts {
            font-size: 20px;
          }
          .item-row {
            padding: 7px 10px;
          }
        }
      </style>
      <ha-card>
        <div class="header">
          <div class="header-left">
            <div class="header-icon-box" id="header-icon">
              <ha-icon icon="${this._config.icon}"></ha-icon>
            </div>
            <div class="header-titles">
              <div class="header-title">${this._config.title}</div>
              <div class="header-subtitle">${this._config.subtitle}</div>
            </div>
          </div>
          <div class="header-right">
            <div class="total-watts" id="total-watts">-- W</div>
            <div class="total-label">Active Circuit Draw</div>
          </div>
        </div>

        <div class="progress-track" id="progress-track"></div>

        <div class="items-list" id="items-list"></div>
      </ha-card>
    `;
    this.update();
  }

  update() {
    if (!this._hass || !this._config || !this.shadowRoot) return;

    const circState = this._hass.states[this._config.circuit_entity];
    const totalWatts = circState ? Math.max(parseFloat(circState.state) || 0, 0) : 0;

    const totalEl = this.shadowRoot.getElementById('total-watts');
    if (totalEl) {
      totalEl.textContent = `${Math.round(totalWatts)} W`;
      totalEl.style.color = totalWatts > 0 ? '#38bdf8' : '#64748b';
    }

    const denom = totalWatts > 0 ? totalWatts : 1.0;
    const trackEl = this.shadowRoot.getElementById('progress-track');
    const listEl = this.shadowRoot.getElementById('items-list');

    if (!trackEl || !listEl) return;

    let trackHtml = '';
    let listHtml = '';

    for (const load of this._config.loads) {
      const stateObj = this._hass.states[load.entity];
      const watts = stateObj ? Math.max(parseFloat(stateObj.state) || 0, 0) : 0;
      const pct = totalWatts > 0 ? Math.min(Math.round((watts / denom) * 1000) / 10, 100) : 0;
      const isActive = watts > 0.5;
      const color = load.color || '#38bdf8';

      // Segment in progress bar
      if (totalWatts > 0 && pct > 0) {
        trackHtml += `<div class="progress-segment" style="width: ${pct}%; background: ${color};" title="${load.name}: ${watts.toFixed(1)} W (${pct}%)"></div>`;
      }

      // Secondary details description
      let desc = load.spec || '';
      if (load.state_entity) {
        const dev = this._hass.states[load.state_entity];
        if (dev) {
          if (dev.entity_id.startsWith('fan.')) {
            if (dev.state === 'on') {
              const spd = dev.attributes.percentage || 0;
              const spdName = spd <= 25 ? 'Low' : spd <= 50 ? 'Med-Low' : spd <= 75 ? 'Med-High' : 'High';
              desc = `Speed: ${spd}% (${spdName})${load.spec ? ' • ' + load.spec : ' • Active Draw'}`;
            } else {
              desc = `Fan Off${load.spec ? ' • ' + load.spec : ' • 0 W'}`;
            }
          } else if (dev.entity_id.startsWith('light.')) {
            if (dev.state === 'on') {
              const bri = dev.attributes.brightness ? Math.round((dev.attributes.brightness / 255) * 100) : 100;
              desc = `${load.spec ? load.spec + ' • ' : ''}ON (${bri}%)`;
            } else {
              desc = `${load.spec ? load.spec + ' • ' : ''}OFF`;
            }
          } else if (dev.entity_id.startsWith('media_player.')) {
            if (dev.state === 'on') {
              const src = dev.attributes.source || 'Active';
              desc = `App: ${src}${load.spec ? ' • ' + load.spec : ''}`;
            } else {
              desc = `Standby (0.5W)${load.spec ? ' • ' + load.spec : ''}`;
            }
          }
        }
      } else if (load.state_entities && load.state_entities.length > 0) {
        const parts = [];
        for (const se of load.state_entities) {
          const d = this._hass.states[se];
          if (d) {
            const name = d.attributes.friendly_name || se.split('.')[1];
            parts.push(`${name}: ${d.state.toUpperCase()}`);
          }
        }
        if (parts.length > 0) desc = parts.join(' • ');
      }

      const activeBorder = isActive ? `border-color: ${color}55; background: rgba(255, 255, 255, 0.04);` : '';
      const wattsColor = isActive ? color : '#64748b';
      const iconBg = isActive ? `${color}22` : 'rgba(255, 255, 255, 0.04)';
      const iconColor = isActive ? color : '#64748b';

      listHtml += `
        <div class="item-row" style="${activeBorder}" data-entity="${load.entity}">
          <div class="item-left">
            <div class="item-icon-box" style="background: ${iconBg}; color: ${iconColor};">
              <ha-icon icon="${load.icon || 'mdi:lightning-bolt'}"></ha-icon>
            </div>
            <div class="item-info">
              <div class="item-name">${load.name}</div>
              <div class="item-desc">${desc}</div>
            </div>
          </div>
          <div class="item-right">
            <div class="item-watts" style="color: ${wattsColor};">${watts.toFixed(1)} W</div>
            <div class="item-pct">${pct.toFixed(1)}%</div>
          </div>
        </div>
      `;
    }

    if (totalWatts === 0 || trackHtml === '') {
      trackHtml = `<div class="progress-segment" style="width: 100%; background: rgba(255,255,255,0.05);"></div>`;
    }

    trackEl.innerHTML = trackHtml;
    listEl.innerHTML = listHtml;

    // Attach click handlers to rows for more-info
    const rows = listEl.querySelectorAll('.item-row');
    rows.forEach(row => {
      row.onclick = () => {
        const ent = row.getAttribute('data-entity');
        if (ent) {
          const event = new CustomEvent('hass-more-info', {
            bubbles: true,
            composed: true,
            detail: { entityId: ent }
          });
          this.dispatchEvent(event);
        }
      };
    });
  }
}

customElements.define('circuit-breakdown-card', CircuitBreakdownCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'circuit-breakdown-card',
  name: 'Circuit Breakdown Card',
  description: 'Real-time electrical circuit submetering and load attribution card with visual segmented bar'
});
