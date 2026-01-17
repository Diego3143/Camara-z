/**
 * SecureStream - Servidor de Vigilancia Remota
 * Sistema de videovigilancia con WebRTC y Socket.io
 * 
 * Características:
 * - Señalización robusta para conexiones WebRTC peer-to-peer
 * - Gestión de habitaciones para múltiples sesiones cámara-espectador
 * - Detección de movimiento y control de linterna
 * - Autenticación con contraseña
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
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
const rooms = new Map();

/**
 * Genera un ID de habitación único
 */
function generateRoomId() {
    return uuidv4().substring(0, 8).toUpperCase();
}

/**
 * Busca una habitación disponible para un espectador
 * Retorna null si no hay cámaras disponibles
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
 * Manejador de conexiones Socket.io
 */
io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Cliente conectado: ${socket.id}`);
    
    // Inicializar estado del socket
    connections.set(socket.id, {
        role: null,
        status: 'disconnected',
        roomId: null,
        connectedTo: null,
        password: null,
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
        conn.status = 'ready';
        
        // Buscar espectador pendiente y conectar
        const spectatorSocketId = findAvailableCamera() ? null : null;
        
        console.log(`[CAM] Cámara registrada: ${socket.id}`);
        socket.emit('cameraRegistered', { 
            message: 'Cámara registrada exitosamente',
            waitingForViewer: true
        });

        // Notificar a espectadores disponibles
        broadcastToRole('spectator', 'cameraAvailable', { 
            cameraId: socket.id 
        });
    });

    /**
     * Evento: Cliente se registra como espectador
     */
    socket.on('registerAsSpectator', () => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        conn.role = 'spectator';
        conn.status = 'searching';
        
        console.log(`[VIEW] Espectador buscando cámara: ${socket.id}`);

        // Buscar cámara disponible
        const cameraSocketId = findAvailableCamera();
        
        if (cameraSocketId) {
            // Conectar directamente
            connectCameraToSpectator(cameraSocketId, socket.id);
        } else {
            // No hay cámaras disponibles, esperar
            socket.emit('noCameraAvailable', { 
                message: 'No hay cámaras disponibles. Esperando...' 
            });
            console.log(`[VIEW] Espectador ${socket.id} en cola de espera`);
        }
    });

    /**
     * Evento: Cámara lista para transmitir
     */
    socket.on('cameraReady', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        conn.status = 'ready';
        console.log(`[CAM] Cámara ${socket.id} lista para transmitir`);

        // Notificar a espectadores pendientes
        broadcastToRole('spectator', 'cameraAvailable', { 
            cameraId: socket.id 
        });
    });

    /**
     * Evento: Oferta WebRTC (iniciador crea la oferta)
     */
    socket.on('webrtcOffer', (data) => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        const { targetSocketId, offer } = data;
        const targetConn = connections.get(targetSocketId);

        if (targetConn && targetConn.socket) {
            console.log(`[WEBRTC] Oferta enviada de ${socket.id} a ${targetSocketId}`);
            targetConn.socket.emit('webrtcOffer', {
                fromSocketId: socket.id,
                offer: offer
            });
        }
    });

    /**
     * Evento: Respuesta WebRTC
     */
    socket.on('webrtcAnswer', (data) => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        const { targetSocketId, answer } = data;
        const targetConn = connections.get(targetSocketId);

        if (targetConn && targetConn.socket) {
            console.log(`[WEBRTC] Respuesta enviada de ${socket.id} a ${targetSocketId}`);
            targetConn.socket.emit('webrtcAnswer', {
                fromSocketId: socket.id,
                answer: answer
            });
        }
    });

    /**
     * Evento: Candidatos ICE
     */
    socket.on('webrtcIceCandidate', (data) => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        const { targetSocketId, candidate } = data;
        const targetConn = connections.get(targetSocketId);

        if (targetConn && targetConn.socket) {
            targetConn.socket.emit('webrtcIceCandidate', {
                fromSocketId: socket.id,
                candidate: candidate
            });
        }
    });

    /**
     * Evento: Cambio de estado de conexión WebRTC
     */
    socket.on('connectionStateChange', (state) => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        conn.status = state;
        console.log(`[STATE] ${socket.id} estado WebRTC: ${state}`);

        // Si se desconecta, notificar al peer
        if (state === 'disconnected' || state === 'failed') {
            handlePeerDisconnection(socket.id);
        } else if (state === 'connected') {
            handlePeerConnected(socket.id);
        }
    });

    /**
     * Evento: Datos de movimiento detectados
     */
    socket.on('motionDetected', (data) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        // Notificar al espectador conectado
        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.emit('motionAlert', {
                    timestamp: Date.now(),
                    score: data.score,
                    imageData: data.imageData
                });
            }
        }
    });

    /**
     * Evento: Control de linterna (desde la cámara)
     */
    socket.on('toggleFlashlight', (enabled) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        // Notificar al espectador
        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.emit('flashlightStatus', { enabled });
            }
        }
    });

    /**
     * Evento: Cambiar estado de detección de movimiento (desde la cámara)
     */
    socket.on('motionStatusChange', (enabled) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        // Notificar al espectador
        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.emit('cameraMotionStatus', { enabled });
            }
        }
    });

    /**
     * Evento: Espectador quiere activar/desactivar la linterna
     */
    socket.on('spectatorToggleFlashlight', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        // Buscar la cámara conectada
        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            // Reenviar comando a la cámara
            cameraConn.socket.emit('remoteFlashlightToggle');
            console.log(`[CMD] Espectador ${socket.id} ordenó toggle linterna`);
        }
    });

    /**
     * Evento: Espectador quiere activar/desactivar detección de movimiento
     */
    socket.on('spectatorToggleMotion', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        // Buscar la cámara conectada
        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            // Reenviar comando a la cámara
            cameraConn.socket.emit('remoteMotionToggle');
            console.log(`[CMD] Espectador ${socket.id} ordenó toggle motion`);
        }
    });

    /**
     * Evento: Espectador quiere cambiar calidad/FPS
     */
    socket.on('spectatorSetQuality', (data) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        const { quality, fps } = data;

        // Buscar la cámara conectada
        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            // Reenviar comando a la cámara
            cameraConn.socket.emit('remoteQualityChange', { quality, fps });
            console.log(`[CMD] Espectador ${socket.id} ordenó calidad: ${quality}, FPS: ${fps}`);
        }
    });

    /**
     * Evento: Espectador solicita estado actual de la cámara
     */
    socket.on('spectatorRequestStatus', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'spectator') return;

        // Buscar la cámara conectada
        const cameraConn = connections.get(conn.connectedTo);
        if (cameraConn && cameraConn.socket) {
            // Solicitar estado a la cámara
            cameraConn.socket.emit('requestCameraStatus');
        }
    });

    /**
     * Evento: Cámara responde con su estado actual
     */
    socket.on('cameraStatusResponse', (status) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        // Notificar al espectador
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
            // Notificar al peer si estaba conectado
            handlePeerDisconnection(socket.id);
            
            // Eliminar de conexiones
            connections.delete(socket.id);
        }

        // Notificar a espectadores que la cámara se desconectó
        if (conn && conn.role === 'camera') {
            broadcastToRole('spectator', 'cameraDisconnected', { 
                cameraId: socket.id 
            });
        }
    });
});

/**
 * Conecta una cámara a un espectador
 */
function connectCameraToSpectator(cameraSocketId, spectatorSocketId) {
    const cameraConn = connections.get(cameraSocketId);
    const spectatorConn = connections.get(spectatorSocketId);

    if (!cameraConn || !spectatorConn) return;

    // Actualizar estados
    cameraConn.status = 'connecting';
    cameraConn.connectedTo = spectatorSocketId;
    spectatorConn.status = 'connecting';
    spectatorConn.connectedTo = cameraSocketId;

    // Notificar a ambos peers
    console.log(`[CONNECT] Conectando cámara ${cameraSocketId} con espectador ${spectatorSocketId}`);

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

    // Notificar al peer conectado
    if (conn.connectedTo) {
        const peerConn = connections.get(conn.connectedTo);
        if (peerConn && peerConn.socket) {
            peerConn.socket.emit('peerDisconnected', {
                reason: 'Peer desconectado'
            });
            peerConn.status = 'searching';
            peerConn.connectedTo = null;
        }
    }

    // Si era una cámara, buscar nueva cámara para el espectador
    if (conn.role === 'camera') {
        const newCameraId = findAvailableCamera();
        if (newCameraId) {
            // Notificar al espectador que encontró nueva cámara
            const spectatorConn = connections.get(conn.connectedTo);
            if (spectatorConn) {
                connectCameraToSpectator(newCameraId, spectatorConn.socket.id);
            }
        } else {
            broadcastToRole('spectator', 'noCameraAvailable', {
                message: 'Cámara desconectada. No hay otras cámaras disponibles.'
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

    console.log(`[CONNECT] WebRTC establecido entre ${socketId} y ${conn.connectedTo}`);
    
    // Notificar al peer
    if (conn.connectedTo) {
        const peerConn = connections.get(conn.connectedTo);
        if (peerConn && peerConn.socket) {
            peerConn.socket.emit('peerConnected', {
                message: 'Conexión establecida'
            });
        }
    }
}

/**
 * Envía un mensaje a todos los clientes con un rol específico
 */
function broadcastToRole(role, event, data) {
    for (const [socketId, conn] of connections.entries()) {
        if (conn.role === role && conn.socket) {
            conn.socket.emit(event, data);
        }
    }
}

// Endpoint de estado del servidor
app.get('/api/status', (req, res) => {
    const cameraCount = Array.from(connections.values()).filter(c => c.role === 'camera').length;
    const spectatorCount = Array.from(connections.values()).filter(c => c.role === 'spectator').length;
    
    res.json({
        status: 'online',
        uptime: process.uptime(),
        connections: {
            total: connections.size,
            cameras: cameraCount,
            spectators: spectatorCount
        }
    });
});

// Endpoint de health check para Render.com
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
╚════════════════════════════════════════════════╝
    `);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
    console.error('Error no controlado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promesa rechazada:', reason);
});
