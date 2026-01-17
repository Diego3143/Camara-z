const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración
const CONFIG = {
  port: process.env.PORT || 3000,
  defaultPassword: 'seguridad2024'
};

// Almacenamiento en memoria
const rooms = new Map();
const sockets = new Map();

function generateRoomId(password) {
  // Generar un ID de room basado en el hash de la contraseña
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'room_' + Math.abs(hash).toString(16);
}

function getRoomByPassword(password) {
  const roomId = generateRoomId(password);
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      password: password,
      camera: null,
      viewers: [],
      createdAt: new Date()
    });
  }
  return rooms.get(roomId);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

// API Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/config', (req, res) => {
  res.json({
    version: '1.0.0',
    features: {
      motionDetection: true,
      autoFlashlight: true,
      manualFlashlight: true,
      multiViewer: true
    }
  });
});

// Socket.io Signaling
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  sockets.set(socket.id, socket);

  let currentRoom = null;
  let clientRole = null;
  let clientPassword = null;

  // Unirse a una sala
  socket.on('join', (data) => {
    const { password, role } = data;
    clientPassword = password;
    clientRole = role;

    const room = getRoomByPassword(password);
    currentRoom = room;

    // Unir socket a la sala
    socket.join(room.id);
    socket.roomId = room.id;
    socket.role = role;

    console.log(`${role} conectado a sala ${room.id}`);

    if (role === 'camera') {
      // Si ya hay una cámara, desconectarla
      if (room.camera && room.camera.socketId !== socket.id) {
        const oldCameraSocket = sockets.get(room.camera.socketId);
        if (oldCameraSocket) {
          oldCameraSocket.emit('disconnected', { reason: 'Nueva cámara conectada' });
          oldCameraSocket.disconnect(true);
        }
      }
      room.camera = {
        socketId: socket.id,
        connectedAt: new Date(),
        settings: { autoFlashlight: true }
      };
    } else if (role === 'viewer') {
      room.viewers.push({
        socketId: socket.id,
        connectedAt: new Date()
      });
    }

    // Notificar al cliente que se unió
    socket.emit('joined', {
      success: true,
      roomId: room.id,
      role: role,
      hasCamera: !!room.camera,
      viewerCount: room.viewers.length
    });

    // Si es espectador y hay cámara, iniciar conexión WebRTC
    if (role === 'viewer' && room.camera) {
      socket.emit('camera_available', {
        cameraId: room.camera.socketId
      });
    }

    // Notificar a la cámara si hay nuevos espectadores
    if (role === 'viewer' && room.camera) {
      const cameraSocket = sockets.get(room.camera.socketId);
      if (cameraSocket) {
        cameraSocket.emit('viewer_count', { count: room.viewers.length });
      }
    }
  });

  // WebRTC Signaling - EL ESPECTADOR INICIA LA CONEXCIÓN
  socket.on('webrtc_offer', (data) => {
    // El espectador envía oferta a la cámara
    const { targetSocketId, offer } = data;
    const targetSocket = sockets.get(targetSocketId);
    
    if (targetSocket) {
      targetSocket.emit('webrtc_offer', {
        fromSocketId: socket.id,
        offer: offer
      });
      console.log(`Oferta WebRTC enviada de ${socket.id} a ${targetSocketId}`);
    } else {
      console.error(`No se encontró socket ${targetSocketId} para enviar oferta`);
    }
  });

  socket.on('webrtc_answer', (data) => {
    // La cámara responde al espectador
    const { targetSocketId, answer } = data;
    const targetSocket = sockets.get(targetSocketId);
    
    if (targetSocket) {
      targetSocket.emit('webrtc_answer', {
        fromSocketId: socket.id,
        answer: answer
      });
    }
  });

  socket.on('ice_candidate', (data) => {
    const { targetSocketId, candidate } = data;
    const targetSocket = sockets.get(targetSocketId);
    
    if (targetSocket) {
      targetSocket.emit('ice_candidate', {
        fromSocketId: socket.id,
        candidate: candidate
      });
    }
  });

  // Control de linterna desde espectador
  socket.on('toggle_flashlight', (data) => {
    if (!currentRoom || clientRole !== 'viewer') return;
    
    const { state } = data; // 'on' o 'off'
    
    if (currentRoom.camera) {
      const cameraSocket = sockets.get(currentRoom.camera.socketId);
      if (cameraSocket) {
        cameraSocket.emit('flashlight_control', { state: state });
        console.log(`Linterna ${state} desde espectador`);
      }
    }
  });

  // Cambiar configuración de la cámara
  socket.on('update_camera_settings', (data) => {
    if (!currentRoom || clientRole !== 'camera') return;
    
    const { autoFlashlight } = data;
    if (currentRoom.camera) {
      currentRoom.camera.settings.autoFlashlight = autoFlashlight;
    }
  });

  // Datos de telemetría desde cámara
  socket.on('telemetry', (data) => {
    if (!currentRoom || clientRole !== 'camera') return;
    
    const { motionScore, brightness, fps } = data;
    
    // Reenviar a todos los espectadores
    socket.to(currentRoom.id).emit('camera_telemetry', {
      motionScore,
      brightness,
      fps,
      timestamp: new Date()
    });
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
    sockets.delete(socket.id);

    if (currentRoom) {
      if (clientRole === 'camera') {
        currentRoom.camera = null;
        // Notificar a todos los espectadores
        io.to(currentRoom.id).emit('camera_disconnected');
        console.log(`Cámara desconectada de sala ${currentRoom.id}`);
      } else if (clientRole === 'viewer') {
        // Remover espectador
        currentRoom.viewers = currentRoom.viewers.filter(v => v.socketId !== socket.id);
        
        // Notificar a la cámara
        if (currentRoom.camera) {
          const cameraSocket = sockets.get(currentRoom.camera.socketId);
          if (cameraSocket) {
            cameraSocket.emit('viewer_count', { count: currentRoom.viewers.length });
          }
        }
        
        console.log(`Espectador desconectado. Quedan: ${currentRoom.viewers.length}`);
      }
    }
  });
});

// Limpiar salas vacías periódicamente
setInterval(() => {
  rooms.forEach((room, roomId) => {
    if (!room.camera && room.viewers.length === 0) {
      rooms.delete(roomId);
      console.log(`Sala ${roomId} eliminada por inactividad`);
    }
  });
}, 60000); // Cada minuto

// Iniciar servidor
server.listen(CONFIG.port, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   🔒 SecureStream - Sistema de Vigilancia Remota      ║
║                                                        ║
║   Servidor iniciado en puerto ${CONFIG.port}                  ║
║                                                        ║
║   Accede a: http://localhost:${CONFIG.port}                   ║
║                                                        ║
║   Características:                                     ║
║   • Streaming en tiempo real (WebRTC)                  ║
║   • Detección de movimiento                           ║
║   • Control automático de linterna                    ║
║   • Multi-espectador                                  ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  console.log('\nApagando servidor...');
  io.close();
  server.close();
  process.exit(0);
});
