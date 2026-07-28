/**
 * SensingTab — Live WiFi Sensing Visualization
 *
 * Connects to the sensing WebSocket service and renders:
 *   1. A 3D Gaussian-splat signal field (via gaussian-splats.js)
 *   2. An overlay HUD with real-time metrics (RSSI, variance, bands, classification)
 */

import { sensingService } from '../services/sensing.service.js';
import { GaussianSplatRenderer } from './gaussian-splats.js';

export class SensingTab {
  /** @param {HTMLElement} container - the #sensing section element */
  constructor(container) {
    this.container = container;
    this.splatRenderer = null;
    this._unsubData = null;
    this._unsubState = null;
    this._resizeObserver = null;
    this._threeLoaded = false;
  }

  async init() {
    this._buildDOM();
    await this._loadThree();
    this._initSplatRenderer();
    this._connectService();
    this._setupResize();
  }

  // ---- DOM construction --------------------------------------------------

  _buildDOM() {
    this.container.innerHTML = `
      <h2>实时 WiFi 感知</h2>

      <!-- Data-source status banner — updated by _onStateChange -->
      <div id="sensingSourceBanner" class="sensing-source-banner sensing-source-reconnecting"
           role="status" aria-live="polite">
        正在连接数据源…
      </div>

      <div class="sensing-layout">
        <!-- 3D viewport -->
        <div class="sensing-viewport" id="sensingViewport">
          <div class="sensing-loading">正在加载 3D 信号场…</div>
        </div>

        <!-- Side panel -->
        <div class="sensing-panel">
          <!-- Connection -->
          <div class="sensing-card">
            <div class="sensing-card-title">连接状态</div>
            <div class="sensing-connection">
              <span class="sensing-dot" id="sensingDot"></span>
              <span id="sensingState">Connecting...</span>
              <span class="sensing-source" id="sensingSource"></span>
            </div>
          </div>

          <!-- RSSI -->
          <div class="sensing-card">
            <div class="sensing-card-title">信号强度</div>
            <div class="sensing-big-value" id="sensingRssi">-- dBm</div>
            <canvas id="sensingSparkline" width="200" height="40"></canvas>
          </div>

          <!-- Signal Features -->
          <div class="sensing-card">
            <div class="sensing-card-title">信号特征</div>
            <div class="sensing-meters">
              <div class="sensing-meter">
                <label>方差</label>
                <div class="sensing-bar"><div class="sensing-bar-fill" id="barVariance"></div></div>
                <span class="sensing-meter-val" id="valVariance">0</span>
              </div>
              <div class="sensing-meter">
                <label>运动频带</label>
                <div class="sensing-bar"><div class="sensing-bar-fill motion" id="barMotion"></div></div>
                <span class="sensing-meter-val" id="valMotion">0</span>
              </div>
              <div class="sensing-meter">
                <label>呼吸频带</label>
                <div class="sensing-bar"><div class="sensing-bar-fill breath" id="barBreath"></div></div>
                <span class="sensing-meter-val" id="valBreath">0</span>
              </div>
              <div class="sensing-meter">
                <label>频谱功率</label>
                <div class="sensing-bar"><div class="sensing-bar-fill spectral" id="barSpectral"></div></div>
                <span class="sensing-meter-val" id="valSpectral">0</span>
              </div>
            </div>
          </div>

          <!-- Classification -->
          <div class="sensing-card">
            <div class="sensing-card-title">状态分类</div>
            <div class="sensing-classification" id="sensingClassification">
              <div class="sensing-class-label" id="classLabel">未检测到人体</div>
              <div class="sensing-confidence">
                <label>置信度</label>
                <div class="sensing-bar"><div class="sensing-bar-fill confidence" id="barConfidence"></div></div>
                <span class="sensing-meter-val" id="valConfidence">0%</span>
              </div>
            </div>
          </div>

          <!-- Setup info -->
          <div class="sensing-card">
            <div class="sensing-card-title">数据说明</div>
            <p class="sensing-about-text">
              指标由 WiFi Channel State Information（CSI，信道状态信息）计算。
              <strong><span id="sensingNodeCount">0</span> 个 ESP32 节点</strong>可提供存在、呼吸估计与大幅运动演示；
              房间空间分辨率和肢体级追踪通常需要<strong>环绕布置 3–4 个以上节点</strong>。
            </p>
          </div>

          <!-- Node Status -->
          <div class="sensing-card" id="sensingNodeCards">
            <div class="sensing-card-title">节点状态</div>
            <div id="nodeStatusContainer"></div>
          </div>

          <!-- Extra info -->
          <div class="sensing-card">
            <div class="sensing-card-title">详细指标</div>
            <div class="sensing-details">
              <div class="sensing-detail-row">
                <span>主频</span><span id="valDomFreq">0 Hz</span>
              </div>
              <div class="sensing-detail-row">
                <span>变化点</span><span id="valChangePoints">0</span>
              </div>
              <div class="sensing-detail-row">
                <span>采样来源</span><span id="valSampleRate">--</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---- Three.js loading --------------------------------------------------

  async _loadThree() {
    if (window.THREE) {
      this._threeLoaded = true;
      return;
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      script.onload = () => {
        this._threeLoaded = true;
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load Three.js'));
      document.head.appendChild(script);
    });
  }

  // ---- Splat renderer ----------------------------------------------------

  _initSplatRenderer() {
    const viewport = this.container.querySelector('#sensingViewport');
    if (!viewport) return;

    // Remove loading message
    viewport.innerHTML = '';

    try {
      this.splatRenderer = new GaussianSplatRenderer(viewport, {
        width: viewport.clientWidth,
        height: viewport.clientHeight || 500,
      });
    } catch (e) {
      console.error('[SensingTab] Failed to init splat renderer:', e);
      viewport.innerHTML = '<div class="sensing-loading">当前浏览器无法显示 3D 信号场</div>';
    }
  }

  // ---- Service connection ------------------------------------------------

  _connectService() {
    sensingService.start();

    this._unsubData = sensingService.onData((data) => this._onSensingData(data));
    this._unsubState = sensingService.onStateChange((state) => this._onStateChange(state));
  }

  _onSensingData(data) {
    // Update 3D view
    if (this.splatRenderer) {
      this.splatRenderer.update(data);
    }

    // Update HUD
    this._updateHUD(data);

    // Update per-node panels
    this._updateNodePanels(data);
  }

  _onStateChange(state) {
    const dot    = this.container.querySelector('#sensingDot');
    const text   = this.container.querySelector('#sensingState');
    const banner = this.container.querySelector('#sensingSourceBanner');

    if (dot && text) {
      const stateLabels = {
        disconnected: '已断开',
        connecting:   '正在连接…',
        connected:    '已连接',
        reconnecting: '正在重连…',
        simulated:    '模拟数据',
      };
      dot.className = 'sensing-dot ' + state;
      text.textContent = stateLabels[state] || state;
    }

    if (banner) {
      // Map the service's dataSource to banner text and CSS modifier class.
      const dataSource = sensingService.dataSource;
      const bannerConfig = {
        'live':              { text: 'LIVE · ESP32 硬件',                   cls: 'sensing-source-live' },
        'server-simulated':  { text: 'SIMULATED · 服务端模拟',             cls: 'sensing-source-server-sim' },
        'reconnecting':      { text: '正在连接数据源…',                    cls: 'sensing-source-reconnecting' },
        'simulated':         { text: 'SIMULATED · 浏览器本地模拟',         cls: 'sensing-source-simulated' },
      };
      const cfg = bannerConfig[dataSource] || bannerConfig.reconnecting;
      banner.textContent = cfg.text;
      banner.className = 'sensing-source-banner ' + cfg.cls;
    }
  }

  // ---- HUD update --------------------------------------------------------

  _updateHUD(data) {
    const f = data.features || {};
    const c = data.classification || {};

    // Node count
    const nodeCount = (data.nodes || []).length;
    const countEl = this.container.querySelector('#sensingNodeCount');
    if (countEl) countEl.textContent = String(nodeCount);

    // RSSI
    this._setText('sensingRssi', `${(f.mean_rssi || -80).toFixed(1)} dBm`);
    this._setText('sensingSource', data.source || '');

    // Bars (scale to 0-100%)
    this._setBar('barVariance', f.variance, 10, 'valVariance', f.variance);
    this._setBar('barMotion', f.motion_band_power, 0.5, 'valMotion', f.motion_band_power);
    this._setBar('barBreath', f.breathing_band_power, 0.3, 'valBreath', f.breathing_band_power);
    this._setBar('barSpectral', f.spectral_power, 2.0, 'valSpectral', f.spectral_power);

    // Classification
    const label = this.container.querySelector('#classLabel');
    if (label) {
      const level = c.motion_level || 'absent';
      const levelLabels = {
        absent: '未检测到人体',
        present_still: '检测到静止人体',
        active: '检测到活动',
      };
      label.textContent = levelLabels[level] || '状态未知';
      label.className = 'sensing-class-label ' + level;
    }

    const confPct = ((c.confidence || 0) * 100).toFixed(0);
    this._setBar('barConfidence', c.confidence, 1.0, 'valConfidence', confPct + '%');

    // Details
    this._setText('valDomFreq', (f.dominant_freq_hz || 0).toFixed(3) + ' Hz');
    this._setText('valChangePoints', String(f.change_points || 0));
    const srcLabel = (data.source === 'simulated' || data.source === 'simulate') ? 'sim' : data.source || 'live';
    this._setText('valSampleRate', srcLabel);

    // Sparkline
    this._drawSparkline();
  }

  _setText(id, text) {
    const el = this.container.querySelector('#' + id);
    if (el) el.textContent = text;
  }

  _setBar(barId, value, maxVal, valId, displayVal) {
    const bar = this.container.querySelector('#' + barId);
    if (bar) {
      const pct = Math.min(100, Math.max(0, ((value || 0) / maxVal) * 100));
      bar.style.width = pct + '%';
    }
    if (valId && displayVal != null) {
      const el = this.container.querySelector('#' + valId);
      if (el) el.textContent = typeof displayVal === 'number' ? displayVal.toFixed(3) : displayVal;
    }
  }

  _drawSparkline() {
    const canvas = this.container.querySelector('#sensingSparkline');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const history = sensingService.getRssiHistory();
    if (history.length < 2) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const min = Math.min(...history) - 2;
    const max = Math.max(...history) + 2;
    const range = max - min || 1;

    ctx.beginPath();
    ctx.strokeStyle = '#32b8c6';
    ctx.lineWidth = 1.5;

    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * w;
      const y = h - ((history[i] - min) / range) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ---- Per-node panels ---------------------------------------------------

  _updateNodePanels(data) {
    const container = this.container.querySelector('#nodeStatusContainer');
    if (!container) return;
    const nodeFeatures = data.node_features || [];
    if (nodeFeatures.length === 0) {
      container.textContent = '';
      const msg = document.createElement('div');
      msg.style.cssText = 'color:#888;font-size:12px;padding:8px;';
      msg.textContent = '暂未检测到节点';
      container.appendChild(msg);
      return;
    }
    const NODE_COLORS = ['#00ccff', '#ff6600', '#00ff88', '#ff00cc', '#ffcc00', '#8800ff', '#00ffcc', '#ff0044'];
    container.textContent = '';
    for (const nf of nodeFeatures) {
      const color = NODE_COLORS[nf.node_id % NODE_COLORS.length];
      const statusColor = nf.stale ? '#888' : '#0f0';

      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 8px;margin-bottom:4px;background:rgba(255,255,255,0.03);border-radius:6px;border-left:3px solid ${color};`;

      const idCol = document.createElement('div');
      idCol.style.minWidth = '50px';
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `font-size:11px;font-weight:600;color:${color};`;
      nameEl.textContent = '节点 ' + nf.node_id;
      const statusEl = document.createElement('div');
      statusEl.style.cssText = `font-size:9px;color:${statusColor};`;
      statusEl.textContent = nf.stale ? '数据已过期' : '正在上报';
      idCol.appendChild(nameEl);
      idCol.appendChild(statusEl);

      const metricsCol = document.createElement('div');
      metricsCol.style.cssText = 'flex:1;font-size:10px;color:#aaa;';
      metricsCol.textContent = (nf.rssi_dbm || -80).toFixed(0) + ' dBm · 方差 ' + (nf.features?.variance || 0).toFixed(1);

      const classCol = document.createElement('div');
      classCol.style.cssText = 'font-size:10px;font-weight:600;color:#ccc;';
      const motionLevel = nf.classification?.motion_level || 'absent';
      const motion = {
        absent: '未检出',
        present_still: '静止',
        active: '活动',
      }[motionLevel] || '未知';
      const conf = ((nf.classification?.confidence || 0) * 100).toFixed(0);
      classCol.textContent = motion + ' ' + conf + '%';

      row.appendChild(idCol);
      row.appendChild(metricsCol);
      row.appendChild(classCol);
      container.appendChild(row);
    }
  }

  // ---- Resize ------------------------------------------------------------

  _setupResize() {
    const viewport = this.container.querySelector('#sensingViewport');
    if (!viewport || !window.ResizeObserver) return;

    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (this.splatRenderer) {
          this.splatRenderer.resize(entry.contentRect.width, entry.contentRect.height);
        }
      }
    });
    this._resizeObserver.observe(viewport);
  }

  // ---- Cleanup -----------------------------------------------------------

  dispose() {
    if (this._unsubData) this._unsubData();
    if (this._unsubState) this._unsubState();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this.splatRenderer) this.splatRenderer.dispose();
    sensingService.stop();
  }
}
