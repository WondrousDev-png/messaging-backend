// ---
// Title: Robust Real-Time Chat Server
// Author: Gemini
// Description: A complete backend for a real-time messaging application.
// This version includes a rewritten, more reliable WebSocket broadcasting
// system to ensure messages are delivered instantly to all clients.
// ---

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs').promises;
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
const readJsonFile = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8').catch(() => '[]'));
const writeJsonFile = async (filePath, data) => fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');

// --- API Endpoints (for history, registration, uploads) ---
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
    res.status(201).json({ success: true, message: 'Username registered successfully.' });
});

app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).send({ success: false, message: 'No file was uploaded.' });
    res.status(201).send({ success: true, filePath: `/uploads/${req.file.filename}` });
});


// --- WebSocket Server for Real-Time Communication ---
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
    console.log('A new client connected.');

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (error) {
            console.error('Received non-JSON message:', message);
            return;
        }

        console.log('Received message from client:', data);

        // --- THE CRITICAL FIX IS HERE ---
        // A simpler, more direct way to handle broadcasting messages.

        // Assign username to the connection for typing indicators
        if (data.type === 'registerUser') {
            ws.username = data.username;
            return;
        }

        // Handle typing indicators by broadcasting to everyone else
        if (data.type === 'typing' || data.type === 'stopTyping') {
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: data.type === 'typing' ? 'userTyping' : 'userStopTyping', username: ws.username }));
                }
            });
            return;
        }

        // Handle new chat messages (text, image, audio)
        if (['chatMessage', 'imageMessage', 'audioMessage'].includes(data.type)) {
            if (!data.username) {
                console.error('Message received without a username:', data);
                return;
            }

            const newMessage = {
                id: uuidv4(),
                username: data.username,
                timestamp: new Date().toISOString(),
                type: data.type === 'chatMessage' ? 'text' : (data.type === 'imageMessage' ? 'image' : 'audio'),
                content: data.text || data.filePath
            };

            // 1. Save the new message to the history file
            const messages = await readJsonFile(MESSAGES_FILE);
            messages.push(newMessage);
            await writeJsonFile(MESSAGES_FILE, messages);

            // 2. Broadcast the new message to EVERY connected client
            console.log("Broadcasting new message to all clients:", newMessage);
            const broadcastPayload = JSON.stringify({ type: 'newChatMessage', ...newMessage });
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(broadcastPayload);
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
                    client.send(JSON.stringify({ type: 'userStopTyping', username: ws.username }));
                }
            });
        }
    });
    ws.on('error', (error) => console.error('A WebSocket error occurred:', error));
});


// --- Server Initialization ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    // Ensure data and upload directories exist on server start
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.writeFile(USERS_FILE, await fs.readFile(USERS_FILE, 'utf8').catch(() => '[]'));
    await fs.writeFile(MESSAGES_FILE, await fs.readFile(MESSAGES_FILE, 'utf8').catch(() => '[]'));
    
    console.log(`Server is running and listening on port ${PORT}`);
});

