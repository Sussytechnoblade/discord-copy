const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const ROOT = __dirname;
const DATA_FILE = process.env.PUSDSMP_DATA_FILE || path.join(ROOT, 'data', 'pusdsmp.json');
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = 'pusdsmp_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt);
const voiceRooms = new Map();
const clients = new Map();
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createDefaultDb() {
  return {
    server: { name: 'PUSDSMP', description: 'A place for the PUSDSMP community.', icon: '' },
    ownerId: null,
    users: [],
    roles: [
      { id: 'admin', name: 'Admin', color: '#b8f36b', canManage: true },
      { id: 'member', name: 'Member', color: '#a9b3aa', canManage: false },
    ],
    channels: [
      { id: 'welcome', name: 'welcome', category: 'START HERE', type: 'text' },
      { id: 'announcements', name: 'announcements', category: 'START HERE', type: 'text' },
      { id: 'general', name: 'general', category: 'THE SERVER', type: 'text' },
      { id: 'screenshots', name: 'screenshots', category: 'THE SERVER', type: 'text' },
      { id: 'lobby', name: 'lobby', category: 'VOICE ROOMS', type: 'voice' },
    ],
    messages: [],
    sessions: {},
  };
}

let db = createDefaultDb();
let saveQueue = Promise.resolve();

async function loadDb() {
  try {
    const saved = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    db = { ...createDefaultDb(), ...saved, server: { ...createDefaultDb().server, ...saved.server } };
    if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persistDb();
  }
}

function persistDb() {
  const snapshot = JSON.stringify(db, null, 2);
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, snapshot, { mode: 0o600 });
    await fs.rename(temporaryFile, DATA_FILE);
  });
  return saveQueue;
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(data));
}

function readJson(request, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON request.'));
      }
    });
    request.on('error', reject);
  });
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  return (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || '';
}

function sessionFor(request) {
  const token = cookieValue(request, COOKIE_NAME);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const key = createHash('sha256').update(token).digest('hex');
  const session = db.sessions[key];
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = db.users.find((entry) => entry.id === session.userId);
  return user ? { user, key } : null;
}

