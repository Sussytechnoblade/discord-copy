const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');

const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a7.9 7.9 0 0 1-1.4.8l-.3 1.8h-2.8l-.3-1.8a7.9 7.9 0 0 1-1.4-.8l-1.7.7-1.4-2.4 1.4-1.1a7.3 7.3 0 0 1 0-1.7l-1.4-1.1 1.4-2.4 1.7.7a7.9 7.9 0 0 1 1.4-.8l.3-1.8h2.8l.3 1.8a7.9 7.9 0 0 1 1.4.8l1.7-.7 1.4 2.4-1.4 1.1a7.3 7.3 0 0 1 0 1.7Z"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  arrow: '<path d="M19 12H5m7 7-7-7 7-7"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m16 0v-2a4 4 0 0 0-3-3.9M14 3.1a4 4 0 0 1 0 7.8"/><circle cx="10" cy="7" r="4"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
}

let db = null;
let currentUserId = null;
let activeChannelId = '';
let authMode = 'signup';
let toastTimer;
let mobileChatOpen = false;
let realtimeSocket = null;
let voiceJoinedChannelId = null;
let voiceStream = null;
let voiceMuted = false;
let voicePeers = new Map();
let voiceParticipants = [];
let socketRetryTimer = null;
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function shortName(value = '') {
  return value.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'P';
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The server could not complete that request.');
  return payload;
}

function applyState(state) {
  db = state;
  currentUserId = state.currentUserId;
  if (voiceJoinedChannelId && !state.channels.some((channel) => channel.id === voiceJoinedChannelId && channel.type === 'voice')) leaveVoice(false);
  if (!db.channels.some((channel) => channel.id === activeChannelId)) {
    activeChannelId = db.channels.find((channel) => channel.type === 'text')?.id || db.channels[0]?.id || '';
  }
  ensureRealtime();
}

function currentUser() {
  return db?.users.find((user) => user.id === currentUserId) || null;
}

function roleFor(user) {
  if (!user) return db.roles.find((role) => role.id === 'member');
  if (user.id === db.ownerId) return db.roles.find((role) => role.id === 'admin') || db.roles[0];
  return db.roles.find((role) => role.id === user.roleId) || db.roles.find((role) => role.id === 'member') || db.roles[0];
}

