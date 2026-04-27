/**
 * Behind the Truth — Real-time Multiplayer Server
 * Stage 12 · Node.js + Socket.io
 *
 * Deploy free on Railway: https://railway.app
 *   1. Create new project → Deploy from GitHub / "New Service" → paste this file
 *   2. Add package.json (included below as comments)
 *   3. Set environment variable PORT if needed (Railway auto-sets it)
 *
 * Or locally:  npm install && node server.js
 * Then in client HTML set SOCKET_SERVER_URL to 'http://localhost:3000'
 */

const http    = require('http');
const { Server } = require('socket.io');
const crypto  = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const ORIGINS = process.env.ALLOWED_ORIGINS || '*';  // tighten in production

// ─── Server setup ─────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, ts: Date.now() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Behind the Truth · Multiplayer Server · Stage 12');
});

const io = new Server(httpServer, {
  cors: {
    origin: ORIGINS,
    methods: ['GET', 'POST'],
  },
  pingTimeout:  30000,
  pingInterval: 10000,
});

// ─── Room store ───────────────────────────────────────────────────────────────
/**
 * rooms: Map<roomCode, Room>
 *
 * Room = {
 *   code:        string,          // 4-letter uppercase code
 *   hostId:      string,          // socket.id of host
 *   phase:       'lobby'|'roles'|'game'|'results',
 *   players:     Map<socketId, Player>,
 *   roles:       { interviewer?:socketId, expert?:socketId, witness?:socketId },
 *   scenario:    Array<Page>,     // sent from host after they built it
 *   gameState:   GameState,
 *   createdAt:   number,
 * }
 *
 * Player = { id, name, role, cp, correct, isHost }
 *
 * GameState = {
 *   pageIdx:     number,
 *   qIdx:        number,
 *   activeQId:   string,
 *   timerStart:  number,          // server timestamp ms
 *   answerPending: boolean,
 * }
 */
const rooms = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I O to avoid confusion
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  // Ensure unique
  return rooms.has(c) ? genCode() : c;
}

function getRoomOf(socketId) {
  for (const [code, room] of rooms) {
    if (room.players.has(socketId)) return { code, room };
  }
  return null;
}

function roomSnapshot(room) {
  return {
    code:    room.code,
    phase:   room.phase,
    hostId:  room.hostId,
    players: [...room.players.values()],
    roles:   room.roles,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomSnapshot(room));
}

// Clean up stale rooms older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < cutoff) {
      io.to(code).emit('room:expired');
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