function cookieHeader(request, token, maxAge) {
  const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function createSession(request, response, user) {
  const token = randomBytes(32).toString('hex');
  const key = createHash('sha256').update(token).digest('hex');
  db.sessions[key] = { userId: user.id, expiresAt: Date.now() + SESSION_TTL };
  await persistDb();
  response.setHeader('set-cookie', cookieHeader(request, token, SESSION_TTL / 1000));
}

function publicState(user) {
  return {
    currentUserId: user.id,
    ownerId: db.ownerId,
    server: db.server,
    users: db.users.map(({ id, username, roleId }) => ({ id, username, roleId })),
    roles: db.roles,
    channels: db.channels,
    messages: db.messages.slice(-1000),
  };
}

function canManage(user) {
  if (user.id === db.ownerId) return true;
  const role = db.roles.find((entry) => entry.id === user.roleId);
  return Boolean(role?.canManage);
}

function requireManager(user) {
  if (!canManage(user)) throw new HttpError(403, 'You do not have permission to manage this server.');
}

function validColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function validateUsername(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_ -]{2,24}$/u.test(value.trim());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageMentions(text) {
  const everyone = /(?<![\p{L}\p{N}_@])@everyone(?![\p{L}\p{N}_])/iu.test(text);
  const roles = db.roles
    .filter((role) => new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRegExp(role.name)}(?![\\p{L}\\p{N}_])`, 'iu').test(text))
    .map((role) => role.id);
  return { everyone, roles };
}

async function hashPassword(password, salt = randomBytes(16)) {
  const derived = await scryptAsync(password, salt, 64);
  return { passwordHash: derived.toString('hex'), passwordSalt: salt.toString('hex') };
}

async function passwordMatches(password, user) {
  const salt = Buffer.from(user.passwordSalt, 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = await scryptAsync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function broadcast(data, except) {
  const payload = JSON.stringify(data);
  for (const client of webSockets.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function sendSocket(client, data) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
}

function leaveVoice(client) {
  const channelId = client.voiceChannelId;
  if (!channelId) return;
  const room = voiceRooms.get(channelId);
  room?.delete(client.clientId);
  client.voiceChannelId = null;
  if (room?.size) {
    for (const peer of room.values()) sendSocket(peer, { type: 'voice:user-left', userId: client.clientId });
  } else {
    voiceRooms.delete(channelId);
  }
}

function sendSocketError(client, message) {
  sendSocket(client, { type: 'error', message });
}

function handleSocketMessage(client, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    sendSocketError(client, 'Invalid realtime message.');
    return;
  }

  if (message.type === 'voice:join') {
    const channel = db.channels.find((entry) => entry.id === message.channelId && entry.type === 'voice');
    if (!channel) return sendSocketError(client, 'That voice room does not exist.');
    leaveVoice(client);
    let room = voiceRooms.get(channel.id);
    if (!room) voiceRooms.set(channel.id, room = new Map());
    const peers = [...room.values()].map((peer) => ({ id: peer.clientId, username: peer.user.username }));
    room.set(client.clientId, client);
    client.voiceChannelId = channel.id;
    sendSocket(client, { type: 'voice:peers', channelId: channel.id, peers });
    for (const peer of room.values()) {
      if (peer !== client) sendSocket(peer, { type: 'voice:user-joined', channelId: channel.id, user: { id: client.clientId, username: client.user.username } });
    }
    return;
  }

  if (message.type === 'voice:leave') {
    leaveVoice(client);
    return;
  }

  if (message.type === 'voice:signal') {
    const target = clients.get(message.targetId);
    const allowedTypes = new Set(['offer', 'answer', 'candidate']);
    if (!target || !client.voiceChannelId || target.voiceChannelId !== client.voiceChannelId || !allowedTypes.has(message.signal?.type)) return;
    sendSocket(target, {
      type: 'voice:signal',
      channelId: client.voiceChannelId,
      fromId: client.clientId,
      username: client.user.username,
      signal: message.signal,
    });
  }
}

function setupWebSockets(server) {
  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host}`);
    } catch {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    let originAllowed = true;
    try {
      if (origin) originAllowed = new URL(origin).host === request.headers.host;
    } catch {
      originAllowed = false;
    }
    if (url.pathname !== '/realtime' || !originAllowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const session = sessionFor(request);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit('connection', client, request, session.user));
  });

  webSockets.on('connection', (client, _request, user) => {
    client.user = user;
    client.clientId = randomUUID();
    client.voiceChannelId = null;
    clients.set(client.clientId, client);
    client.on('message', (message) => handleSocketMessage(client, message));
    client.on('close', () => {
      leaveVoice(client);
      clients.delete(client.clientId);
    });
  });
}

