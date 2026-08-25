(() => {
  const CFG = window.CANDY_CALL_CONFIG || {};
  const API_BASE = String(CFG.apiBase || '').replace(/\/$/, '');
  const TOKEN_KEY = 'candy_call_token';
  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let me = null;
  let ws = null;
  let pc = null;
  let localStream = null;
  let activeCallId = null;
  let incomingCallId = null;
  let onHold = false;
  let onlineAgents = [];
  let ringTimer = null;
  let pendingIce = [];
  let audioUnlocked = false;

  const $ = (id) => document.getElementById(id);
  const remoteAudio = $('remote-audio');
  if (remoteAudio) {
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute('playsinline', 'true');
    remoteAudio.setAttribute('webkit-playsinline', 'true');
  }

  let ringCtx = null;
  let ringOsc = null;

  function apiUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return API_BASE + path;
  }

  function nativeBridge(payload) {
    try {
      window.webkit?.messageHandlers?.candyNative?.postMessage(payload);
    } catch (_) { /* ignore */ }
  }

  async function unlockAudio() {
    if (audioUnlocked) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        await ctx.resume();
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
        await ctx.close();
      }
      if (remoteAudio) {
        remoteAudio.muted = false;
        await remoteAudio.play().catch(() => {});
      }
      audioUnlocked = true;
    } catch (_) { /* ignore */ }
  }

  function startRing() {
    stopRing();
    nativeBridge({ type: 'incoming', title: 'Candy Call', body: 'Eingehender Anruf' });
    try {
      if (Notification.permission === 'granted') {
        new Notification('Candy Call – Anruf', {
          body: $('inc-name')?.textContent || 'Eingehender Anruf',
          tag: 'candy-call-ring',
          renotify: true
        });
      }
    } catch (_) { /* ignore */ }
    try {
      if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500, 800]);
      ringTimer = setInterval(() => {
        if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
        nativeBridge({ type: 'ring_pulse' });
      }, 2000);
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      ringCtx.resume().catch(() => {});
      const beep = () => {
        if (!ringCtx) return;
        const o = ringCtx.createOscillator();
        const g = ringCtx.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.value = 0.2;
        o.connect(g); g.connect(ringCtx.destination);
        o.start();
        setTimeout(() => { try { o.stop(); } catch (_) {} }, 400);
      };
      beep();
      ringOsc = setInterval(beep, 1100);
    } catch (_) { /* ignore */ }
  }

  function stopRing() {
    if (ringTimer) clearInterval(ringTimer);
    ringTimer = null;
    if (ringOsc) clearInterval(ringOsc);
    ringOsc = null;
    try { ringCtx?.close(); } catch (_) {}
    ringCtx = null;
    try { navigator.vibrate && navigator.vibrate(0); } catch (_) {}
    nativeBridge({ type: 'stop_ring' });
  }

  async function api(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(apiUrl(path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal
      });
      const text = await res.text();
      if (/^\s*</.test(text)) {
        throw new Error('Server blockiert die App (Cloudflare). Bitte Candy Call v1.2 installieren.');
      }
      let data = {};
      try { data = JSON.parse(text); } catch {
        throw new Error('Ungültige Server-Antwort (' + res.status + ')');
      }
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Zeitüberschreitung – Server nicht erreichbar');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiGet(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(apiUrl(path), {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        cache: 'no-store',
        signal: ctrl.signal
      });
      const text = await res.text();
      if (/^\s*</.test(text)) {
        throw new Error('Server blockiert die App (Cloudflare). Bitte Candy Call v1.2 installieren.');
      }
      let data = {};
      try { data = JSON.parse(text); } catch {
        throw new Error('Ungültige Server-Antwort (' + res.status + ')');
      }
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Zeitüberschreitung – Server nicht erreichbar');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function showLogin() {
    $('login-view').classList.remove('hidden');
    $('app-view').classList.add('hidden');
  }

  function showApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('who').textContent = me ? `${me.name}${me.isMaster ? ' · Master' : ''}` : '';
    document.querySelectorAll('.master-only').forEach((el) => {
      el.classList.toggle('hidden', !me?.isMaster);
    });
  }

  async function ensureMic() {
    await unlockAudio();
    if (localStream && localStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      return localStream;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });
    return localStream;
  }

  function setMicEnabled(enabled) {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => { t.enabled = !!enabled; });
    if (pc) {
      pc.getSenders().forEach((s) => {
        if (s.track && s.track.kind === 'audio') s.track.enabled = !!enabled;
      });
    }
  }

  function cleanupPc(keepMic) {
    try { pc?.close(); } catch (_) {}
    pc = null;
    pendingIce = [];
    if (!keepMic && localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (remoteAudio) remoteAudio.srcObject = null;
  }

  async function attachRemoteStream(stream) {
    if (!remoteAudio || !stream) return;
    remoteAudio.srcObject = stream;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    try { await remoteAudio.play(); } catch (_) {
      setTimeout(() => remoteAudio.play().catch(() => {}), 200);
    }
  }

  async function setupPeer(isOfferer) {
    // Keep mic; only reset peer connection
    if (pc) {
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    pendingIce = [];
    await ensureMic();
    pc = new RTCPeerConnection(ICE);

    for (const track of localStream.getAudioTracks()) {
      track.enabled = !onHold;
      pc.addTrack(track, localStream);
    }

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      attachRemoteStream(stream);
    };
    pc.onconnectionstatechange = () => {
      if ($('act-state') && activeCallId) {
        const st = pc?.connectionState || '';
        if (st === 'connected') $('act-state').textContent = onHold ? 'Warteschlange aktiv' : 'Verbunden – Audio aktiv';
        else if (st === 'failed') $('act-state').textContent = 'Verbindung fehlgeschlagen';
        else if (st === 'connecting') $('act-state').textContent = 'Verbinde Audio…';
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && ws && activeCallId) {
        ws.send(JSON.stringify({
          type: 'webrtc',
          callId: activeCallId,
          signal: { candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate }
        }));
      }
    };

    if (isOfferer) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({
        type: 'webrtc',
        callId: activeCallId,
        signal: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }
      }));
    }
  }

  async function flushIce() {
    if (!pc?.remoteDescription) return;
    const list = pendingIce.splice(0, pendingIce.length);
    for (const c of list) {
      try { await pc.addIceCandidate(c); } catch (_) {}
    }
  }

  async function handleSignal(signal) {
    if (!signal) return;
    if (!pc) await setupPeer(false);

    if (signal.sdp) {
      const desc = signal.sdp.type ? signal.sdp : signal.sdp;
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      await flushIce();
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({
          type: 'webrtc',
          callId: activeCallId,
          signal: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }
        }));
      }
    } else if (signal.candidate) {
      const cand = signal.candidate;
      if (!pc.remoteDescription) pendingIce.push(cand);
      else {
        try { await pc.addIceCandidate(cand); } catch (_) {}
      }
    }
  }

  function connectWs() {
    if (ws) try { ws.close(); } catch (_) {}
    let wsUrl;
    if (API_BASE) {
      const u = new URL(API_BASE);
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${proto}//${u.host}/api/candy-call/ws`;
    } else {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${proto}//${location.host}/api/candy-call/ws`;
    }
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'agent_auth', token }));
      $('agent-status').textContent = 'Online – warte auf Anrufe';
    };
    ws.onclose = () => {
      $('agent-status').textContent = 'Getrennt – reconnect…';
      setTimeout(() => { if (token) connectWs(); }, 2500);
    };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'auth_error') {
        logout(true);
        return;
      }
      if (msg.type === 'agent_ready') {
        me = msg.account;
        onlineAgents = msg.onlineAgents || [];
        showApp();
        $('agent-status').textContent = 'Online – warte auf Anrufe';
      }
      if (msg.type === 'agents_update') {
        onlineAgents = msg.onlineAgents || [];
        renderTransferList();
      }
      if (msg.type === 'incoming_call') {
        incomingCallId = msg.call.id;
        $('incoming').classList.remove('hidden');
        $('idle-hint').classList.add('hidden');
        $('inc-name').textContent = msg.call.callerName;
        $('inc-email').textContent = msg.call.callerEmail;
        $('inc-extra').textContent = msg.transferFrom
          ? `Weitergeleitet von ${msg.transferFrom}`
          : 'Eingehender Support-Anruf';
        startRing();
        switchTab('calls');
      }
      if (msg.type === 'call_taken' || msg.type === 'call_rejected_ack') {
        if (incomingCallId === msg.callId) {
          stopRing();
          $('incoming').classList.add('hidden');
          incomingCallId = null;
        }
      }
      if (msg.type === 'call_accepted') {
        stopRing();
        activeCallId = msg.call.id;
        incomingCallId = null;
        onHold = false;
        $('incoming').classList.add('hidden');
        $('active-call').classList.remove('hidden');
        $('idle-hint').classList.add('hidden');
        $('act-name').textContent = msg.call.callerName;
        $('act-email').textContent = msg.call.callerEmail;
        $('act-state').textContent = 'Verbinde Audio…';
        $('btn-hold').textContent = 'Warteschlange';
        try {
          await unlockAudio();
          await ensureMic();
          if (!pc) await setupPeer(false);
        } catch (e) {
          $('act-state').textContent = 'Mikrofon-Fehler: ' + (e.message || e);
        }
      }
      if (msg.type === 'call_hold') {
        onHold = true;
        $('act-state').textContent = 'Warteschlange aktiv – Anrufer hört Musik';
        $('btn-hold').textContent = 'Warteschlange beenden';
        setMicEnabled(false);
      }
      if (msg.type === 'call_resume') {
        onHold = false;
        $('act-state').textContent = 'Verbunden';
        $('btn-hold').textContent = 'Warteschlange';
        setMicEnabled(true);
        if (remoteAudio?.srcObject) attachRemoteStream(remoteAudio.srcObject);
      }
      if (msg.type === 'call_transferred_away') {
        activeCallId = null;
        cleanupPc(false);
        $('active-call').classList.add('hidden');
        $('idle-hint').classList.remove('hidden');
        $('agent-status').textContent = 'Gespräch weitergeleitet';
      }
      if (msg.type === 'webrtc' && msg.signal) {
        if (!activeCallId) activeCallId = msg.callId;
        await handleSignal(msg.signal);
      }
      if (msg.type === 'call_ended') {
        stopRing();
        cleanupPc(false);
        activeCallId = null;
        incomingCallId = null;
        onHold = false;
        $('incoming').classList.add('hidden');
        $('active-call').classList.add('hidden');
        $('idle-hint').classList.remove('hidden');
        $('transfer-box').classList.add('hidden');
        loadHistory();
      }
      if (msg.type === 'error') {
        alert(msg.error || 'Fehler');
      }
    };
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['calls', 'history', 'accounts'].forEach((id) => {
      $(`tab-${id}`).classList.toggle('hidden', id !== name);
    });
    if (name === 'history') loadHistory();
    if (name === 'accounts') loadAccounts();
  }

  async function loadHistory() {
    try {
      const data = await apiGet('/api/candy-call/history');
      const list = $('history-list');
      list.innerHTML = (data.history || []).map((h) => `
        <div class="item">
          <strong>${esc(h.callerName)}</strong>
          <div class="meta">
            ${esc(h.callerEmail)}<br>
            ${esc(formatTs(h.startedAt))}
            ${h.answeredByName ? ` · angenommen: ${esc(h.answeredByName)}` : ''}
            ${h.durationSec ? ` · ${h.durationSec}s` : ''}
            · ${esc(h.status)}
          </div>
        </div>
      `).join('') || '<p class="sub">Noch keine Anrufe</p>';
    } catch (e) {
      $('history-list').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }

  async function loadAccounts() {
    if (!me?.isMaster) return;
    try {
      const data = await apiGet('/api/candy-call/accounts');
      $('accounts-list').innerHTML = (data.accounts || []).map((a) => `
        <div class="item">
          <strong>${esc(a.name)}${a.isMaster ? ' (Master)' : ''}</strong>
          <div class="meta">ID: ${esc(a.id)}</div>
          ${a.password ? `<span class="pass-pill">${esc(a.password)}</span>` : ''}
          ${!a.isMaster ? `<div class="row"><button class="btn danger" data-del="${esc(a.id)}" type="button">Löschen</button></div>` : ''}
        </div>
      `).join('');
      $('accounts-list').querySelectorAll('[data-del]').forEach((btn) => {
        btn.onclick = async () => {
          if (!confirm('Account wirklich löschen?')) return;
          await api('/api/candy-call/accounts/delete', { accountId: btn.dataset.del });
          loadAccounts();
        };
      });
    } catch (e) {
      $('accounts-list').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }

  function renderTransferList() {
    const box = $('transfer-list');
    const others = onlineAgents.filter((a) => a.id !== me?.id);
    box.innerHTML = others.map((a) =>
      `<button class="btn" type="button" data-xfer="${esc(a.id)}">${esc(a.name)}</button>`
    ).join('') || '<p class="sub">Keine anderen Online-Agents</p>';
    box.querySelectorAll('[data-xfer]').forEach((btn) => {
      btn.onclick = () => {
        ws?.send(JSON.stringify({
          type: 'transfer_call',
          token,
          callId: activeCallId,
          targetAccountId: btn.dataset.xfer
        }));
        $('transfer-box').classList.add('hidden');
      };
    });
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function formatTs(iso) {
    try { return new Date(iso).toLocaleString('de-DE'); } catch { return iso || ''; }
  }

  function logout(remote) {
    stopRing();
    cleanupPc(false);
    if (token && !remote) {
      api('/api/candy-call/logout', {}).catch(() => {});
    }
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    me = null;
    try { ws?.close(); } catch (_) {}
    ws = null;
    showLogin();
  }

  $('login-btn').onclick = async () => {
    $('login-err').textContent = '';
    $('login-btn').disabled = true;
    $('login-btn').textContent = 'Bitte warten…';
    try {
      await Promise.race([
        unlockAudio(),
        new Promise((r) => setTimeout(r, 600))
      ]);
      const data = await api('/api/candy-call/login', { password: $('login-pass').value });
      token = data.token;
      me = data.account;
      localStorage.setItem(TOKEN_KEY, token);
      showApp();
      connectWs();
      try {
        ensureMic().catch(() => {});
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
          }
        } catch (_) { /* ignore */ }
        nativeBridge({ type: 'request_permissions' });
      } catch (_) { /* ask again on call */ }
    } catch (e) {
      $('login-err').textContent = e.message || 'Login fehlgeschlagen';
    } finally {
      $('login-btn').disabled = false;
      $('login-btn').textContent = 'Weiter';
    }
  };
  $('login-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('login-btn').click();
  });
  $('logout-btn').onclick = () => logout(false);

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => switchTab(t.dataset.tab);
  });

  $('btn-accept').onclick = async () => {
    try {
      await unlockAudio();
      await ensureMic();
    } catch (e) {
      alert('Mikrofon-Zugriff nötig: ' + (e.message || e));
      return;
    }
    stopRing();
    ws?.send(JSON.stringify({ type: 'accept_call', token, callId: incomingCallId }));
  };
  $('btn-reject').onclick = () => {
    stopRing();
    ws?.send(JSON.stringify({ type: 'reject_call', token, callId: incomingCallId }));
    $('incoming').classList.add('hidden');
    incomingCallId = null;
  };
  $('btn-hangup').onclick = () => {
    ws?.send(JSON.stringify({ type: 'hangup', token, callId: activeCallId }));
  };
  $('btn-hold').onclick = () => {
    if (!activeCallId || !ws) return;
    if (onHold) {
      ws.send(JSON.stringify({ type: 'resume_call', token, callId: activeCallId }));
    } else {
      ws.send(JSON.stringify({ type: 'hold_call', token, callId: activeCallId, hold: true }));
    }
  };
  $('btn-transfer').onclick = () => {
    renderTransferList();
    $('transfer-box').classList.toggle('hidden');
  };

  $('acc-create').onclick = async () => {
    $('acc-err').textContent = '';
    try {
      await api('/api/candy-call/accounts/create', {
        name: $('acc-name').value,
        password: $('acc-pass').value
      });
      $('acc-name').value = '';
      $('acc-pass').value = '';
      loadAccounts();
    } catch (e) {
      $('acc-err').textContent = e.message;
    }
  };

  if ('serviceWorker' in navigator && !CFG.native) {
    navigator.serviceWorker.register('/candy-call/sw.js').catch(() => {});
  }

  (async () => {
    if (!token) {
      showLogin();
      return;
    }
    try {
      const data = await apiGet('/api/candy-call/me');
      me = data.account;
      showApp();
      connectWs();
      nativeBridge({ type: 'request_permissions' });
    } catch {
      logout(true);
    }
  })();
})();
