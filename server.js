// ---
// Title: Robust Real-Time Chat Server (updated)
// Author: Gemini (updated)
// Notes: safer startup, clearer broadcast payload (messageType), WS heartbeat,
//        and improved JSON file handling.
// ---

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const multer = require('multer');

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cors()); // Allows your front-end to connect

// --- File Storage Setup ---
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Serve static files (like uploaded images) from the 'public' folder
app.use(express.static('public'));

// --- Helper Functions for Reading/Writing JSON ---
async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

const readJsonFile = async (filePath) => {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        // If file empty, treat as empty array
        if (!raw || raw.trim() === '') return [];
        return JSON.parse(raw);
    } catch (err) {
        // File missing / unreadable -> return empty array
        return [];
    }
};

const writeJsonFile = async (filePath, data) => {
    const dir = path.dirname(filePath);
    await ensureDir(dir);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
};

// --- API Endpoints (for history, registration, uploads) ---
app.get('/messages', async (req, res) => {
    try {
        const msgs = await readJsonFile(MESSAGES_FILE);
        res.json(msgs);
    } catch (err) {
        console.error('Error reading messages:', err);
        res.status(500).json([]);
    }
});

app.post('/register', async (req, res) => {
    const { username } = req.body;
    if (!username || username.trim().length < 3) {
        return res.status(400).json({ success: false, message: 'Username must be at least 3 characters.' });
    }
    try {
        const users = await readJsonFile(USERS_FILE);
        if (users.find(u => u.toLowerCase() === username.toLowerCase())) {
            return res.status(409).json({ success: false, message: 'Username is already taken.' });
        }
        users.push(username);
        await writeJsonFile(USERS_FILE, users);
        res.status(201).json({ success: true, message: 'Username registered successfully.' });
    } catch (err) {
        console.error('Error registering user:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).send({ success: false, message: 'No file was uploaded.' });
    // Return the public path (front-end will typically prefix with location.origin)
    res.status(201).send({ success: true, filePath: `/uploads/${req.file.filename}` });
});

// --- WebSocket Server for Real-Time Communication ---
const wss = new WebSocketServer({ server });

// Simple heartbeat implementation to detect broken clients
function noop() {}
function heartbeat() {
    this.isAlive = true;
}

wss.on('connection', (ws) => {
    console.log('A new client connected.');
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (error) {
            console.error('Received non-JSON message:', message);
            return;
        }

        // console.log('Received message from client:', data);

        // Register user for typing indicators
        if (data.type === 'registerUser') {
            ws.username = data.username;
            return;
        }

        // Typing indicators (broadcast to others)
        if (data.type === 'typing' || data.type === 'stopTyping') {
            // broadcast to other clients
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(JSON.stringify({
                            type: data.type === 'typing' ? 'userTyping' : 'userStopTyping',
                            username: ws.username || data.username || 'Anonymous'
                        }));
                    } catch (err) {
                        console.warn('Failed to send typing indicator to a client:', err);
                    }
                }
            });
            return;
        }

        // New chat messages (text, image, audio)
        if (['chatMessage', 'imageMessage', 'audioMessage'].includes(data.type)) {
            if (!data.username) {
                console.error('Message received without a username:', data);
                return;
            }

            const newMessage = {
                id: uuidv4(),
                username: data.username,
                timestamp: new Date().toISOString(),
                // normalize the message type into messageType so envelope type remains 'newChatMessage'
                type: data.type === 'chatMessage' ? 'text' : (data.type === 'imageMessage' ? 'image' : 'audio'),
                content: data.text || data.filePath || '' // text messages use `text`, uploads use `filePath`
            };

            try {
                // 1) Save to history (append)
                const messages = await readJsonFile(MESSAGES_FILE);
                messages.push(newMessage);
                await writeJsonFile(MESSAGES_FILE, messages);
            } catch (err) {
                console.error('Failed to save message to disk:', err);
                // continue to broadcast even if saving fails
            }

            // 2) Broadcast to all connected clients
            const broadcastPayload = {
                type: 'newChatMessage',      // envelope type for clients to listen to
                id: newMessage.id,
                username: newMessage.username,
                timestamp: newMessage.timestamp,
                messageType: newMessage.type, // explicit field for message content type: 'text' | 'image' | 'audio'
                content: newMessage.content
            };

            const payloadString = JSON.stringify(broadcastPayload);

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(payloadString);
                    } catch (err) {
                        console.warn('Failed to send message to a client:', err);
                    }
                }
            });
        }
    });

    ws.on('close', () => {
        console.log(`Client ${ws.username || ''} disconnected.`);
        // Notify others that the user stopped typing when they disconnect
        if (ws.username) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(JSON.stringify({ type: 'userStopTyping', username: ws.username }));
                    } catch (err) {
                        // ignore
                    }
                }
            });
        }
    });

    ws.on('error', (error) => console.error('A WebSocket error occurred:', error));
});

// Heartbeat interval to terminate dead connections
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch (e) {}
            return;
        }
        ws.isAlive = false;
        try { ws.ping(noop); } catch (e) {}
    });
}, 30000);

// --- Server Initialization ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    try {
        // Ensure directories exist
        await ensureDir(DATA_DIR);
        await ensureDir(path.join(__dirname, 'public'));
        await ensureDir(UPLOADS_DIR);

        // Ensure JSON files exist (don't overwrite existing data)
        if (!fsSync.existsSync(USERS_FILE)) {
            await writeJsonFile(USERS_FILE, []);
        }
        if (!fsSync.existsSync(MESSAGES_FILE)) {
            await writeJsonFile(MESSAGES_FILE, []);
        }

        console.log(`Server is running and listening on port ${PORT}`);
    } catch (err) {
        console.error('Failed to initialize server files/directories:', err);
        process.exit(1);
    }
});

// Clean up on process exit
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down.');
    clearInterval(interval);
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down.');
    clearInterval(interval);
    server.close(() => process.exit(0));
});
