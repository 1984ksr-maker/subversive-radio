/*
 * Subversive Radio — live video panels
 * MJPEG-over-Socket.IO: senders (host / co-host) capture their camera, encode
 * low-fps JPEG frames on a canvas, and emit them; the server fans each frame
 * out to everyone in the channel's video room. Viewers render one panel per
 * active sender. No WebRTC/TURN needed — rides the same socket the audio uses.
 */
(function (global) {
  'use strict';

  const ROLE_LABELS = { host: 'HOST', cohost: 'CO-HOST', dj: 'DJ' };

  function el(tag, css, props) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (props) Object.assign(e, props);
    return e;
  }

  // ---------------- SENDER ----------------
  function initSender(opts) {
    const socket = opts.socket;
    const role = opts.role || 'host';
    const getName = opts.getName || (() => ROLE_LABELS[role] || 'Guest');
    const fps = opts.fps || 8;
    const width = opts.width || 320;
    const height = opts.height || 240;
    const quality = opts.quality || 0.5;
    const mount = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;

    let stream = null, active = false, timer = null, facing = 'user';

    const video = el('video', 'display:none', { muted: true, autoplay: true, playsInline: true });
    video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
    const canvas = el('canvas', 'display:none');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');

    const wrap = el('div', 'width:100%;display:flex;flex-direction:column;gap:6px;margin-top:8px;align-items:stretch');
    const btn = el('button',
      'width:100%;padding:10px;border:1px solid #333;border-radius:6px;background:#1e1e1e;color:#888;' +
      'font-family:inherit;font-size:11px;letter-spacing:2px;cursor:pointer;transition:all .2s;text-transform:uppercase',
      { type: 'button', textContent: '📹 Camera Off' });
    const preview = el('video',
      'width:100%;max-width:220px;border-radius:8px;border:1px solid #333;display:none;background:#000;align-self:center',
      { muted: true, autoplay: true, playsInline: true });
    preview.setAttribute('playsinline', ''); preview.setAttribute('muted', '');
    const flipBtn = el('button',
      'padding:7px;border:1px solid #333;border-radius:6px;background:#1e1e1e;color:#888;' +
      'font-family:inherit;font-size:10px;letter-spacing:1px;cursor:pointer;display:none;text-transform:uppercase',
      { type: 'button', textContent: '⟳ Flip Camera' });

    wrap.appendChild(btn);
    wrap.appendChild(preview);
    wrap.appendChild(flipBtn);
    wrap.appendChild(video);
    wrap.appendChild(canvas);
    (mount || document.body).appendChild(wrap);

    async function getStream() {
      return navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: width }, height: { ideal: height } },
        audio: false
      });
    }

    function startLoop() {
      stopLoop();
      timer = setInterval(() => {
        if (!active || !video.videoWidth) return;
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          socket.emit('video-frame', canvas.toDataURL('image/jpeg', quality));
        } catch (e) {}
      }, Math.max(40, Math.round(1000 / fps)));
    }
    function stopLoop() { if (timer) { clearInterval(timer); timer = null; } }

    async function start() {
      try {
        stream = await getStream();
      } catch (e) {
        alert('Camera access was denied or no camera is available.');
        return;
      }
      video.srcObject = stream;
      preview.srcObject = stream;
      try { await video.play(); } catch (e) {}
      try { await preview.play(); } catch (e) {}
      active = true;
      preview.style.display = '';
      flipBtn.style.display = '';
      btn.textContent = '📹 Camera On';
      btn.style.color = '#ff2d2d';
      btn.style.borderColor = '#ff2d2d';
      socket.emit('video-start', { name: getName() });
      startLoop();
    }

    function stop() {
      active = false;
      stopLoop();
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      video.srcObject = null;
      preview.srcObject = null;
      preview.style.display = 'none';
      flipBtn.style.display = 'none';
      btn.textContent = '📹 Camera Off';
      btn.style.color = '#888';
      btn.style.borderColor = '#333';
      socket.emit('video-stop');
    }

    btn.onclick = () => (active ? stop() : start());

    flipBtn.onclick = async () => {
      facing = facing === 'user' ? 'environment' : 'user';
      if (!active) return;
      if (stream) stream.getTracks().forEach(t => t.stop());
      try {
        stream = await getStream();
        video.srcObject = stream;
        preview.srcObject = stream;
        video.play().catch(() => {});
        preview.play().catch(() => {});
      } catch (e) {}
    };

    // If the socket reconnects (new socket id), re-register the live camera.
    socket.on('connect', () => {
      if (active) setTimeout(() => { if (active) socket.emit('video-start', { name: getName() }); }, 600);
    });

    return { start, stop, isActive: () => active };
  }

  // ---------------- VIEWER ----------------
  function initViewer(opts) {
    const socket = opts.socket;
    const container = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container;
    const isSelf = opts.isSelf || (() => false);
    const displayValue = opts.display || 'grid';
    if (!container) return { addPanel() {}, removePanel() {} };
    const panels = new Map();

    function refresh() { container.style.display = panels.size ? displayValue : 'none'; }

    function labelText(info) {
      return (ROLE_LABELS[info.role] || 'GUEST') + (info.name ? ' · ' + info.name : '');
    }

    function addPanel(info) {
      if (!info || !info.id || isSelf(info.id)) return;
      if (panels.has(info.id)) { panels.get(info.id).label.textContent = labelText(info); return; }
      const panel = el('div',
        'position:relative;border:1px solid #333;border-radius:8px;overflow:hidden;background:#000;aspect-ratio:4/3');
      const img = el('img', 'width:100%;height:100%;object-fit:cover;display:block', { alt: '' });
      const label = el('div',
        'position:absolute;left:6px;bottom:6px;padding:2px 8px;border-radius:10px;background:rgba(0,0,0,.65);' +
        'font-size:9px;letter-spacing:1px;color:#fff;font-family:monospace;max-width:calc(100% - 12px);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      label.textContent = labelText(info);
      const dot = el('div',
        'position:absolute;right:6px;top:6px;width:7px;height:7px;border-radius:50%;background:#ff2d2d;' +
        'box-shadow:0 0 8px rgba(255,45,45,.8)');
      panel.appendChild(img);
      panel.appendChild(label);
      panel.appendChild(dot);
      container.appendChild(panel);
      panels.set(info.id, { panel, img, label });
      if (info.lastFrame) img.src = info.lastFrame;
      refresh();
    }

    function removePanel(id) {
      const p = panels.get(id);
      if (!p) return;
      p.panel.remove();
      panels.delete(id);
      refresh();
    }

    socket.on('video-start', addPanel);
    socket.on('video-frame', (msg) => {
      if (!msg) return;
      const p = panels.get(msg.id);
      if (p) p.img.src = msg.data;
    });
    socket.on('video-stop', (msg) => { if (msg && msg.id) removePanel(msg.id); });
    socket.on('video-senders', (list) => { if (Array.isArray(list)) list.forEach(addPanel); });

    refresh();
    return { addPanel, removePanel };
  }

  global.VideoStream = { initSender, initViewer };
})(window);
