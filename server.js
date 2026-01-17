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

function getConnectionInfo(socketId) {
    const conn = connections.get(socketId);
    if (!conn) return null;
    return {
        role: conn.role,
        status: conn.status,
        connectedTo: conn.connectedTo
    };
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
 * Busca cualquier espectador que pueda recibir stream
 * Incluye espectadores buscando O espectadores esperando reconexión
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

    logEvent('MATCH', `Conectando CÁMARA ${cameraSocketId} <-> ESPECTADOR ${spectatorSocketId}`);

    // Actualizar estados y referencias DE AMBOS lados
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

    logEvent('INFO', `Conexión establecida: ${cameraSocketId} (${cameraConn.status}) <-> ${spectatorSocketId} (${spectatorConn.status})`);
    
    return true;
}

/**
 * Intenta conectar espectador con retry si no hay cámara lista inmediatamente
 */
function attemptSpectatorConnection(spectatorSocketId) {
    let attempts = 0;
    const maxAttempts = 3;
    const retryDelay = 500; // 500ms entre reintentos

    const tryConnect = () => {
        attempts++;
        
        // Buscar cámara disponible
        let cameraSocketId = findAvailableCamera();
        
        // Si no hay cámara, buscar espectadores pendientes que podrían reconectarse
        if (!cameraSocketId) {
            logEvent('WARN', `Intento ${attempts}/${maxAttempts}: Sin cámara disponible, reintentando...`);
            
            if (attempts < maxAttempts) {
                setTimeout(tryConnect, retryDelay);
                return;
            } else {
                // Max reintentos alcanzado
                const spectatorConn = connections.get(spectatorSocketId);
                if (spectatorConn) {
                    spectatorConn.status = 'searching';
                    spectatorConn.socket.emit('noCameraAvailable', { 
                        message: 'No hay cámaras disponibles. Espera a que una cámara se conecte.' 
                    });
                    logEvent('INFO', 'No hay cámaras disponibles después de reintentos');
                }
                return;
            }
        }

        // Intentar conectar
        const success = connectCameraToSpectator(cameraSocketId, spectatorSocketId);
        
        if (!success && attempts < maxAttempts) {
            // La conexión falló pero podemos reintentar
            setTimeout(tryConnect, retryDelay);
        }
    };

    // Iniciar proceso de conexión
    tryConnect();
}

/**
 * Manejador de conexiones Socket.io
 */