function canManage(user = currentUser()) {
  return Boolean(user && (user.id === db.ownerId || roleFor(user)?.canManage));
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function serverIconMarkup(className = 'server-icon') {
  return `<span class="${className}">${db.server.icon ? `<img src="${escapeHtml(db.server.icon)}" alt="">` : escapeHtml(shortName(db.server.name))}</span>`;
}

function renderAuth(errorMessage = '') {
  const isSignup = authMode === 'signup';
  app.innerHTML = `
    <main class="auth-screen">
      <section class="auth-art" aria-label="PUSDSMP community">
        <a class="brand-lockup" href="#" aria-label="PUSDSMP home"><span class="brand-mark">P</span><span class="brand-word">PUSDSMP</span></a>
        <div class="art-copy"><span class="eyebrow">A community server</span><h1>Your world.<br><span>Your people.</span></h1><p>A home for the builders, explorers, and late-night adventurers of PUSDSMP.</p></div>
        <div class="art-bottom"><span>EST. IN YOUR BROWSER</span><span>PLAY NICE. BUILD BIG.</span></div>
      </section>
      <section class="auth-panel"><div class="auth-card">
        <h2>${isSignup ? 'Find your people.' : 'Welcome back.'}</h2>
        <p>${isSignup ? 'Create an account to join the PUSDSMP server.' : 'Sign in to get back to the PUSDSMP server.'}</p>
        <div class="auth-tabs" role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected="${isSignup}" class="${isSignup ? 'active' : ''}" data-action="auth-mode" data-mode="signup">Sign up</button>
          <button type="button" role="tab" aria-selected="${!isSignup}" class="${!isSignup ? 'active' : ''}" data-action="auth-mode" data-mode="login">Log in</button>
        </div>
        <form id="auth-form" novalidate>
          <div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" minlength="2" maxlength="24" placeholder="Your name in the server" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="8" placeholder="At least 8 characters" required></div>
          ${isSignup ? '<div class="field"><label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Enter it one more time" required></div>' : ''}
          <p class="form-error" aria-live="polite">${escapeHtml(errorMessage)}</p>
          <button class="btn full" type="submit">${isSignup ? 'Create your account' : 'Log in to PUSDSMP'}</button>
        </form>
        <div class="auth-note">${db?.users.length ? 'Your account is saved on the PUSDSMP server.' : 'The first account created becomes the server owner.'} Your login works anywhere this server is hosted.</div>
      </div></section>
    </main>`;
}

function renderChannelItem(channel, manager) {
  const selected = channel.id === activeChannelId;
  return `<div class="channel-item">
    <button class="channel-link ${selected ? 'active' : ''}" type="button" data-action="select-channel" data-id="${escapeHtml(channel.id)}" aria-current="${selected ? 'page' : 'false'}">
      <span class="channel-symbol">${channel.type === 'voice' ? icon('mic') : '#'}</span><span>${escapeHtml(channel.name)}</span>
    </button>
    ${manager ? `<button class="icon-btn channel-actions" type="button" data-action="edit-channel" data-id="${escapeHtml(channel.id)}" aria-label="Edit ${escapeHtml(channel.name)}">${icon('edit')}</button>` : ''}
  </div>`;
}

function renderMembers(manager) {
  const roles = [...db.roles].sort((a, b) => Number(Boolean(b.canManage)) - Number(Boolean(a.canManage)) || a.name.localeCompare(b.name));
  return db.users.map((user) => {
    const role = roleFor(user);
    const isOwner = user.id === db.ownerId;
    return `<div class="member">
      <span class="avatar" style="background:${escapeHtml(role?.color || '#b8f36b')}" aria-hidden="true">${escapeHtml(shortName(user.username))}</span>
      <div class="member-info"><strong>${escapeHtml(user.username)}${isOwner ? ' · owner' : ''}</strong><span class="member-role"><i class="member-role-dot" style="background:${escapeHtml(role?.color || '#a9b3aa')}"></i>${escapeHtml(role?.name || 'Member')}</span></div>
      ${manager && !isOwner ? `<button class="icon-btn member-edit" type="button" data-action="assign-role" data-id="${escapeHtml(user.id)}" aria-label="Change role for ${escapeHtml(user.username)}">${icon('settings')}</button>` : ''}
    </div>`;
  }).join('');
}

function renderMessage(message) {
  const user = db.users.find((entry) => entry.id === message.userId);
  const role = roleFor(user);
  const date = new Date(message.createdAt);
  const time = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const mentionData = message.mentions || {};
  const mentionTerms = [
    ...(mentionData.everyone ? [{ name: 'everyone', kind: 'everyone' }] : []),
    ...(mentionData.roles || []).map((roleId) => db.roles.find((entry) => entry.id === roleId)).filter(Boolean).map((entry) => ({ name: entry.name, kind: 'role', color: entry.color })),
  ].sort((left, right) => right.name.length - left.name.length);
  const mentionPattern = mentionTerms.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_@])@(?:${mentionTerms.map((entry) => entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
    : null;
  const messageText = mentionPattern
    ? escapeHtml(message.text).replace(mentionPattern, (match) => {
      const mention = mentionTerms.find((entry) => `@${entry.name}`.toLowerCase() === match.toLowerCase());
      const kind = mention?.kind === 'everyone' ? 'everyone-mention' : 'role-mention';
      const colorStyle = mention?.kind === 'role' ? ` style="--mention-color:${escapeHtml(mention.color)}"` : '';
      return `<mark class="${kind}"${colorStyle}>${escapeHtml(match)}</mark>`;
    })
    : escapeHtml(message.text);
  return `<article class="message">
    <span class="avatar" style="background:${escapeHtml(role?.color || '#b8f36b')}" aria-hidden="true">${escapeHtml(shortName(user?.username || 'Deleted account'))}</span>
    <div class="message-body"><div class="message-head"><strong>${escapeHtml(user?.username || 'Former member')}</strong><time datetime="${escapeHtml(date.toISOString?.() || '')}">${escapeHtml(time)}</time></div><div class="message-text">${messageText}</div></div>
  </article>`;
}

function notifyMessageMentions(message) {
  if (message.userId === currentUserId) return;
  const mentions = message.mentions || {};
  const author = db.users.find((entry) => entry.id === message.userId)?.username || 'Someone';
  const channel = db.channels.find((entry) => entry.id === message.channelId);
  if (mentions.everyone) {
    notify(`${author} mentioned everyone in #${channel?.name || 'a channel'}.`);
    return;
  }
  const user = currentUser();
  const roleId = user?.id === db.ownerId ? 'admin' : user?.roleId;
  if (roleId && mentions.roles?.includes(roleId)) {
    const role = db.roles.find((entry) => entry.id === roleId);
    notify(`${author} mentioned @${role?.name || 'your role'} in #${channel?.name || 'a channel'}.`);
  }
}

function renderVoiceView(channel) {
  const connectedHere = voiceJoinedChannelId === channel.id;
  const connectedElsewhere = voiceJoinedChannelId && !connectedHere;
  const participants = connectedHere ? voiceParticipants : [];
  const participantMarkup = participants.map((participant) => `<div class="voice-participant"><span class="avatar" aria-hidden="true">${escapeHtml(shortName(participant.username))}</span><span>${escapeHtml(participant.username)}${participant.self ? ' (you)' : ''}</span><span class="voice-speaking" aria-label="Connected"></span></div>`).join('');
  const controls = connectedHere
    ? `<div class="voice-controls"><button class="btn secondary" type="button" data-action="toggle-mute">${icon('mic')} ${voiceMuted ? 'Unmute' : 'Mute'}</button><button class="btn danger" type="button" data-action="leave-voice">Leave voice</button></div>`
    : `<button class="btn" type="button" data-action="join-voice" ${!navigator.mediaDevices?.getUserMedia ? 'disabled' : ''}>${icon('mic')} Join voice</button>`;
  const hint = connectedHere
    ? `${participants.length} ${participants.length === 1 ? 'person' : 'people'} connected. Keep this tab open while you talk.`
    : connectedElsewhere
      ? `You’re connected to another voice room. Leave it before joining #${escapeHtml(channel.name)}.`
      : 'Your browser will ask for microphone access when you join.';
  return `<div class="voice-view"><span class="voice-orb">${icon('mic')}</span><h3>${escapeHtml(channel.name)}</h3><p>${hint}</p>${controls}<div class="voice-participants">${participantMarkup}</div><div id="voice-audio-slot"></div></div>`;
}

function renderWorkspace() {
  const user = currentUser();
  if (!user) {
    currentUserId = null;
    db = null;
    renderAuth();
    return;
  }

  const manager = canManage(user);
  let channel = db.channels.find((entry) => entry.id === activeChannelId);
  if (!channel) {
    channel = db.channels.find((entry) => entry.type === 'text') || db.channels[0];
    activeChannelId = channel?.id || '';
  }

  const categories = [...new Set(db.channels.map((entry) => entry.category || 'THE SERVER'))];
  const channelGroups = categories.map((category) => {
    const items = db.channels.filter((entry) => (entry.category || 'THE SERVER') === category);
    return `<section class="channel-category"><div class="category-heading"><span>${escapeHtml(category)}</span>${manager ? `<button class="icon-btn" type="button" data-action="add-channel" data-category="${escapeHtml(category)}" aria-label="Add a channel to ${escapeHtml(category)}">${icon('plus')}</button>` : ''}</div><div class="channel-list">${items.map((item) => renderChannelItem(item, manager)).join('')}</div></section>`;
  }).join('');

  const messages = channel?.type === 'text' ? db.messages.filter((message) => message.channelId === channel.id) : [];
  const channelSymbol = channel?.type === 'voice' ? icon('mic') : '#';
  const channelContent = channel?.type === 'voice'
    ? renderVoiceView(channel)
    : `<div class="message-list" id="message-list">
        ${messages.length ? messages.map(renderMessage).join('') : `<section class="welcome-block"><span class="welcome-mark">#</span><h3>Welcome to #${escapeHtml(channel?.name || '')}</h3><p>This is the beginning of the channel. Say hello, share what you’re building, or start planning your next adventure.</p></section>`}
      </div>
      <div class="composer-wrap">${manager ? '<p class="mention-hint">Admin mentions: @everyone · @Role name</p>' : ''}<form class="composer" id="message-form"><input name="message" maxlength="2000" autocomplete="off" aria-label="Message #${escapeHtml(channel?.name || '')}" placeholder="Message #${escapeHtml(channel?.name || '')}" required><button class="send-btn" type="submit" aria-label="Send message">${icon('send')}</button></form></div>`;

  app.innerHTML = `<main class="server-app ${mobileChatOpen ? 'chat-open' : ''}">
    <header class="topbar">
      <div class="topbar-logo">${serverIconMarkup()}<span class="topbar-title">${escapeHtml(db.server.name)}</span></div>
      <span class="topbar-subtitle">${db.users.length} ${db.users.length === 1 ? 'member' : 'members'} · COMMUNITY SERVER</span>
      <div class="topbar-user"><span class="user-name">${escapeHtml(user.username)}<span class="user-tag">${escapeHtml(roleFor(user)?.name || 'Member')}</span></span><span class="avatar" aria-hidden="true">${escapeHtml(shortName(user.username))}</span><button class="icon-btn" type="button" data-action="logout" aria-label="Log out">${icon('close')}</button></div>
    </header>
    <nav class="server-rail" aria-label="Server navigation"><button class="rail-icon active" type="button" aria-label="PUSDSMP server">${escapeHtml(shortName(db.server.name))}</button><span class="rail-divider"></span>${manager ? `<button class="rail-icon" type="button" data-action="server-settings" aria-label="Server settings">${icon('settings')}</button>` : ''}</nav>
    <aside class="channel-sidebar" aria-label="Channels">
      <div class="server-heading"><h2>${escapeHtml(db.server.name)}</h2>${manager ? `<button class="icon-btn" type="button" data-action="server-settings" aria-label="Server settings">${icon('settings')}</button>` : ''}</div>
      <div class="channel-scroll">${channelGroups}${manager ? `<button class="btn secondary small full" type="button" data-action="add-channel">${icon('plus')} Add channel</button>` : ''}</div>
      <div class="sidebar-profile"><span class="avatar" aria-hidden="true">${escapeHtml(shortName(user.username))}</span><div class="sidebar-profile-info"><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(roleFor(user)?.name || 'Member')}</span></div><button class="icon-btn" type="button" data-action="logout" aria-label="Log out">${icon('close')}</button></div>
    </aside>
    <section class="chat-panel" aria-label="Channel conversation">
      <header class="channel-top"><button class="icon-btn mobile-menu" type="button" data-action="mobile-channels" aria-label="Back to channels">${icon('arrow')}</button><span class="channel-top-symbol">${channelSymbol}</span><h2>${escapeHtml(channel?.name || 'No channels')}</h2><span class="channel-topic">${escapeHtml(db.server.description)}</span><div class="channel-tools"><button class="icon-btn" type="button" data-action="members" aria-label="View members">${icon('users')}</button>${manager ? `<button class="icon-btn" type="button" data-action="roles" aria-label="Manage roles">${icon('settings')}</button>` : ''}</div></header>
      ${channelContent}
    </section>
    <aside class="members-panel" aria-label="Server members"><div class="members-title">Members <span>${db.users.length}</span></div>${renderMembers(manager)}</aside>
  </main>`;
  if (messages.length) {
    const messageList = document.querySelector('#message-list');
    messageList.scrollTop = messageList.scrollHeight;
  }
  syncRemoteAudio();
}

function sendRealtime(payload) {
  if (realtimeSocket?.readyState === WebSocket.OPEN) realtimeSocket.send(JSON.stringify(payload));
}

function ensureRealtime() {
  if (!currentUserId || !db || realtimeSocket?.readyState === WebSocket.OPEN || realtimeSocket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(socketRetryTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/realtime`);
  realtimeSocket = socket;
  socket.addEventListener('open', () => {
    if (voiceJoinedChannelId) sendRealtime({ type: 'voice:join', channelId: voiceJoinedChannelId });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleRealtimeMessage(message);
  });
  socket.addEventListener('close', () => {
    if (realtimeSocket !== socket) return;
    realtimeSocket = null;
    closeVoicePeers();
    voiceParticipants = voiceJoinedChannelId && currentUser()
      ? [{ id: 'self', username: currentUser().username, self: true }]
      : [];
    if (currentUserId) socketRetryTimer = setTimeout(ensureRealtime, 1800);
  });
}

