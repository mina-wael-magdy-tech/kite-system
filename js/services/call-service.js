/**
 * KITE SYSTEM — Voice & video calls (WebRTC)
 *
 * Privacy model
 *  - Audio/video travels peer-to-peer, encrypted end-to-end by WebRTC (DTLS-SRTP). The server never sees it.
 *  - Call set-up messages (offer / answer / ICE) go over a PRIVATE Supabase Realtime channel
 *    `call:<conversation id>`. Row-level policies (migration 016) only let people who may post in that
 *    conversation listen or send, so outsiders can neither eavesdrop nor inject.
 *  - Small groups use a mesh (everybody connects to everybody): fine up to ~6 people.
 *  - STUN is public; for mobile data / strict firewalls configure a TURN server (ENV_ICE_SERVERS).
 */

import { getSupabase } from '../supabase-client.js';
import { CONFIG } from '../config.js';
import { Api } from './api.js';
import { Toast } from './toast-service.js';
import { escapeHTML, getInitials } from '../utils/helpers.js';

const MAX_PEERS = 6;
const RING_MS = 45_000;
const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

class CallService {
  constructor() {
    this.app = null;          // set by the app shell: { currentUser, currentProfile }
    this.session = null;      // active call
    this.ring = null;         // incoming-call dialog
  }

  init(app) { this.app = app; }
  get active() { return !!this.session; }

  // ------------------------------------------------------------ starting / joining

  /** Start a new call in a conversation: posts a call card and rings everybody else. */
  async start(conversationId, kind = 'video', title = '') {
    if (this.session) { Toast.warning('You are already in a call', 'Call'); return; }
    if (!this.supported()) return;
    try {
      const { callId } = await Api.startCall(conversationId, kind);
      await this.join(conversationId, callId, kind, title);
    } catch (err) {
      Toast.error(err.message || 'Could not start the call', 'Call');
    }
  }