io.on('connection', (socket) => {
    logEvent('CONN', `Cliente conectado`);
    
    // Inicializar estado del socket
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
        logEvent('AUTH', isValid ? 'AUTORIZADO' : 'FALLIDO');
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
        
        logEvent('CAM', `Nueva cámara registrada: ${socket.id}`);
        socket.emit('cameraRegistered', { 
            message: 'Cámara registrada exitosamente' 
        });

        // Buscar si hay espectadores esperando
        const spectatorSocketId = findAnySpectator();
        if (spectatorSocketId) {
            logEvent('CAM', `Espectador ${spectatorSocketId} esperando, conectando...`);
            connectCameraToSpectator(socket.id, spectatorSocketId);
        } else {
            logEvent('CAM', `Sin espectadores esperando, esperando conexión...`);
        }
    });

    /**
     * Evento: Cámara lista para transmitir (video inicializado)
     */
    socket.on('cameraReady', () => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') return;

        conn.status = 'ready';
        logEvent('CAM', `CÁMARA ${socket.id} LISTA PARA TRANSMITIR`);
        
        // Verificar si ya tiene un espectador conectado (caso de reconnect)
        if (conn.connectedTo) {
            const spectatorConn = connections.get(conn.connectedTo);
            if (spectatorConn && spectatorConn.socket) {
                // Notificar al espectador que la cámara está lista
                spectatorConn.socket.emit('peerReady', { 
                    message: 'Cámara lista para transmitir' 
                });
            }
        } else {
            // Buscar espectadores esperando
            const spectatorSocketId = findAnySpectator();
            if (spectatorSocketId) {
                logEvent('CAM', `Conectando con espectador ${spectatorSocketId}...`);
                connectCameraToSpectator(socket.id, spectatorSocketId);
            } else {
                logEvent('CAM', `Esperando espectadores...`);
                // Notificar a todos los espectadores que hay una nueva cámara
                broadcastToRole('spectator', 'cameraAvailable', { 
                    cameraId: socket.id 
                });
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
        
        logEvent('VIEW', `Nuevo espectador: ${socket.id}`);

        // Intentar conectar con retry
        attemptSpectatorConnection(socket.id);
    });

    /**
     * Evento: Frame de video recibido de la cámara
     * Reenvía inmediatamente al espectador conectado
     */
    socket.on('stream_frame', (data) => {
        const conn = connections.get(socket.id);
        if (!conn || conn.role !== 'camera') {
            logEvent('WARN', `Frame recibido de socket no autorizado: ${socket.id}`);
            return;
        }

        // Si la cámara aún no está en modo streaming, actualizamos
        if (conn.status !== 'streaming') {
            conn.status = 'streaming';
            logEvent('STREAM', `Cámara ${socket.id} comenzando transmisión`);
        }

        // Reenviar frame al espectador conectado
        if (conn.connectedTo) {
            const targetConn = connections.get(conn.connectedTo);
            if (targetConn && targetConn.socket) {
                // Usar volatile para no acumular frames si hay latencia
                targetConn.socket.volatile.emit('video_frame', {
                    image: data.image,
                    timestamp: data.timestamp,
                    frameNumber: data.frameNumber,
                    isDemo: data.isDemo || false
                });
            } else {
                logEvent('WARN', `Espectador ${conn.connectedTo} no encontrado para frames`);
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
        const conn = connections.get(socket.id);
        
        if (conn) {
            logEvent('DISC', `Desconectado. Rol: ${conn.role || 'none'}, Estado: ${conn.status}, Conectado a: ${conn.connectedTo || 'none'}`);
            
            // Solo procesar desconexión si el peer estaba activamente conectado
            if (conn.connectedTo) {
                handlePeerDisconnection(socket.id);
            } else {
                logEvent('DISC', `Socket sin conexión activa, ignorando`);
            }
            
            connections.delete(socket.id);
        } else {
            logEvent('DISC', `Socket no encontrado en registro`);
        }
    });
});

/**
 * Maneja la desconexión de un peer activamente conectado
 */
function handlePeerDisconnection(socketId) {
    const conn = connections.get(socketId);
    if (!conn || !conn.connectedTo) return;

    const peerId = conn.connectedTo;
    logEvent('DISC', `Procesando desconexión: ${socketId} -> ${peerId}`);

    // Notificar al peer conectado
    const peerConn = connections.get(peerId);
    if (peerConn && peerConn.socket) {
        peerConn.socket.emit('peerDisconnected', { 
            reason: 'Peer desconectado',
            wasCamera: conn.role === 'camera'
        });
        
        // Resetear estado del peer
        if (peerConn.role === 'spectator') {
            peerConn.status = 'searching';
            peerConn.connectedTo = null;
            logEvent('DISC', `Espectador ${peerId} liberado, buscando nueva cámara...`);
            
            // Buscar nueva cámara automáticamente
            const newCameraId = findAvailableCamera();
            if (newCameraId) {
                logEvent('MATCH', `Reconectando espectador ${peerId} a cámara ${newCameraId}`);
                connectCameraToSpectator(newCameraId, peerId);
            } else {
                // Notificar que no hay cámaras disponibles
                peerConn.socket.emit('noCameraAvailable', { 
                    message: 'Cámara desconectada. Esperando nuevas cámaras...' 
                });
            }
        } else if (peerConn.role === 'camera') {
            peerConn.status = 'ready';
            peerConn.connectedTo = null;
            logEvent('DISC', `Cámara ${peerId} liberada, disponible para nueva conexión`);
        }
    }

    // Limpiar referencia del socket desconectado
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