function handleRealtimeMessage(message) {
  if (message.type === 'message') {
    if (!db.messages.some((entry) => entry.id === message.message.id)) db.messages.push(message.message);
    if (db.messages.length > 1000) db.messages.shift();
    notifyMessageMentions(message.message);
    if (message.message.channelId === activeChannelId) renderWorkspace();
  } else if (message.type === 'state:changed') {
    refreshState();
  } else if (message.type === 'voice:peers') {
    voiceParticipants = [{ id: 'self', username: currentUser().username, self: true }, ...message.peers];
    renderWorkspace();
    message.peers.forEach((peer) => createVoicePeer(peer, true));
  } else if (message.type === 'voice:user-joined') {
    if (!voiceParticipants.some((peer) => peer.id === message.user.id)) voiceParticipants.push(message.user);
    if (activeChannelId === voiceJoinedChannelId) renderWorkspace();
  } else if (message.type === 'voice:user-left') {
    voiceParticipants = voiceParticipants.filter((peer) => peer.id !== message.userId);
    closeVoicePeer(message.userId);
    if (activeChannelId === voiceJoinedChannelId) renderWorkspace();
  } else if (message.type === 'voice:signal') {
    receiveVoiceSignal(message);
  } else if (message.type === 'error') {
    notify(message.message);
  }
}

