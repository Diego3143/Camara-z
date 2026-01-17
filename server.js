/**
 * SecureStream - Servidor de Vigilancia Remota
 * Sistema de vigilancia con envío de imágenes en tiempo real
 * 
 * Características:
 * - Transmisión de frames JPEG vía Socket.io
 * - Detección de movimiento inteligente
 * - Autenticación con contraseña
 * - Gestión de sesiones cámara-espectador
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Configuración del servidor
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'secure123';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Middleware para servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Almacenamiento de estado de conexiones
const connections = new Map();

/**
 * Busca una cámara disponible para conectar
 */
function findAvailableCamera() {
    for (const [socketId, data] of connections.entries()) {
        if (data.role === 'camera' && data.status === 'ready' && !data.connectedTo) {
            return socketId;
        }
    }
    return null;
}

/**
 * Busca un espectador pendiente sin cámara
 */
function findWaitingSpectator() {
    for (const [socketId, data] of connections.entries()) {
        if (data.role === 'spectator' && data.status === 'searching' && !data.connectedTo) {
            return socketId;
        }
    }
    return null;
}

/**
 * Manejador de conexiones Socket.io
 */
io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Cliente conectado: ${socket.id}`);
    
    // Inicializar estado del socket
    connections.set(socket.id, {
        role: null,
        status: 'disconnected',
        connectedTo: null,
        socket: socket
    });

    /**
     * Evento: Cliente intenta autenticarse
     */
    socket.on('authenticate', (password) => {
        const isValid = password === APP_PASSWORD;
        console.log(`[AUTH] Cliente ${socket.id}: ${isValid ? 'AUTORIZADO' : 'FALLIDO'}`);
        socket.emit('authResult', { success: isValid });
    });

    /**
     * Evento: Cliente se registra como cámara
     */
    socket.on('registerAsCamera', () => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        conn.role = 'camera';
        conn.status = 'registered';
        
        console.log(`[CAM] Cámara registrada: ${socket.id}`);
        socket.emit('cameraRegistered', { 
            message: 'Cámara registrada exitosamente'
        });

        // Buscar si hay espectadores esperando
        const spectatorSocketId = findWaitingSpectator();
        if (spectatorSocketId) {
            console.log(`[CAM] Espectador esperando encontrado, conectando...`);
            connectCameraToSpectator(socket.id, spectatorSocketId);
        } else {
            console.log(`[CAM] No hay espectadores esperando, esperando...`);
            // Notificar a todos los espectadores que hay una nueva cámara
            broadcastToRole('spectator', 'cameraAvailable', { 
                cameraId: socket.id 
            });
        }
    });

    /**
     * Evento: Cámara lista para transmitir
     */
    socket.on('cameraReady', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        conn.status = 'ready';
        console.log(`[CAM] Cámara ${socket.id} LISTA PARA TRANSMITIR`);

        // Buscar espectadores esperando
        const spectatorSocketId = findWaitingSpectator();
        if (spectatorSocketId) {
            console.log(`[CAM] Espectador esperando, conectando...`);
            connectCameraToSpectator(socket.id, spectatorSocketId);
        } else {
            // Notificar a todos los espectadores
            console.log(`[CAM] Notificando a espectadores...`);
            broadcastToRole('spectator', 'cameraAvailable', { 
                cameraId: socket.id 
            });
        }
    });

    /**
     * Evento: Cliente se registra como espectador
     */
    socket.on('registerAsSpectator', () => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        conn.role = 'spectator';
        conn.status = 'searching';
        
        console.log(`[VIEW] Espectador ${socket.id} buscando cámara...`);

        // Buscar cámara disponible
        const cameraSocketId = findAvailableCamera();
        
        if (cameraSocketId) {
            console.log(`[VIEW] Cámara encontrada ${cameraSocketId}, conectando...`);
            connectCameraToSpectator(cameraSocketId, socket.id);
        } else {
            console.log(`[VIEW] No hay cámaras disponibles`);
            socket.emit('noCameraAvailable', { 
                message: 'No hay cámaras disponibles' 
            });
        }
    });

    /**
     * Evento: Frame de video recibido de la cámara
     * Reenvía inmediatamente al espectador conectado
     */
    socket.on('stream_frame', (data) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        // Reenviar frame al espectador conectado
        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                // Usar volatile para no acumular frames si hay latencia
                targetConn.socket.volatile.emit('video_frame', {
                    image: data.image,
                    timestamp: data.timestamp,
                    frameNumber: data.frameNumber
                });
            }
        }
    });

    /**
     * Evento: Datos de movimiento detectados
     */
    socket.on('motionDetected', (data) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.emit('motionAlert', {
                    timestamp: Date.now(),
                    score: data.score,
                    regions: data.regions,
                    blobs: data.blobs // Blobs detectados para filtrado inteligente
                });
            }
        }
    });

    /**
     * Evento: Control de linterna
     */
    socket.on('toggleFlashlight', (enabled) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.emit('flashlightStatus', { enabled });
            }
        }
    });

    /**
     * Evento: Cambio de estado de detección de movimiento
     */
    socket.on('motionStatusChange', (enabled) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.emit('cameraMotionStatus', { enabled });
            }
        }
    });

    /**
     * Eventos de control remoto
     */
    socket.on('spectatorToggleFlashlight', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            cameraConn.socket.emit('remoteFlashlightToggle');
        }
    });

    socket.on('spectatorToggleMotion', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            cameraConn.socket.emit('remoteMotionToggle');
        }
    });

    socket.on('spectatorSetQuality', (data) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            cameraConn.socket.emit('remoteQualityChange', data);
        }
    });

    socket.on('spectatorRequestStatus', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            cameraConn.socket.emit('requestCameraStatus');
        }
    });

    socket.on('cameraStatusResponse', (status) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.emit('cameraStatusUpdate', status);
            }
        }
    });

    /**
     * Evento: Desconexión
     */
    socket.on('disconnect', () => {
        console.log(`[${new Date().toISOString()}] Cliente desconectado: ${socket.id}`);
        
        const conn = connections.get(socket.id);
        if (conn) {
            handlePeerDisconnection(socket.id);
            connections.delete(socket.id);
        }
    });
});

/**
 * Conecta una cámara a un espectador
 */
function connectCameraToSpectator(cameraSocketId, spectatorSocketId) {
    const cameraConn = connections.get(cameraSocketId);
    const spectatorConn = connections.get(spectatorSocketId);

    if (!cameraConn || !spectatorConn) {
        console.log(`[CONNECT] ERROR: No se pudo encontrar cámara=${!!cameraConn} espectador=${!!spectatorConn}`);
        return;
    }

    // Actualizar estados
    cameraConn.status = 'connecting';
    cameraConn.connectedTo = spectatorSocketId;
    spectatorConn.status = 'connecting';
    spectatorConn.connectedTo = cameraSocketId;

    console.log(`[CONNECT] 🔗 Cámara ${cameraSocketId} <-> Espectador ${spectatorSocketId}`);

    // Notificar a ambos peers
    cameraConn.socket.emit('connectionInitiated', {
        peerId: spectatorSocketId,
        role: 'camera'
    });

    spectatorConn.socket.emit('connectionInitiated', {
        peerId: cameraSocketId,
        role: 'spectator'
    });
}

/**
 * Maneja la desconexión de un peer
 */
function handlePeerDisconnection(socketId) {
    const conn = connections.get(socketId);
    if (!conn) return;

    if (conn.connectedTo) {
        const peerConn = connections.get(conn.connectedTo);
        if (peerConn && peerConn.socket) {
            peerConn.socket.emit('peerDisconnected', { reason: 'Peer desconectado' });
            peerConn.status = 'searching';
            peerConn.connectedTo = null;
        }
    }

    // Si era una cámara, buscar nueva cámara para el espectador
    if (conn.role === 'camera') {
        const newCameraId = findAvailableCamera();
        if (newCameraId) {
            const spectatorConn = connections.get(conn.connectedTo);
            if (spectatorConn) {
                connectCameraToSpectator(newCameraId, spectatorConn.socket.id);
            }
        } else {
            broadcastToRole('spectator', 'noCameraAvailable', {
                message: 'Cámara desconectada'
            });
        }
    }

    conn.connectedTo = null;
}

/**
 * Maneja cuando peers se conectan exitosamente
 */
function handlePeerConnected(socketId) {
    const conn = connections.get(socketId);
    if (!conn) return;

    console.log(`[CONNECT] ✅ Conexión establecida: ${socketId} <-> ${conn.connectedTo}`);
    
    if (conn.connectedTo) {
        const peerConn = connections.get(conn.connectedTo);
        if (peerConn && peerConn.socket) {
            peerConn.socket.emit('peerConnected', { message: 'Conexión establecida' });
        }
    }
}

/**
 * Envía un mensaje a todos los clientes con un rol específico
 */
function broadcastToRole(role, event, data) {
    let count = 0;
    for (const [socketId, conn] of connections.entries()) {
        if (conn.role === role && conn.socket) {
            conn.socket.emit(event, data);
            count++;
        }
    }
    console.log(`[BROADCAST] ${event} -> ${count} ${role}(s)`);
}

// Endpoints
app.get('/api/status', (req, res) => {
    const cameras = [];
    const spectators = [];
    
    for (const [socketId, conn] of connections.entries()) {
        if (conn.role === 'camera') {
            cameras.push({ id: socketId, status: conn.status, connectedTo: conn.connectedTo });
        } else if (conn.role === 'spectator') {
            spectators.push({ id: socketId, status: conn.status, connectedTo: conn.connectedTo });
        }
    }
    
    res.json({
        status: 'online',
        uptime: process.uptime(),
        cameras: cameras,
        spectators: spectators
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Iniciar servidor
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║       SecureStream - Servidor de Vigilancia    ║
╠════════════════════════════════════════════════╣
║  Puerto: ${PORT}                                    ║
║  Password: ${APP_PASSWORD}                          ║
║  Estado: EJECUTANDO                             ║
║  Modo: Envío de Frames (simulación video)      ║
╚════════════════════════════════════════════════╝
    `);
});

process.on('uncaughtException', (err) => {
    console.error('Error:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Rechazo:', reason);
});