// ─── Socket events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] connect  ${socket.id}`);

  // ── CREATE ROOM ─────────────────────────────────────────────────────────────
  socket.on('room:create', ({ playerName }) => {
    const code = genCode();
    const player = {
      id:      socket.id,
      name:    (playerName || 'Host').slice(0, 24),
      role:    null,
      cp:      0,
      correct: 0,
      isHost:  true,
    };
    const room = {
      code,
      hostId:    socket.id,
      phase:     'lobby',
      players:   new Map([[socket.id, player]]),
      roles:     {},
      scenario:  null,
      gameState: null,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room:created', { code, snapshot: roomSnapshot(room) });
    console.log(`[R] created  ${code}  host=${playerName}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────────────────
  socket.on('room:join', ({ code, playerName }) => {
    const upper = (code || '').toUpperCase().trim();
    const room  = rooms.get(upper);

    if (!room) {
      socket.emit('room:error', { msg: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('room:error', { msg: 'This game has already started.' });
      return;
    }
    if (room.players.size >= 3) {
      socket.emit('room:error', { msg: 'Room is full (max 3 players).' });
      return;
    }

    const player = {
      id:      socket.id,
      name:    (playerName || 'Guest').slice(0, 24),
      role:    null,
      cp:      0,
      correct: 0,
      isHost:  false,
    };
    room.players.set(socket.id, player);
    socket.join(upper);
    socket.emit('room:joined', { code: upper, snapshot: roomSnapshot(room) });
    broadcastRoom(room);
    console.log(`[R] joined   ${upper}  player=${playerName}`);
  });

  // ── ROLE SELECT ──────────────────────────────────────────────────────────────
  socket.on('role:claim', ({ role }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;
    if (room.phase !== 'lobby' && room.phase !== 'roles') return;

    // Already taken by someone else?
    if (room.roles[role] && room.roles[role] !== socket.id) {
      socket.emit('room:error', { msg: 'That role was just taken. Choose another.' });
      return;
    }

    // Clear any previous role this socket held
    for (const [r, sid] of Object.entries(room.roles)) {
      if (sid === socket.id) delete room.roles[r];
    }

    room.roles[role] = socket.id;
    room.phase = 'roles';
    const player = room.players.get(socket.id);
    if (player) player.role = role;

    broadcastRoom(room);
  });

  socket.on('role:leave', () => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;
    for (const [r, sid] of Object.entries(room.roles)) {
      if (sid === socket.id) {
        delete room.roles[r];
        const player = room.players.get(socket.id);
        if (player) player.role = null;
      }
    }
    broadcastRoom(room);
  });

  // ── OPEN ROLE SCREEN FOR ALL PLAYERS (host only) ────────────────────────────
  socket.on('game:roles_open', ({ scenario }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;

    if (socket.id !== room.hostId) {
      socket.emit('room:error', { msg: 'Only the host can open role selection.' });
      return;
    }

    // Store scenario on room for later use at game:start
    room.pendingScenario = scenario;
    room.phase = 'roles';

    // Broadcast to ALL players in room — everyone navigates to role screen
    io.to(room.code).emit('game:roles_open', {
      scenario: scenario,
      players:  [...room.players.values()],
    });

    console.log(`[G] roles_open  ${room.code}`);
  });

  // ── START GAME (host only) ───────────────────────────────────────────────────
  socket.on('game:start', ({ scenario }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;

    if (socket.id !== room.hostId) {
      socket.emit('room:error', { msg: 'Only the host can start the game.' });
      return;
    }

    const allRolesSet = ['interviewer','expert','witness'].every(r => room.roles[r]);
    if (!allRolesSet) {
      socket.emit('room:error', { msg: 'All three roles must be assigned before starting.' });
      return;
    }

    room.phase    = 'game';
    room.scenario = scenario || room.pendingScenario;

    // Reset scores
    room.players.forEach(p => { p.cp = 0; p.correct = 0; });

    // Assign roles to player objects
    for (const [role, sid] of Object.entries(room.roles)) {
      const p = room.players.get(sid);
      if (p) p.role = role;
    }

    room.gameState = {
      pageIdx:       0,
      qIdx:          0,
      activeQId:     null,
      timerStart:    null,
      answerPending: false,
    };

    io.to(room.code).emit('game:started', {
      scenario: room.scenario,
      players:  [...room.players.values()],
      roles:    room.roles,
    });

    console.log(`[G] started  ${room.code}`);
  });

  // ── QUESTION SELECTED (interviewer picks a question) ─────────────────────────
  socket.on('game:question', ({ qId, pageIdx, qIdx }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;
    if (room.phase !== 'game') return;

    // Only the interviewer can select questions
    if (room.roles.interviewer !== socket.id) return;

    room.gameState.activeQId     = qId;
    room.gameState.pageIdx       = pageIdx;
    room.gameState.qIdx          = qIdx;
    room.gameState.answerPending = true;
    room.gameState.timerStart    = Date.now();

    io.to(room.code).emit('game:question', {
      qId,
      pageIdx,
      qIdx,
      timerStart: room.gameState.timerStart,
    });

    console.log(`[G] question ${room.code}  q=${qId}`);
  });

  // ── ANSWER SUBMITTED ─────────────────────────────────────────────────────────
  socket.on('game:answer', ({ qId, optionIdx, timeTaken }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;
    if (room.phase !== 'game') return;
    if (!room.gameState.answerPending) return;
    if (room.gameState.activeQId !== qId) return;

    // Find the question in the scenario to check correctness
    const page = room.scenario?.[room.gameState.pageIdx];
    const q    = page?.questions?.[room.gameState.qIdx];
    if (!q) return;

    const isCorrect = optionIdx === q.correctIdx;
    const isFast    = timeTaken !== undefined && timeTaken < 5000;
    const isSilly   = !isCorrect && optionIdx >= 2;

    // Calculate CP
    let delta = 0;
    if (isCorrect)            delta = isFast ? 150 : 100;  // +50 fast bonus included
    else if (isSilly)         delta = -300;
    else                      delta = -150;

    // Update score
    const player = room.players.get(socket.id);
    if (player) {
      player.cp      = (player.cp || 0) + delta;
      player.correct = (player.correct || 0) + (isCorrect ? 1 : 0);
    }

    room.gameState.answerPending = false;

    io.to(room.code).emit('game:answered', {
      socketId:  socket.id,
      qId,
      optionIdx,
      isCorrect,
      isFast,
      isSilly,
      delta,
      players:   [...room.players.values()],
    });

    console.log(`[G] answer   ${room.code}  q=${qId}  correct=${isCorrect}  delta=${delta}`);
  });

  // ── TIMER EXPIRED (client reports dead air) ──────────────────────────────────
  socket.on('game:timeout', ({ qId }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;
    if (!room.gameState?.answerPending) return;
    if (room.gameState.activeQId !== qId) return;

    // Find who should have answered
    const page = room.scenario?.[room.gameState.pageIdx];
    const q    = page?.questions?.[room.gameState.qIdx];
    const respRole = q?.answer?.role;
    const respSid  = respRole ? room.roles[respRole] : null;
    const player   = respSid  ? room.players.get(respSid) : null;

    if (player) player.cp = (player.cp || 0) - 75;

    room.gameState.answerPending = false;

    io.to(room.code).emit('game:timeout', {
      qId,
      respSocketId: respSid,
      players:      [...room.players.values()],
    });

    console.log(`[G] timeout  ${room.code}  q=${qId}`);
  });

  // ── PAGE TURN ────────────────────────────────────────────────────────────────
  socket.on('game:page_turn', ({ pageIdx }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;
    if (room.roles.interviewer !== socket.id) return;

    room.gameState.pageIdx = pageIdx;
    room.gameState.qIdx    = 0;

    io.to(room.code).emit('game:page_turn', { pageIdx });
  });

  // ── GAME OVER ────────────────────────────────────────────────────────────────
  socket.on('game:over', () => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { room } = found;
    if (socket.id !== room.hostId && room.roles.interviewer !== socket.id) return;

    room.phase = 'results';

    io.to(room.code).emit('game:over', {
      players: [...room.players.values()],
    });

    console.log(`[G] over     ${room.code}`);
  });

  // ── REACTION (emoji / applause button) ──────────────────────────────────────
  socket.on('react', ({ emoji }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const player = found.room.players.get(socket.id);
    socket.to(found.code).emit('react', { name: player?.name || '?', emoji });
  });

  // ── CHAT / VOICE TEXT ────────────────────────────────────────────────────────
  socket.on('chat', ({ text }) => {
    const found = getRoomOf(socket.id);
    if (!found) return;
    const player = found.room.players.get(socket.id);
    io.to(found.code).emit('chat', {
      name: player?.name || '?',
      role: player?.role || '—',
      text: (text || '').slice(0, 160),
    });
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] disconn  ${socket.id}`);
    const found = getRoomOf(socket.id);
    if (!found) return;
    const { code, room } = found;

    room.players.delete(socket.id);

    // Clear role
    for (const [r, sid] of Object.entries(room.roles)) {
      if (sid === socket.id) delete room.roles[r];
    }

    // If no players left, delete room
    if (room.players.size === 0) {
      rooms.delete(code);
      console.log(`[R] deleted  ${code}  (empty)`);
      return;
    }

    // If host left, promote oldest remaining player
    if (room.hostId === socket.id) {
      const newHost = room.players.values().next().value;
      room.hostId = newHost.id;
      newHost.isHost = true;
      io.to(room.code).emit('room:host_changed', { newHostId: newHost.id });
    }

    io.to(room.code).emit('room:player_left', { socketId: socket.id });
    broadcastRoom(room);
  });

  // ── PING (keep-alive) ────────────────────────────────────────────────────────
  socket.on('ping', () => socket.emit('pong', { ts: Date.now() }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n🎬 Behind the Truth — Multiplayer Server`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});q
