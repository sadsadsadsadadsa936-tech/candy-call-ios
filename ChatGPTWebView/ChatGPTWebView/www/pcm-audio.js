/* WebSocket PCM audio – works on iOS WKWebView (WebRTC playback is broken there) */
window.CandyPcmAudio = (function () {
  const SR = 16000;
  let capCtx = null;
  let capProc = null;
  let capSource = null;
  let capActive = false;
  let onFrame = null;
  let playCtx = null;
  let nativePlayFn = null;

  function setNativePlay(fn) {
    nativePlayFn = typeof fn === 'function' ? fn : null;
  }

  function floatTo16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function int16ToFloat(i16) {
    const out = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) out[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7fff);
    return out;
  }

  function downsample(buffer, fromRate, toRate) {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLen = Math.max(1, Math.round(buffer.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) out[i] = buffer[Math.min(Math.floor(i * ratio), buffer.length - 1)];
    return out;
  }

  function b64enc(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64dec(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function startCapture(stream, frameCb) {
    stopCapture();
    if (!stream) return;
    onFrame = frameCb;
    capCtx = new (window.AudioContext || window.webkitAudioContext)();
    await capCtx.resume();
    capSource = capCtx.createMediaStreamSource(stream);
    capProc = capCtx.createScriptProcessor(4096, 1, 1);
    capProc.onaudioprocess = (e) => {
      if (!capActive || !onFrame) return;
      const input = e.inputBuffer.getChannelData(0);
      const down = downsample(input, capCtx.sampleRate, SR);
      onFrame(floatTo16(down));
    };
    capSource.connect(capProc);
    capProc.connect(capCtx.destination);
    capActive = true;
  }

  function stopCapture() {
    capActive = false;
    onFrame = null;
    try { capProc?.disconnect(); } catch (_) {}
    try { capSource?.disconnect(); } catch (_) {}
    try { capCtx?.close(); } catch (_) {}
    capProc = capSource = capCtx = null;
  }

  function playFrame(int16) {
    if (nativePlayFn) {
      nativePlayFn(b64enc(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)), SR);
      return;
    }
    if (!playCtx || playCtx.state === 'closed') playCtx = new AudioContext({ sampleRate: SR });
    if (playCtx.state === 'suspended') playCtx.resume().catch(() => {});
    const f32 = int16ToFloat(int16);
    const buf = playCtx.createBuffer(1, f32.length, SR);
    buf.copyToChannel(f32, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playCtx.destination);
    src.start();
  }

  function handleIncoming(b64) {
    const bytes = b64dec(b64);
    playFrame(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
  }

  function stopPlayback() {
    try { playCtx?.close(); } catch (_) {}
    playCtx = null;
  }

  function stopAll() {
    stopCapture();
    stopPlayback();
  }

  return { SR, setNativePlay, startCapture, stopCapture, playFrame, handleIncoming, stopPlayback, stopAll, b64enc };
})();