async function handleApi(request, response, url) {
  const method = request.method;
  const route = url.pathname;

  if (route === '/api/auth/signup' && method === 'POST') {
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!validateUsername(username)) throw new HttpError(400, 'Use 2–24 letters, numbers, spaces, underscores, or hyphens.');
    if (password.length < 8 || password.length > 256) throw new HttpError(400, 'Password must be between 8 and 256 characters.');
    if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'That username is already in use.');
    const passwordData = await hashPassword(password);
    if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'That username is already in use.');
    const firstUser = db.users.length === 0;
    const user = { id: randomUUID(), username, ...passwordData, roleId: firstUser ? 'admin' : 'member' };
    db.users.push(user);
    if (firstUser) db.ownerId = user.id;
    await persistDb();
    await createSession(request, response, user);
    broadcast({ type: 'state:changed' });
    return sendJson(response, 201, { state: publicState(user) });
  }

  if (route === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.users.find((entry) => entry.username.toLowerCase() === username.toLowerCase());
    if (!user || !await passwordMatches(password, user)) throw new HttpError(401, 'That username and password combination didn’t match.');
    await createSession(request, response, user);
    return sendJson(response, 200, { state: publicState(user) });
  }

  if (route === '/api/auth/logout' && method === 'POST') {
    const session = sessionFor(request);
    if (session) {
      delete db.sessions[session.key];
      await persistDb();
      for (const client of webSockets.clients) {
        if (client.user.id === session.user.id) {
          leaveVoice(client);
          client.close(1008, 'Signed out');
        }
      }
    }
    return sendJson(response, 200, { ok: true }, { 'set-cookie': cookieHeader(request, '', 0) });
  }

  if (route === '/api/state' && method === 'GET') {
    const session = sessionFor(request);
    if (!session) throw new HttpError(401, 'Sign in to continue.');
    return sendJson(response, 200, { state: publicState(session.user) });
  }

  const session = sessionFor(request);
  if (!session) throw new HttpError(401, 'Sign in to continue.');
  const user = session.user;

  if (route === '/api/messages' && method === 'POST') {
    const body = await readJson(request, 16 * 1024);
    const channel = db.channels.find((entry) => entry.id === body.channelId && entry.type === 'text');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!channel || !text || text.length > 2000) throw new HttpError(400, 'Choose a text channel and a message under 2000 characters.');
    const mentions = messageMentions(text);
    if ((mentions.everyone || mentions.roles.length) && !canManage(user)) {
      throw new HttpError(403, 'Only server admins can mention @everyone or a role.');
    }
    const message = { id: randomUUID(), channelId: channel.id, userId: user.id, text, mentions, createdAt: new Date().toISOString() };
    db.messages.push(message);
    if (db.messages.length > 5000) db.messages.splice(0, db.messages.length - 5000);
    await persistDb();
    broadcast({ type: 'message', message });
    return sendJson(response, 201, { message });
  }

  if (route === '/api/server' && method === 'PUT') {
    requireManager(user);
    const body = await readJson(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 32) throw new HttpError(400, 'Server name must be 1–32 characters.');
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 120) : '';
    if (body.icon !== undefined && body.icon !== '' && (!/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(body.icon) || body.icon.length > 2_850_000)) {
      throw new HttpError(400, 'Choose a PNG, JPEG, WebP, or GIF image smaller than 2 MB.');
    }
    db.server = { name, description, icon: body.icon || db.server.icon || '' };
    await persistDb();
    broadcast({ type: 'state:changed' });
    return sendJson(response, 200, { state: publicState(user) });
  }

  if (route === '/api/channels' && method === 'POST') {
    requireManager(user);
    const body = await readJson(request, 16 * 1024);
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase().replace(/\s+/g, '-') : '';
    const category = typeof body.category === 'string' ? body.category.trim().toUpperCase() : '';
    const type = body.type === 'voice' ? 'voice' : 'text';
    if (!name || name.length > 40 || !category || category.length > 32) throw new HttpError(400, 'Channel name and category are required.');
    const channel = { id: randomUUID(), name, category, type };
    db.channels.push(channel);
    await persistDb();
    broadcast({ type: 'state:changed' });
    return sendJson(response, 201, { state: publicState(user) });
  }

  const channelMatch = route.match(/^\/api\/channels\/([^/]+)$/);
  if (channelMatch && method === 'PATCH') {
    requireManager(user);
    const channel = db.channels.find((entry) => entry.id === decodeURIComponent(channelMatch[1]));
    if (!channel) throw new HttpError(404, 'Channel not found.');
    const body = await readJson(request, 16 * 1024);
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase().replace(/\s+/g, '-') : '';
    const category = typeof body.category === 'string' ? body.category.trim().toUpperCase() : '';
    if (!name || name.length > 40 || !category || category.length > 32) throw new HttpError(400, 'Channel name and category are required.');
    Object.assign(channel, { name, category, type: body.type === 'voice' ? 'voice' : 'text' });
    await persistDb();
    broadcast({ type: 'state:changed' });
    return sendJson(response, 200, { state: publicState(user) });
  }

  if (channelMatch && method === 'DELETE') {
    requireManager(user);
    const channelId = decodeURIComponent(channelMatch[1]);
    if (db.channels.length <= 1) throw new HttpError(400, 'A server needs at least one channel.');
    const channel = db.channels.find((entry) => entry.id === channelId);
    if (!channel) throw new HttpError(404, 'Channel not found.');
    db.channels = db.channels.filter((entry) => entry.id !== channelId);
    db.messages = db.messages.filter((message) => message.channelId !== channelId);
    await persistDb();
    broadcast({ type: 'state:changed', deletedChannelId: channelId });
    return sendJson(response, 200, { state: publicState(user) });
  }

  if (route === '/api/roles' && method === 'POST') {
    requireManager(user);
    const body = await readJson(request, 16 * 1024);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 24) throw new HttpError(400, 'Role name must be 1–24 characters.');
    const role = { id: randomUUID(), name, color: validColor(body.color) ? body.color : '#f18a55', canManage: false };
    db.roles.push(role);
    await persistDb();
    broadcast({ type: 'state:changed' });
    return sendJson(response, 201, { state: publicState(user) });
  }

  if (route === '/api/roles' && method === 'PUT') {
    requireManager(user);
    const body = await readJson(request, 64 * 1024);
    if (!Array.isArray(body.roles)) throw new HttpError(400, 'Roles must be a list.');
    for (const incoming of body.roles) {
      const role = db.roles.find((entry) => entry.id === incoming.id);
      if (!role || typeof incoming.name !== 'string' || !incoming.name.trim() || incoming.name.length > 24) continue;
      role.name = incoming.name.trim();
      if (validColor(incoming.color)) role.color = incoming.color;
      if (role.id !== 'admin') role.canManage = Boolean(incoming.canManage);
    }
    await persistDb();
    broadcast({ type: 'state:changed' });
    return sendJson(response, 200, { state: publicState(user) });
  }

  const roleMatch = route.match(/^\/api\/roles\/([^/]+)$/);
  if (roleMatch && method === 'DELETE') {
    requireManager(user);
    const roleId = decodeURIComponent(roleMatch[1]);
    if (roleId === 'admin' || roleId === 'member') throw new HttpError(400, 'Built-in roles cannot be deleted.');
    const role = db.roles.find((entry) => entry.id === roleId);
    if (!role) throw new HttpError(404, 'Role not found.');
    db.roles = db.roles.filter((entry) => entry.id !== roleId);
    db.users.forEach((member) => { if (member.roleId === roleId) member.roleId = 'member'; });
    await persistDb();
    broadcast({ type: 'state:changed' });
    return sendJson(response, 200, { state: publicState(user) });
  }

  const memberMatch = route.match(/^\/api\/members\/([^/]+)\/role$/);
  if (memberMatch && method === 'PATCH') {
    requireManager(user);
    const member = db.users.find((entry) => entry.id === decodeURIComponent(memberMatch[1]));
    if (!member || member.id === db.ownerId) throw new HttpError(404, 'Member not found.');
    const body = await readJson(request, 16 * 1024);
    const role = db.roles.find((entry) => entry.id === body.roleId && entry.id !== 'admin');
    if (!role) throw new HttpError(400, 'Choose a valid member role.');
    member.roleId = role.id;
    await persistDb();
    broadcast({ type: 'state:changed' });
    return sendJson(response, 200, { state: publicState(user) });
  }

  throw new HttpError(404, 'API endpoint not found.');
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const file = staticFiles.get(url.pathname);
    if (!file) throw new HttpError(404, 'Not found.');
    const contents = await fs.readFile(path.join(ROOT, file[0]));
    response.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    if (!(error instanceof HttpError)) console.error(error);
    sendJson(response, error.status || 500, { error: error.status ? error.message : 'The server could not complete that request.' });
  }
}

async function start() {
  await loadDb();
  const server = http.createServer(handleRequest);
  setupWebSockets(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`PUSDSMP listening on http://localhost:${PORT}`);
    console.log(`Persistent data file: ${DATA_FILE}`);
  });
}

start().catch((error) => {
  console.error('Could not start PUSDSMP:', error);
  process.exitCode = 1;
});