async function refreshState() {
  try {
    const payload = await api('/api/state');
    applyState(payload.state);
    renderWorkspace();
  } catch (error) {
    notify(error.message);
  }
}

function createVoicePeer(peer, initiate) {
  let entry = voicePeers.get(peer.id);
  if (entry) return entry;
  const connection = new RTCPeerConnection({ iceServers });
  entry = { connection, pendingCandidates: [], audio: null };
  voicePeers.set(peer.id, entry);
  voiceStream?.getTracks().forEach((track) => connection.addTrack(track, voiceStream));
  connection.addEventListener('icecandidate', (event) => {
    if (event.candidate) sendRealtime({ type: 'voice:signal', targetId: peer.id, signal: { type: 'candidate', candidate: event.candidate.toJSON() } });
  });
  connection.addEventListener('track', (event) => {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = event.streams[0];
    entry.audio = audio;
    document.querySelector('#voice-audio')?.append(audio);
    audio.play().catch(() => notify('Tap the page once to allow voice audio playback.'));
  });
  if (initiate) {
    connection.createOffer()
      .then((offer) => connection.setLocalDescription(offer))
      .then(() => sendRealtime({ type: 'voice:signal', targetId: peer.id, signal: { type: 'offer', sdp: connection.localDescription } }))
      .catch(() => notify(`Could not start a voice connection with ${peer.username}.`));
  }
  return entry;
}