  supported() {
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      Toast.error('Calls need a modern browser on a secure (https) connection.', 'Not supported');
      return false;
    }
    return true;
  }

  async join(conversationId, callId, kind = 'video', title = '') {
    if (this.session) return;
    if (!this.supported()) return;
    this.dismissRing();
    const supabase = getSupabase();
    const me = this.app.currentUser.id;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
      });
    } catch (err) {
      // no camera? fall back to audio only instead of failing the call
      if (kind === 'video') {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); kind = 'audio'; } catch { /* below */ }
      }
      if (!stream) { Toast.error('Allow microphone access to join the call.', 'Microphone'); return; }
    }

    const s = this.session = {
      conversationId, callId, kind, title, me, stream,
      peers: new Map(),      // userId -> { pc, name, stream, pending: [] , tile }
      channel: null, ui: null, startedAt: Date.now(), timer: null,
      muted: false, camOff: kind !== 'video'
    };
    this.buildUI();
    this.addTile('local', this.app.currentProfile?.full_name || 'You', stream, true);

    // The topic must be exactly `call:<conversation id>` (the server-side policy checks it).
    s.channel =supabase.channel(`call:${conversationId}`, { config: { private: true, broadcast: { self: false } } });
    s.channel.on('broadcast', { event: 'sig' }, ({ payload }) => this.onSignal(payload));
    await new Promise((resolve) => {
      s.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          Toast.error('Could not open a private call channel. Is migration 016 applied?', 'Call');
          this.leave(); resolve();
        }
      });
    });
    if (!this.session) return;
    this.send({ t: 'hello', name: this.app.currentProfile?.full_name || 'Someone' });
    this.setStatus('Waiting for others to join…');
    s.timer = setInterval(() => this.tickTimer(), 1000);
  }

  // ------------------------------------------------------------ signalling

  send(msg) {
    const s = this.session;
    if (!s?.channel) return;
    s.channel.send({ type: 'broadcast', event: 'sig', payload: { ...msg, callId: s.callId, from: s.me } });
  }

  iceServers() { return CONFIG.ICE_SERVERS?.length ? CONFIG.ICE_SERVERS : DEFAULT_ICE; }

  async onSignal(m) {
    const s = this.session;
    if (!s || !m || m.callId !== s.callId || m.from === s.me) return;
    if (m.to && m.to !== s.me) return;

    if (m.t === 'hello') {
      // a newcomer announced itself: we (already in the call) make the offer
      if (s.peers.size >= MAX_PEERS - 1 && !s.peers.has(m.from)) return;
      this.closePeer(m.from, false);
      const peer = this.createPeer(m.from, m.name);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.send({ t: 'offer', to: m.from, sdp: peer.pc.localDescription, name: this.app.currentProfile?.full_name || 'Someone' });
    } else if (m.t === 'offer') {
      this.closePeer(m.from, false);
      const peer = this.createPeer(m.from, m.name);
      await peer.pc.setRemoteDescription(m.sdp);
      await this.flushIce(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.send({ t: 'answer', to: m.from, sdp: peer.pc.localDescription });
    } else if (m.t === 'answer') {
      const peer = s.peers.get(m.from);
      if (peer && peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription(m.sdp);
        await this.flushIce(peer);
      }
    } else if (m.t === 'ice') {
      const peer = s.peers.get(m.from);
      if (!peer) return;
      if (peer.pc.remoteDescription) peer.pc.addIceCandidate(m.candidate).catch(() => {});
      else peer.pending.push(m.candidate);
    } else if (m.t === 'bye') {
      this.closePeer(m.from, true);
    }
  }

  async flushIce(peer) {
    for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  createPeer(userId, name = 'Teammate') {
    const s = this.session;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    const peer = { pc, name, pending: [], stream: new MediaStream() };
    s.peers.set(userId, peer);
    s.stream.getTracks().forEach(t => pc.addTrack(t, s.stream));

    pc.onicecandidate = (e) => { if (e.candidate) this.send({ t: 'ice', to: userId, candidate: e.candidate }); };
    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach(t => peer.stream.addTrack(t));
      this.addTile(userId, name, e.streams[0] || peer.stream, false);
      this.setStatus('');
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* ignore */ } }
      if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        // brief network blips recover on their own; drop the tile only if it stays down
        setTimeout(() => {
          if (s.peers.get(userId)?.pc === pc && ['closed', 'disconnected', 'failed'].includes(pc.connectionState)) this.closePeer(userId, true);
        }, 8000);
      }
    };
    return peer;
  }

  closePeer(userId, removeTile) {
    const s = this.session;
    const peer = s?.peers.get(userId);
    if (!peer) return;
    try { peer.pc.close(); } catch { /* ignore */ }
    s.peers.delete(userId);
    if (removeTile) {
      s.ui?.grid.querySelector(`[data-tile="${CSS.escape(userId)}"]`)?.remove();
      this.layout();
      if (!s.peers.size) this.setStatus('Everyone else left. You can hang up or wait for them to rejoin.');
    }
  }

  // ------------------------------------------------------------ in-call controls

  toggleMute() {
    const s = this.session; if (!s) return;
    s.muted = !s.muted;
    s.stream.getAudioTracks().forEach(t => { t.enabled = !s.muted; });
    this.syncButtons();
  }

  async toggleCamera() {
    const s = this.session; if (!s) return;
    const track = s.stream.getVideoTracks()[0];
    if (track) {
      s.camOff = !s.camOff;
      track.enabled = !s.camOff;
    } else {
      // audio-only call: turn the camera on and hand the new track to every peer
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        const t = cam.getVideoTracks()[0];
        s.stream.addTrack(t);
        s.camOff = false;
        for (const [id, peer] of s.peers) {
          peer.pc.addTrack(t, s.stream);
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          this.send({ t: 'offer', to: id, sdp: peer.pc.localDescription, name: this.app.currentProfile?.full_name });
        }
        const local = s.ui.grid.querySelector('[data-tile="local"] video');
        if (local) local.srcObject = s.stream;
      } catch { Toast.error('Could not turn on the camera.', 'Camera'); }
    }
    s.ui.grid.querySelector('[data-tile="local"]')?.classList.toggle('cam-off', s.camOff);
    this.syncButtons();
  }

  async shareScreen() {
    const s = this.session; if (!s || !navigator.mediaDevices.getDisplayMedia) { Toast.info('Screen sharing is not available on this device.', 'Call'); return; }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      const restore = s.stream.getVideoTracks()[0];
      for (const peer of s.peers.values()) {
        const sender = peer.pc.getSenders().find(x => x.track?.kind === 'video');
        if (sender) await sender.replaceTrack(track);
      }
      const local = s.ui.grid.querySelector('[data-tile="local"] video');
      if (local) local.srcObject = display;
      track.onended = async () => {
        for (const peer of s.peers.values()) {
          const sender = peer.pc.getSenders().find(x => x.track?.kind === 'video');
          if (sender && restore) await sender.replaceTrack(restore);
        }
        if (local) local.srcObject = s.stream;
      };
    } catch { /* user cancelled the picker */ }
  }

  leave() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    clearInterval(s.timer);
    try { s.channel?.send({ type: 'broadcast', event: 'sig', payload: { t: 'bye', callId: s.callId, from: s.me } }); } catch { /* ignore */ }
    for (const p of s.peers.values()) { try { p.pc.close(); } catch { /* ignore */ } }
    s.stream.getTracks().forEach(t => t.stop());
    const supabase = getSupabase();
    // let the "bye" leave before the socket channel is torn down
    setTimeout(() => { if (supabase && s.channel) supabase.removeChannel(s.channel); }, 400);
    s.ui?.root.remove();
    document.body.classList.remove('in-call');
  }

  // ------------------------------------------------------------ incoming call dialog

  /** info: { conversation_id, call_id, kind, from? } — from a notification or a notification tap. */
  showIncoming(info, callerName = 'Someone', conversationName = '') {
    if (this.session || this.ring || !info?.conversation_id || !info?.call_id) return;
    const el = document.createElement('div');
    el.className = 'call-ring';
    el.setAttribute('role', 'alertdialog');
    el.innerHTML = `
      <div class="call-ring-card">
        <div class="call-ring-avatar">${escapeHTML(getInitials(callerName))}</div>
        <div class="call-ring-title">${escapeHTML(callerName)}</div>
        <div class="call-ring-sub">${info.kind === 'audio' ? 'Incoming voice call' : 'Incoming video call'}${conversationName ? ' · ' + escapeHTML(conversationName) : ''}</div>
        <div class="call-ring-actions">
          <button type="button" class="call-btn call-btn-hang" data-act="decline" aria-label="Decline"><i data-lucide="phone-off"></i></button>
          <button type="button" class="call-btn call-btn-accept" data-act="accept" aria-label="Accept"><i data-lucide="${info.kind === 'audio' ? 'phone' : 'video'}"></i></button>
        </div>
      </div>`;
    document.body.appendChild(el);
    if (window.lucide) window.lucide.createIcons();
    el.querySelector('[data-act="decline"]').addEventListener('click', () => this.dismissRing());
    el.querySelector('[data-act="accept"]').addEventListener('click', () => {
      this.join(info.conversation_id, info.call_id, info.kind === 'audio' ? 'audio' : 'video', conversationName);
    });
    this.ring = { el, timeout: setTimeout(() => this.dismissRing(), RING_MS), tone: this.startRingtone() };
  }

  dismissRing() {
    if (!this.ring) return;
    clearTimeout(this.ring.timeout);
    this.ring.tone?.();
    this.ring.el.remove();
    this.ring = null;
  }

  startRingtone() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      let on = true;
      const beep = () => {
        if (!on) return;
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = 440; g.gain.value = 0.08;
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.35);
      };
      beep();
      const iv = setInterval(beep, 1600);
      return () => { on = false; clearInterval(iv); ctx.close().catch(() => {}); };
    } catch { return null; }
  }

  // ------------------------------------------------------------ UI

  buildUI() {
    const s = this.session;
    const root = document.createElement('div');
    root.className = 'call-screen';
    root.innerHTML = `
      <div class="call-top"><div class="call-title">${escapeHTML(s.title || (s.kind === 'video' ? 'Video call' : 'Voice call'))}</div><div class="call-time" id="callTime">00:00</div></div>
      <div class="call-status" id="callStatus"></div>
      <div class="call-grid" id="callGrid"></div>
      <div class="call-controls">
        <button type="button" class="call-btn" data-act="mute" aria-label="Mute"><i data-lucide="mic"></i></button>
        <button type="button" class="call-btn" data-act="cam" aria-label="Camera"><i data-lucide="video"></i></button>
        <button type="button" class="call-btn" data-act="screen" aria-label="Share screen"><i data-lucide="monitor-up"></i></button>
        <button type="button" class="call-btn call-btn-hang" data-act="hang" aria-label="Leave call"><i data-lucide="phone-off"></i></button>
      </div>`;
    document.body.appendChild(root);
    document.body.classList.add('in-call');
    s.ui = { root, grid: root.querySelector('#callGrid'), status: root.querySelector('#callStatus'), time: root.querySelector('#callTime') };
    root.querySelector('[data-act="mute"]').addEventListener('click', () => this.toggleMute());
    root.querySelector('[data-act="cam"]').addEventListener('click', () => this.toggleCamera());
    root.querySelector('[data-act="screen"]').addEventListener('click', () => this.shareScreen());
    root.querySelector('[data-act="hang"]').addEventListener('click', () => this.leave());
    this.syncButtons();
  }

  syncButtons() {
    const s = this.session; if (!s) return;
    const set = (act, on, icon) => {
      const b = s.ui.root.querySelector(`[data-act="${act}"]`);
      b.classList.toggle('off', on);
      b.innerHTML = `<i data-lucide="${icon}"></i>`;
    };
    set('mute', s.muted, s.muted ? 'mic-off' : 'mic');
    set('cam', s.camOff, s.camOff ? 'video-off' : 'video');
    if (window.lucide) window.lucide.createIcons();
  }

  addTile(id, name, stream, local) {
    const s = this.session; if (!s?.ui) return;
    let tile = s.ui.grid.querySelector(`[data-tile="${CSS.escape(id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'call-tile' + (local ? ' local' : '') + ((local && s.camOff) ? ' cam-off' : '');
      tile.dataset.tile = id;
      tile.innerHTML = `<video autoplay playsinline ${local ? 'muted' : ''}></video>
        <div class="call-tile-avatar">${escapeHTML(getInitials(name))}</div>
        <div class="call-tile-name">${escapeHTML(local ? 'You' : name)}</div>`;
      s.ui.grid.appendChild(tile);
      this.layout();
    }
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play?.().catch(() => {});
    if (!local) {
      // hide the avatar placeholder once real video frames arrive
      const hasVideo = () => stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
      tile.classList.toggle('cam-off', !hasVideo());
      stream.getVideoTracks().forEach(t => { t.onmute = () => tile.classList.add('cam-off'); t.onunmute = () => tile.classList.remove('cam-off'); });
    }
  }

  layout() {
    const s = this.session; if (!s?.ui) return;
    s.ui.grid.dataset.count = String(s.ui.grid.children.length);
  }

  setStatus(text) { if (this.session?.ui) this.session.ui.status.textContent = text; }

  tickTimer() {
    const s = this.session; if (!s) return;
    const sec = Math.floor((Date.now() - s.startedAt) / 1000);
    s.ui.time.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
}

export const Calls = new CallService();
