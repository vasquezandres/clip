/* ============================================================
   SOLUTECH CLIP — clip-core.js  v4.0
   Funciones compartidas: tema, toasts, E2E, WSManager
   ============================================================ */

/* ─── Tema claro/oscuro ─────────────────────────────────────── */
export function initTheme(btnId) {
  const root = document.documentElement;
  const btn  = document.getElementById(btnId);
  if (!btn) return;
  function apply(mode) {
    root.className = mode === 'light' ? 'light' : '';
    localStorage.setItem('clip_theme', mode);
    btn.innerHTML = mode === 'light'
      ? '<i class="fa-solid fa-moon"></i>'
      : '<i class="fa-solid fa-sun"></i>';
    btn.title = mode === 'light' ? 'Cambiar a oscuro' : 'Cambiar a claro';
  }
  apply(localStorage.getItem('clip_theme') || 'light');
  btn.addEventListener('click', () =>
    apply((localStorage.getItem('clip_theme') || 'light') === 'light' ? 'dark' : 'light')
  );
}

/* ─── Toast ─────────────────────────────────────────────────── */
export function showToast(msg, kind = 'info', timeout = 2400) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const icons = { success: 'fa-circle-check', error: 'fa-triangle-exclamation', info: 'fa-circle-info' };
  const d = document.createElement('div');
  d.className = `toast ${kind}`;
  d.innerHTML = `<i class="fa-solid ${icons[kind] || icons.info}"></i> ${msg}`;
  wrap.appendChild(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 300); }, timeout);
}

/* ─── b64 seguro para buffers grandes (evita stack overflow) ── */
export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK)
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(out);
}
export function b64ToU8(b) {
  return Uint8Array.from(atob(b), c => c.charCodeAt(0));
}

/* ─── E2E — AES-GCM + PBKDF2 ───────────────────────────────── */
async function _deriveKey(roomKey) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(roomKey), 'PBKDF2', false, ['deriveKey']);
}
export async function encryptWithRoomKey(roomKey, plain) {
  const mat  = await _deriveKey(roomKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return { cipher: bufToB64(ct), iv: bufToB64(iv), salt: bufToB64(salt), alg: 'AES-GCM/PBKDF2' };
}
export async function decryptWithRoomKey(roomKey, payload) {
  const mat = await _deriveKey(roomKey);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToU8(payload.salt), iterations: 100000, hash: 'SHA-256' },
    mat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToU8(payload.iv) }, key, b64ToU8(payload.cipher)
  );
  return new TextDecoder().decode(pt);
}

/* ─── WS URL ────────────────────────────────────────────────── */
export function wsUrlFor(key) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?key=${encodeURIComponent(key)}`;
}

/* ─── Flash verde en textarea al recibir ───────────────────── */
export function flashTextarea(id = 'txt') {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('flash-in');
  void el.offsetWidth; // reflow para reiniciar animación
  el.classList.add('flash-in');
  setTimeout(() => el.classList.remove('flash-in'), 800);
}

/* ─── Dot de estado con pulse ───────────────────────────────── */
export function setDotStatus(dotId, connected) {
  const dot = document.getElementById(dotId);
  if (!dot) return;
  dot.style.background = connected ? '#12b886' : '#aaa';
  dot.classList.toggle('pulse', connected);
}

/* ─── WSManager — reconexión automática con backoff ────────── */
export class WSManager {
  constructor({ key, onOpen, onMessage, onStatus, maxRetries = 4 }) {
    this.key        = key;
    this.onOpen     = onOpen     || (() => {});
    this.onMessage  = onMessage  || (() => {});
    this.onStatus   = onStatus   || (() => {});
    this.maxRetries = maxRetries;
    this._ws        = null;
    this._retries   = 0;
    this._destroyed = false;
    this._noRetry   = false;
    this._retryTimer = null;
  }
  connect() {
    if (this._destroyed) return;
    if (this._ws) { try { this._ws.close(); } catch {} }
    const ws = new WebSocket(wsUrlFor(this.key));
    this._ws = ws;
    ws.onopen = () => {
      this._retries = 0;
      this.onStatus(true);
      showToast('Conectado', 'success');
      this.onOpen(ws);
    };
    ws.onclose = (ev) => {
      if (this._destroyed) return;
      this.onStatus(false);
      if (ev.code === 1000 || ev.code === 1001 || this._noRetry) return;
      this._scheduleRetry();
    };
    ws.onmessage = (ev) => this.onMessage(ev, ws);
    ws.onerror   = () => {};
  }
  send(data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    }
    return false;
  }
  get ready() { return this._ws && this._ws.readyState === WebSocket.OPEN; }
  _scheduleRetry() {
    if (this._retries >= this.maxRetries) {
      showToast('No se pudo reconectar. Recarga la página.', 'error', 6000);
      return;
    }
    const delay = Math.min(1000 * 2 ** this._retries, 10000);
    this._retries++;
    showToast(`Reconectando… (${this._retries}/${this.maxRetries})`, 'info', delay);
    this._retryTimer = setTimeout(() => this.connect(), delay);
  }
  destroy(noRetry = true) {
    this._destroyed = noRetry;
    this._noRetry   = noRetry;
    clearTimeout(this._retryTimer);
    try { this._ws && this._ws.close(1000, 'logout'); } catch {}
    this._ws = null;
  }
  reset(key) {
    this._destroyed = false;
    this._noRetry   = false;
    this._retries   = 0;
    if (key) this.key = key;
  }
}