async function receiveVoiceSignal(message) {
  const peer = { id: message.fromId, username: message.username };
  const entry = createVoicePeer(peer, false);
  try {
    if (message.signal.type === 'candidate') {
      if (entry.connection.remoteDescription) await entry.connection.addIceCandidate(message.signal.candidate);
      else entry.pendingCandidates.push(message.signal.candidate);
      return;
    }
    await entry.connection.setRemoteDescription(message.signal);
    for (const candidate of entry.pendingCandidates) await entry.connection.addIceCandidate(candidate);
    entry.pendingCandidates = [];
    if (message.signal.type === 'offer') {
      const answer = await entry.connection.createAnswer();
      await entry.connection.setLocalDescription(answer);
      sendRealtime({ type: 'voice:signal', targetId: peer.id, signal: { type: 'answer', sdp: entry.connection.localDescription } });
    }
  } catch {
    notify(`Voice connection with ${peer.username} could not be established.`);
  }
}

function closeVoicePeer(peerId) {
  const entry = voicePeers.get(peerId);
  if (!entry) return;
  entry.connection.close();
  entry.audio?.remove();
  voicePeers.delete(peerId);
}

function closeVoicePeers() {
  [...voicePeers.keys()].forEach(closeVoicePeer);
}

function syncRemoteAudio() {
  const container = document.querySelector('#voice-audio');
  if (!container) return;
  for (const entry of voicePeers.values()) {
    if (entry.audio && !entry.audio.isConnected) container.append(entry.audio);
  }
}

async function joinVoice() {
  const channel = db?.channels.find((entry) => entry.id === activeChannelId && entry.type === 'voice');
  if (!channel) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    notify('Voice chat requires HTTPS or localhost and a browser with microphone support.');
    return;
  }
  try {
    if (voiceJoinedChannelId) leaveVoice(false);
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceMuted = false;
    voiceJoinedChannelId = channel.id;
    voiceParticipants = [{ id: 'self', username: currentUser().username, self: true }];
    ensureRealtime();
    sendRealtime({ type: 'voice:join', channelId: channel.id });
    renderWorkspace();
    notify(`Joined #${channel.name}.`);
  } catch (error) {
    notify(error.name === 'NotAllowedError' ? 'Allow microphone access in your browser to join voice.' : `Could not join voice: ${error.message}`);
  }
}

function leaveVoice(showNotice = true) {
  if (!voiceJoinedChannelId) return;
  const oldChannelId = voiceJoinedChannelId;
  sendRealtime({ type: 'voice:leave' });
  voiceJoinedChannelId = null;
  voiceParticipants = [];
  closeVoicePeers();
  voiceStream?.getTracks().forEach((track) => track.stop());
  voiceStream = null;
  voiceMuted = false;
  if (db) renderWorkspace();
  if (showNotice) notify('You left the voice room.');
  return oldChannelId;
}

function toggleVoiceMute() {
  if (!voiceStream) return;
  voiceMuted = !voiceMuted;
  voiceStream.getAudioTracks().forEach((track) => { track.enabled = !voiceMuted; });
  renderWorkspace();
}

