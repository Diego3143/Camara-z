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

// ============================================
// FUNCIONES DE UTILIDAD Y DEBUG
// ============================================

function logEvent(category, message, socketId = null) {
    const id = socketId || 'SERVER';
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}] [${category}] ${id}: ${message}`);
}

/**
 * Busca una cámara disponible para conectar
 * Las cámaras en status 'ready' o 'streaming' están disponibles
 */
function findAvailableCamera() {
    for (const [socketId, data] of connections.entries()) {
        if (data.role === 'camera' && 
            (data.status === 'ready' || data.status === 'streaming') && 
            !data.connectedTo) {
            return socketId;
        }
    }
    return null;
}

/**
 * Busca cualquier espectador que pueda recibir stream
 */
function findAnySpectator() {
    for (const [socketId, data] of connections.entries()) {
        if (data.role === 'spectator' && !data.connectedTo) {
            return socketId;
        }
    }
    return null;
}

/**
 * Conecta una cámara a un espectador con manejo robusto
 */
function connectCameraToSpectator(cameraSocketId, spectatorSocketId) {
    const cameraConn = connections.get(cameraSocketId);
    const spectatorConn = connections.get(spectatorSocketId);

    // Validar que ambas conexiones existen
    if (!cameraConn) {
        logEvent('ERR', `Cámara no encontrada: ${cameraSocketId}`);
        return false;
    }
    if (!spectatorConn) {
        logEvent('ERR', `Espectador no encontrado: ${spectatorSocketId}`);
        return false;
    }

    // Verificar que la cámara no esté ya conectada
    if (cameraConn.connectedTo) {
        logEvent('WARN', `Cámara ${cameraSocketId} ya conectada a ${cameraConn.connectedTo}`);
        return false;
    }

    logEvent('MATCH', `Conectando CÁMARA ${cameraSocketId.substring(0,8)} <-> ESPECTADOR ${spectatorSocketId.substring(0,8)}`);

    // Actualizar estados y referencias
    cameraConn.connectedTo = spectatorSocketId;
    cameraConn.status = 'streaming';
    
    spectatorConn.connectedTo = cameraSocketId;
    spectatorConn.status = 'streaming';

    // Notificar a la cámara
    cameraConn.socket.emit('connectionInitiated', {
        peerId: spectatorSocketId,
        role: 'camera'
    });

    // Notificar al espectador
    spectatorConn.socket.emit('connectionInitiated', {
        peerId: cameraSocketId,
        role: 'spectator'
    });

    logEvent('INFO', `Conexión establecida correctamente`);
    
    return true;
}

/**
 * Intenta conectar espectador con retry si no hay cámara lista inmediatamente
 */
function attemptSpectatorConnection(spectatorSocketId) {
    let attempts = 0;
    const maxAttempts = 3;
    const retryDelay = 500;

    const tryConnect = () => {
        attempts++;
        
        // Buscar cámara disponible
        let cameraSocketId = findAvailableCamera();
        
        if (!cameraSocketId) {
            logEvent('WARN', `Intento ${attempts}/${maxAttempts}: Sin cámara disponible`);
            
            if (attempts < maxAttempts) {
                setTimeout(tryConnect, retryDelay);
                return;
            } else {
                // Max reintentos alcanzado
                const spectatorConn = connections.get(spectatorSocketId);
                if (spectatorConn) {
                    spectatorConn.status = 'searching';
                    spectatorConn.socket.emit('noCameraAvailable', { 
                        message: 'No hay cámaras disponibles.' 
                    });
                }
                return;
            }
        }

        // Intentar conectar
        const success = connectCameraToSpectator(cameraSocketId, spectatorSocketId);
        
        if (!success && attempts < maxAttempts) {
            setTimeout(tryConnect, retryDelay);
        }
    };

    tryConnect();
}

/**
 * Maneja la desconexión de un peer activamente conectado
 */
function handlePeerDisconnection(socketId) {
    const conn = connections.get(socketId);
    if (!conn || !conn.connectedTo) return;

    const peerId = conn.connectedTo;
    logEvent('DISC', `Desconexión: ${socketId.substring(0,8)} -> ${peerId.substring(0,8)}`);

    const peerConn = connections.get(peerId);
    if (peerConn && peerConn.socket) {
        peerConn.socket.emit('peerDisconnected', { 
            reason: 'Peer desconectado',
            wasCamera: conn.role === 'camera'
        });
        
        if (peerConn.role === 'spectator') {
            peerConn.status = 'searching';
            peerConn.connectedTo = null;
            
            // Buscar nueva cámara automáticamente
            const newCameraId = findAvailableCamera();
            if (newCameraId) {
                logEvent('MATCH', `Reconectando espectador a nueva cámara`);
                connectCameraToSpectator(newCameraId, peerId);
            } else {
                peerConn.socket.emit('noCameraAvailable', { 
                    message: 'Cámara desconectada.' 
                });
            }
        } else if (peerConn.role === 'camera') {
            peerConn.status = 'ready';
            peerConn.connectedTo = null;
        }
    }

    conn.connectedTo = null;
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
    logEvent('BCAST', `${event} -> ${count} ${role}(s)`);
}

// ============================================
// MANEJO DE CONEXIONES SOCKET.IO
// ============================================

io.on('connection', (socket) => {
    logEvent('CONN', `Cliente conectado`);
    
    connections.set(socket.id, {
        role: null,
        status: 'connected',
        connectedTo: null,
        socket: socket
    });

    /**
     * Evento: Cliente intenta autenticarse
     */
    socket.on('authenticate', (password) => {
        const isValid = password === APP_PASSWORD;
        logEvent('AUTH', isValid ? 'OK' : 'FALLIDO');
        socket.emit('authResult', { success: isValid });
    });

    /**
     * Evento: Cliente se registra como cámara
     */
    socket.on('registerAsCamera', () => {
        const conn = connections.get(socket.id);
        if (!conn) return;

        conn.role = 'camera';
        conn.status = 'initializing';
        
        logEvent('CAM', `Nueva cámara`);
        socket.emit('cameraRegistered', { message: 'Cámara registrada' });

        const spectatorSocketId = findAnySpectator();
        if (spectatorSocketId) {
            connectCameraToSpectator(socket.id, spectatorSocketId);
        }
    });

    /**
     * Evento: Cámara lista para transmitir
     */
    socket.on('cameraReady', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        conn.status = 'ready';
        logEvent('CAM', `Cámara lista`);
        
        if (conn.connectedTo) {
            const spectatorConn = connections.get(conn.connectedTo);
            if (spectatorConn && spectatorConn.socket) {
                spectatorConn.socket.emit('peerReady', { message: 'Cámara lista' });
            }
        } else {
            const spectatorSocketId = findAnySpectator();
            if (spectatorSocketId) {
                connectCameraToSpectator(socket.id, spectatorSocketId);
            } else {
                broadcastToRole('spectator', 'cameraAvailable', { cameraId: socket.id });
            }
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
        
        logEvent('VIEW', `Nuevo espectador`);
        attemptSpectatorConnection(socket.id);
    });

    /**
     * Evento: Frame de video recibido de la cámara
     */
    socket.on('stream_frame', (data) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        if (conn.status !== 'streaming') {
            conn.status = 'streaming';
        }

        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                targetConn.socket.volatile.emit('video_frame', {
                    image: data.image,
                    timestamp: data.timestamp,
                    frameNumber: data.frameNumber,
                    isDemo: data.isDemo || false
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
                    blobs: data.blobs
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
        const conn = connections.get(socket.id);
        
        if (conn) {
            logEvent('DISC', `Desconectado (${conn.role || 'none'})`);
            
            if (conn.connectedTo) {
                handlePeerDisconnection(socket.id);
            }
            
            connections.delete(socket.id);
        }
    });
});

// ============================================
// ENDPOINTS HTTP
// ============================================

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

// ============================================
// INICIAR SERVIDOR
// ============================================

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

process.on('uncaughtException', (err) => {
    console.error('Error:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Rechazo:', reason);
});
