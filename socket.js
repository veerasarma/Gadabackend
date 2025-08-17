// server/socket.js
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
      credentials: true
    }
  });

  io.use((socket, next) => {
    try {
      // token can come from query (?token=) or auth header in upgrade; keep it simple:
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('unauthorized'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: payload.userId };
      return next();
    } catch (e) { return next(new Error('unauthorized')); }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    // optional: emit backlog count on connect
  });

  io.on('disconnect', (r) => console.log('[server] disconnected', socket.id, r));

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { initSocket, getIO };