async function logout() {
  leaveVoice(false);
  currentUserId = null;
  db = null;
  clearTimeout(socketRetryTimer);
  if (realtimeSocket) {
    const socket = realtimeSocket;
    realtimeSocket = null;
    socket.close();
  }
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  authMode = 'login';
  mobileChatOpen = false;
  renderAuth();
}

function render() {
  if (currentUser()) renderWorkspace();
  else renderAuth();
}

function openDialog(title, body, footer = '') {
  dialog.innerHTML = `<div class="modal-head"><h2 id="dialog-title">${escapeHtml(title)}</h2><button class="icon-btn" type="button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}`;
  dialog.className = 'modal';
  dialog.showModal();
}

function openChannelDialog(channelId = '', category = 'THE SERVER') {
  if (!canManage()) return;
  const channel = db.channels.find((entry) => entry.id === channelId);
  const categories = [...new Set([...db.channels.map((entry) => entry.category), category].filter(Boolean))];
  const footer = `${channel ? '<button class="btn danger small" type="button" data-action="delete-channel" data-id="' + escapeHtml(channel.id) + '">Delete channel</button>' : ''}<span style="flex:1"></span><button class="btn secondary small" type="button" data-action="close-dialog">Cancel</button><button class="btn small" type="submit" form="channel-form">${channel ? 'Save channel' : 'Create channel'}</button>`;
  openDialog(channel ? 'Edit channel' : 'Create a channel', `<p class="modal-intro">Give this space a name and choose where it belongs in your server.</p><form id="channel-form" data-id="${escapeHtml(channel?.id || '')}">
    <div class="field"><label for="channel-name">Channel name</label><input id="channel-name" name="name" maxlength="40" value="${escapeHtml(channel?.name || '')}" placeholder="e.g. build-showcase" required></div>
    <div class="field"><label for="channel-category">Category</label><input id="channel-category" name="category" maxlength="32" list="channel-categories" value="${escapeHtml(channel?.category || category)}" placeholder="THE SERVER" required><datalist id="channel-categories">${categories.map((entry) => `<option value="${escapeHtml(entry)}">`).join('')}</datalist></div>
    <div class="field"><label for="channel-type">Channel type</label><select id="channel-type" name="type"><option value="text" ${channel?.type !== 'voice' ? 'selected' : ''}>Text</option><option value="voice" ${channel?.type === 'voice' ? 'selected' : ''}>Voice room</option></select></div>
  </form>`, footer);
}

function openRolesDialog() {
  if (!canManage()) return;
  const rows = db.roles.map((role) => `<div class="role-row" data-role-row="${escapeHtml(role.id)}">
    <input aria-label="Role name" type="text" name="name-${escapeHtml(role.id)}" maxlength="24" value="${escapeHtml(role.name)}" ${role.id === 'member' || role.id === 'admin' ? 'required' : ''}>
    <input aria-label="Role color" type="color" name="color-${escapeHtml(role.id)}" value="${/^#[0-9a-f]{6}$/i.test(role.color) ? role.color : '#a9b3aa'}">
    ${role.id === 'admin' ? '<span title="Server owners always keep full access">Owner</span>' : `<label><input type="checkbox" name="manage-${escapeHtml(role.id)}" ${role.canManage ? 'checked' : ''}> Manage</label>`}
    ${role.id !== 'admin' && role.id !== 'member' ? `<button class="role-delete" type="button" data-action="delete-role" data-id="${escapeHtml(role.id)}" aria-label="Delete ${escapeHtml(role.name)}">${icon('trash')}</button>` : '<span></span>'}
  </div>`).join('');
  const footer = '<button class="btn secondary small" type="button" data-action="close-dialog">Cancel</button><button class="btn small" type="submit" form="roles-form">Save roles</button>';
  openDialog('Roles & permissions', `<p class="modal-intro">Set role colors and choose who can manage channels, roles, and server settings. The server owner always has full access.</p><form id="roles-form">${rows}</form><button class="btn secondary small new-role" type="button" data-action="add-role">${icon('plus')} Create role</button>`, footer);
}

