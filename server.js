// Advanced messaging service backend using Node.js, Express, and WebSockets.
// Handles real-time messages, file uploads, and unique username registration.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(cors());

// --- Setup for File Uploads ---
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Serve static files from 'public' directory, including uploads
app.use(express.static('public'));

// --- File Paths & Data Management ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

async function initializeData() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    try { await fs.access(USERS_FILE); } catch { await fs.writeFile(USERS_FILE, '[]') }
    try { await fs.access(MESSAGES_FILE); } catch { await fs.writeFile(MESSAGES_FILE, '[]') }
    console.log('Data files and upload directory initialized.');
}

const readJsonFile = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8').catch(() => '[]'));
const writeJsonFile = async (filePath, data) => fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');

// --- API Endpoints ---
app.get('/messages', async (req, res) => res.json(await readJsonFile(MESSAGES_FILE)));

app.post('/register', async (req, res) => {
    const { username } = req.body;
    if (!username || username.trim().length < 3) {
        return res.status(400).json({ success: false, message: 'Username must be at least 3 characters.' });
    }
    const users = await readJsonFile(USERS_FILE);
    if (users.find(u => u.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ success: false, message: 'Username is already taken.' });
    }
    users.push(username);
    await writeJsonFile(USERS_FILE, users);
    res.status(201).json({ success: true, message: 'Username registered.' });
});

app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).send({ success: false, message: 'No file uploaded.' });
    res.status(201).send({ success: true, filePath: `/uploads/${req.file.filename}` });
});

// --- WebSocket Server for Real-Time Events ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
    console.log('A new user connected.');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // Simple function to broadcast to all clients
            const broadcast = (messageData) => {
                const dataString = JSON.stringify(messageData);
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(dataString);
                    }
                });
            };
            
            // Simple function to broadcast to all clients EXCEPT the sender
            const broadcastToOthers = (messageData) => {
                const dataString = JSON.stringify(messageData);
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(dataString);
                    }
                });
            };

            // Handle different message types
            switch (data.type) {
                case 'registerUser':
                    ws.username = data.username;
                    console.log(`Connection now associated with user: ${ws.username}`);
                    break;

                case 'typing':
                    broadcastToOthers({ type: 'userTyping', username: ws.username });
                    break;

                case 'stopTyping':
                    broadcastToOthers({ type: 'userStopTyping', username: ws.username });
                    break;
                
                case 'chatMessage':
                case 'imageMessage':
                case 'audioMessage':
                    if (!data.username) {
                        console.error("Received message without a username. Discarding.");
                        return;
                    }

                    const newMessage = {
                        id: uuidv4(),
                        username: data.username,
                        timestamp: new Date().toISOString(),
                        type: data.type === 'chatMessage' ? 'text' : (data.type === 'imageMessage' ? 'image' : 'audio'),
                        content: data.text || data.filePath
                    };

                    const messages = await readJsonFile(MESSAGES_FILE);
                    messages.push(newMessage);
                    await writeJsonFile(MESSAGES_FILE, messages);
                    
                    // Broadcast the newly created message to ALL clients
                    broadcast({ type: 'newChatMessage', ...newMessage });
                    break;
            }
        } catch (error) { console.error('Failed to process WebSocket message:', error); }
    });

    ws.on('close', () => {
        console.log(`User ${ws.username || ''} disconnected.`);
        if (ws.username) {
            wss.clients.forEach(client => {
                 if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'userStopTyping', username: ws.username }));
                 }
            });
        }
    });
    ws.on('error', error => console.error('WebSocket Error:', error));
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    await initializeData();
    console.log(`Server is sparkling and ready on port ${PORT}`);
});

