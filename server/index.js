import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Store active rooms and connections
const rooms = new Map();
const cameras = new Map();
const monitors = new Map();

// Generate room code
app.get('/api/generate-room', (req, res) => {
  const roomCode = uuidv4().substring(0, 6).toUpperCase();
  rooms.set(roomCode, {
    created: Date.now(),
    camera: null,
    monitors: [],
    babyStatus: 'unknown',
    lastAnalysis: null
  });
  res.json({ roomCode });
});

// Check room exists
app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (room) {
    res.json({ 
      exists: true, 
      hasCamera: !!room.camera,
      monitorCount: room.monitors.length 
    });
  } else {
    res.json({ exists: false });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Camera joins room
  socket.on('camera-join', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room tidak ditemukan' });
      return;
    }

    socket.join(roomCode);
    room.camera = socket.id;
    cameras.set(socket.id, roomCode);

    console.log(`Camera joined room: ${roomCode}`);
    socket.emit('camera-joined', { roomCode });
    
    // Notify monitors that camera is online
    socket.to(roomCode).emit('camera-online');
  });

  // Monitor joins room
  socket.on('monitor-join', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room tidak ditemukan' });
      return;
    }

    socket.join(roomCode);
    room.monitors.push(socket.id);
    monitors.set(socket.id, roomCode);

    console.log(`Monitor joined room: ${roomCode}`);
    socket.emit('monitor-joined', { 
      roomCode,
      cameraOnline: !!room.camera,
      babyStatus: room.babyStatus
    });

    // Request camera to send offer
    if (room.camera) {
      io.to(room.camera).emit('monitor-connected', { monitorId: socket.id });
    }
  });

  // WebRTC Signaling
  socket.on('offer', ({ offer, targetId }) => {
    console.log(`Offer from ${socket.id} to ${targetId}`);
    io.to(targetId).emit('offer', { offer, senderId: socket.id });
  });

  socket.on('answer', ({ answer, targetId }) => {
    console.log(`Answer from ${socket.id} to ${targetId}`);
    io.to(targetId).emit('answer', { answer, senderId: socket.id });
  });

  socket.on('ice-candidate', ({ candidate, targetId }) => {
    io.to(targetId).emit('ice-candidate', { candidate, senderId: socket.id });
  });

  // Baby status update
  socket.on('baby-status-update', ({ roomCode, status, confidence, notes, imageData }) => {
    const room = rooms.get(roomCode);
    if (room) {
      const previousStatus = room.babyStatus;
      room.babyStatus = status;
      room.lastAnalysis = {
        status,
        confidence,
        notes,
        timestamp: Date.now()
      };

      // Broadcast to all monitors in the room
      socket.to(roomCode).emit('baby-status-changed', {
        status,
        confidence,
        notes,
        previousStatus,
        timestamp: Date.now(),
        imageSnapshot: imageData
      });

      console.log(`Baby status updated in ${roomCode}: ${status}`);
    }
  });

  // Two-way audio
  socket.on('audio-data', ({ roomCode, audioData }) => {
    socket.to(roomCode).emit('audio-data', { audioData, senderId: socket.id });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    // Check if it was a camera
    if (cameras.has(socket.id)) {
      const roomCode = cameras.get(socket.id);
      const room = rooms.get(roomCode);
      if (room) {
        room.camera = null;
        socket.to(roomCode).emit('camera-offline');
      }
      cameras.delete(socket.id);
    }

    // Check if it was a monitor
    if (monitors.has(socket.id)) {
      const roomCode = monitors.get(socket.id);
      const room = rooms.get(roomCode);
      if (room) {
        room.monitors = room.monitors.filter(id => id !== socket.id);
      }
      monitors.delete(socket.id);
    }
  });
});

// Cleanup old rooms every hour
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [code, room] of rooms.entries()) {
    if (room.created < oneHourAgo && !room.camera && room.monitors.length === 0) {
      rooms.delete(code);
      console.log(`Cleaned up room: ${code}`);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Baby Monitor Server running on port ${PORT}`);
});
