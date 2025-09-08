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

       // ----- CALL SIGNALING (audio/video) -----
    // callee/caller both join the room so messages are scoped
    socket.on('call:join', ({ room }) => {
      console.log('calling here',room)
      if (!room) return;
      socket.join(room);
    });

    // caller sends offer → notify callee in their personal room
    socket.on('call:offer', ({ toUserId, conversationId, kind, room, callId, sdp }) => {
      // console.log('call:offer,',toUserId, conversationId, kind, room, callId, sdp)
      if (!toUserId || !room || !sdp) return;
      socket.join(room); // ensure caller is in the room too
      io.to(`user:${Number(toUserId)}`).emit('call:offer', {
        fromUserId: userId, conversationId, kind, room, callId, sdp
      });
    });

    // callee answers → only the peer in the room gets it
    socket.on('call:answer', ({ room, sdp, callId, kind, conversationId }) => {
      if (!room || !sdp) return;
      socket.to(room).emit('call:answer', { room, sdp, callId, kind, conversationId });
    });

    // ICE candidates both ways (room-scoped)
    socket.on('call:candidate', ({ room, candidate }) => {
      if (!room || !candidate) return;
      socket.to(room).emit('call:candidate', { room, candidate });
    });

    // hangup
    socket.on('call:end', ({ room }) => {
      if (!room) return;
      socket.to(room).emit('call:end', { room });
      socket.leave(room);
    });

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
