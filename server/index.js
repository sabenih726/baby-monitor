import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const server = createServer(app);

// CORS configuration untuk production
const allowedOrigins = [
  'https://your-camera-app.vercel.app',
  'https://your-monitor-app.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174'
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// Store active rooms and connections
const rooms = new Map();
const cameras = new Map();
const monitors = new Map();

// Health check endpoint (penting untuk Hugging Face)
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Baby Monitor Server is running!',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size
  });
});

// Health check untuk Hugging Face
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

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
  
  console.log(`Room created: ${roomCode}`);
  res.json({ roomCode });
});

// Check room exists
app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
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

// Get server stats
app.get('/api/stats', (req, res) => {
  res.json({
    activeRooms: rooms.size,
    activeCameras: cameras.size,
    activeMonitors: monitors.size,
    uptime: process.uptime()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Camera joins room
  socket.on('camera-join', ({ roomCode }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    
    if (!room) {
      socket.emit('error', { message: 'Room tidak ditemukan' });
      return;
    }

    socket.join(code);
    room.camera = socket.id;
    cameras.set(socket.id, code);

    console.log(`Camera joined room: ${code}`);
    socket.emit('camera-joined', { roomCode: code });
    
    // Notify monitors that camera is online
    socket.to(code).emit('camera-online');
  });

  // Monitor joins room
  socket.on('monitor-join', ({ roomCode }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    
    if (!room) {
      socket.emit('error', { message: 'Room tidak ditemukan' });
      return;
    }

    socket.join(code);
    room.monitors.push(socket.id);
    monitors.set(socket.id, code);

    console.log(`Monitor joined room: ${code}`);
    socket.emit('monitor-joined', { 
      roomCode: code,
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
  socket.on('baby-status-update', ({ roomCode, status, confidence, notes, position, alert, imageData }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    
    if (room) {
      const previousStatus = room.babyStatus;
      room.babyStatus = status;
      room.lastAnalysis = {
        status,
        confidence,
        notes,
        position,
        timestamp: Date.now()
      };

      // Broadcast to all monitors in the room
      socket.to(code).emit('baby-status-changed', {
        status,
        confidence,
        notes,
        position,
        alert,
        previousStatus,
        timestamp: Date.now(),
        imageSnapshot: imageData
      });

      console.log(`Baby status updated in ${code}: ${status} (${confidence}%)`);
    }
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

// Cleanup old rooms every 30 minutes
setInterval(() => {
  const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
  for (const [code, room] of rooms.entries()) {
    if (room.created < thirtyMinutesAgo && !room.camera && room.monitors.length === 0) {
      rooms.delete(code);
      console.log(`Cleaned up room: ${code}`);
    }
  }
}, 30 * 60 * 1000);

// Use PORT from environment (Hugging Face uses 7860)
const PORT = process.env.PORT || 7860;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Baby Monitor Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