function openSettingsDialog() {
  if (!canManage()) return;
  const footer = '<button class="btn secondary small" type="button" data-action="close-dialog">Cancel</button><button class="btn small" type="submit" form="settings-form">Save changes</button>';
  openDialog('Server settings', `<p class="modal-intro">Make this server yours. Changes are saved to the PUSDSMP server.</p><div class="settings-preview">${serverIconMarkup()}<div><strong>${escapeHtml(db.server.name)}</strong><span>Server identity</span></div></div>
    <form id="settings-form"><div class="field"><label for="server-name">Server name</label><input id="server-name" name="name" maxlength="32" value="${escapeHtml(db.server.name)}" required></div>
    <div class="field"><label for="server-description">Server description</label><input id="server-description" name="description" maxlength="120" value="${escapeHtml(db.server.description)}"></div>
    <div class="field"><label for="server-icon-file">Server icon</label><input id="server-icon-file" name="icon" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></div>
    <p class="channel-empty-copy">Use a square image under 2 MB for the best result.</p></form>`, footer);
}

function openMemberRoleDialog(userId) {
  if (!canManage()) return;
  const user = db.users.find((entry) => entry.id === userId);
  if (!user || user.id === db.ownerId) return;
  const options = db.roles.filter((role) => role.id !== 'admin').map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === user.roleId ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('');
  const footer = '<button class="btn secondary small" type="button" data-action="close-dialog">Cancel</button><button class="btn small" type="submit" form="member-role-form">Save role</button>';
  openDialog(`Role for ${user.username}`, `<p class="modal-intro">Choose the role this member has in the PUSDSMP server.</p><form id="member-role-form" data-id="${escapeHtml(user.id)}"><div class="field"><label for="member-role-select">Server role</label><select name="roleId" id="member-role-select">${options}</select></div></form>`, footer);
}

async function removeChannel(channelId) {
  if (!canManage()) return;
  if (db.channels.length <= 1) {
    notify('A server needs at least one channel.');
    return;
  }
  const channel = db.channels.find((entry) => entry.id === channelId);
  if (!channel) return;
  try {
    const payload = await api(`/api/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
    applyState(payload.state);
    dialog.close();
    renderWorkspace();
    notify(`#${channel.name} was deleted.`);
  } catch (error) {
    notify(error.message);
  }
}

async function imageAsDataUrl(file) {
  if (!file) return '';
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 2 * 1024 * 1024) throw new Error('That image is over 2 MB. Choose a smaller file.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'auth-mode') {
    authMode = button.dataset.mode;
    renderAuth();
  } else if (action === 'logout') {
    logout();
  } else if (action === 'select-channel') {
    activeChannelId = id;
    mobileChatOpen = true;
    renderWorkspace();
  } else if (action === 'mobile-channels') {
    mobileChatOpen = false;
    renderWorkspace();
  } else if (action === 'add-channel') {
    openChannelDialog('', button.dataset.category || 'THE SERVER');
  } else if (action === 'edit-channel') {
    openChannelDialog(id);
  } else if (action === 'server-settings') {
    openSettingsDialog();
  } else if (action === 'roles') {
    openRolesDialog();
  } else if (action === 'delete-channel') {
    removeChannel(id);
  } else if (action === 'delete-role') {
    if (!canManage() || id === 'member' || id === 'admin') return;
    const role = db.roles.find((entry) => entry.id === id);
    if (!role) return;
    try {
      const payload = await api(`/api/roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      applyState(payload.state);
      openRolesDialog();
      notify(`${role.name} role deleted.`);
    } catch (error) {
      notify(error.message);
    }
  } else if (action === 'add-role') {
    if (!canManage()) return;
    try {
      const payload = await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'New role', color: '#f18a55' }) });
      applyState(payload.state);
      openRolesDialog();
      const names = dialog.querySelectorAll('input[name^="name-"]');
      names[names.length - 1]?.select();
    } catch (error) {
      notify(error.message);
    }
  } else if (action === 'assign-role') {
    openMemberRoleDialog(id);
  } else if (action === 'members') {
    if (window.matchMedia('(max-width: 1050px)').matches) notify(`${db.users.length} ${db.users.length === 1 ? 'member' : 'members'} in this server`);
  } else if (action === 'join-voice') {
    joinVoice();
  } else if (action === 'leave-voice') {
    leaveVoice();
  } else if (action === 'toggle-mute') {
    toggleVoiceMute();
  } else if (action === 'close-dialog') {
    dialog.close();
  }
});

app.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = new FormData(form);

  if (form.id === 'auth-form') {
    const username = String(data.get('username') || '').trim();
    const password = String(data.get('password') || '');
    const confirmPassword = String(data.get('confirmPassword') || '');
    const fail = (message) => {
      const error = app.querySelector('.form-error');
      if (error) error.textContent = message;
    };
    if (!/^[\p{L}\p{N}_ -]{2,24}$/u.test(username)) {
      fail('Use 2–24 letters, numbers, spaces, underscores, or hyphens.');
      return;
    }
    if (password.length < 8) {
      fail('Your password needs at least 8 characters.');
      return;
    }
    if (authMode === 'signup') {
      if (password !== confirmPassword) {
        fail('Those passwords do not match.');
        return;
      }
      try {
        const result = await api('/api/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        applyState(result.state);
        renderWorkspace();
        notify(result.state.ownerId === result.state.currentUserId ? 'You’re in. You’re the PUSDSMP server owner.' : 'Welcome to PUSDSMP.');
      } catch (error) {
        fail(error.message);
      }
    } else {
      try {
        const result = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        applyState(result.state);
        renderWorkspace();
      } catch (error) {
        fail(error.message);
      }
    }
  } else if (form.id === 'message-form') {
    const channel = db.channels.find((entry) => entry.id === activeChannelId);
    const text = String(data.get('message') || '').trim();
    if (!channel || channel.type !== 'text' || !text) return;
    try {
      const result = await api('/api/messages', { method: 'POST', body: JSON.stringify({ channelId: channel.id, text }) });
      if (!db.messages.some((message) => message.id === result.message.id)) db.messages.push(result.message);
      renderWorkspace();
      document.querySelector('#message-form input')?.focus();
    } catch (error) {
      notify(error.message);
    }
  }
});

dialog.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = new FormData(form);

  if (form.id === 'channel-form') {
    if (!canManage()) return;
    const channelId = form.dataset.id;
    const name = String(data.get('name') || '').trim().replace(/\s+/g, '-').toLowerCase();
    const category = String(data.get('category') || '').trim().toUpperCase();
    const type = data.get('type') === 'voice' ? 'voice' : 'text';
    if (!name || !category) return;
    const existing = db.channels.find((entry) => entry.id === channelId);
    try {
      const result = await api(existing ? `/api/channels/${encodeURIComponent(channelId)}` : '/api/channels', {
        method: existing ? 'PATCH' : 'POST',
        body: JSON.stringify({ name, category, type }),
      });
      applyState(result.state);
      dialog.close();
      renderWorkspace();
      notify(existing ? 'Channel updated.' : `#${name} was created.`);
    } catch (error) {
      notify(error.message);
    }
  } else if (form.id === 'roles-form') {
    if (!canManage()) return;
    const roles = [];
    for (const role of db.roles) {
      const name = String(data.get(`name-${role.id}`) || '').trim();
      if (!name) {
        notify('Role names cannot be empty.');
        return;
      }
      const color = String(data.get(`color-${role.id}`) || role.color);
      roles.push({ id: role.id, name: name.slice(0, 24), color, canManage: role.id !== 'admin' && data.get(`manage-${role.id}`) === 'on' });
    }
    try {
      const result = await api('/api/roles', { method: 'PUT', body: JSON.stringify({ roles }) });
      applyState(result.state);
      dialog.close();
      renderWorkspace();
      notify('Role settings saved.');
    } catch (error) {
      notify(error.message);
    }
  } else if (form.id === 'settings-form') {
    if (!canManage()) return;
    const name = String(data.get('name') || '').trim();
    if (!name) {
      notify('The server needs a name.');
      return;
    }
    const file = data.get('icon');
    try {
      const iconData = file instanceof File && file.size ? await imageAsDataUrl(file) : '';
      const result = await api('/api/server', {
        method: 'PUT',
        body: JSON.stringify({ name: name.slice(0, 32), description: String(data.get('description') || '').trim().slice(0, 120), icon: iconData || db.server.icon }),
      });
      applyState(result.state);
      dialog.close();
      renderWorkspace();
      notify('Server settings saved.');
    } catch (error) {
      notify(error.message);
    }
  } else if (form.id === 'member-role-form') {
    if (!canManage()) return;
    const role = db.roles.find((entry) => entry.id === data.get('roleId') && entry.id !== 'admin');
    const user = db.users.find((entry) => entry.id === form.dataset.id);
    if (!user || user.id === db.ownerId || !role) return;
    try {
      const result = await api(`/api/members/${encodeURIComponent(user.id)}/role`, { method: 'PATCH', body: JSON.stringify({ roleId: role.id }) });
      applyState(result.state);
      dialog.close();
      renderWorkspace();
      notify(`${user.username} is now ${role.name}.`);
    } catch (error) {
      notify(error.message);
    }
  }
});

dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

renderAuth();
api('/api/state')
  .then((result) => {
    applyState(result.state);
    renderWorkspace();
  })
  .catch((error) => {
    if (!error.message.includes('Sign in')) notify(error.message);
  });