import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      "https://suspect-spectrum.netlify.app", 
      "http://localhost:5173"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Global game state in RAM
const rooms = new Map();

// Read from your external questions database
const rawData = fs.readFileSync(new URL('./questions.json', import.meta.url));
const QUESTION_BANK = JSON.parse(rawData);

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// ADVANCED POINT SYSTEM
function calculateScores(room) {
  const voteCounts = {};
  
  // Tally votes (ignoring 'NONE')
  room.players.forEach(p => {
    if (p.votedFor && p.votedFor !== 'NONE') {
      voteCounts[p.votedFor] = (voteCounts[p.votedFor] || 0) + 1;
    }
  });

  // Find most voted player(s)
  let maxVotes = 0;
  let mostVotedIds = [];
  Object.entries(voteCounts).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      mostVotedIds = [id];
    } else if (count === maxVotes) {
      mostVotedIds.push(id);
    }
  });

  if (room.gameMode === 'Paranoia') {
    // 0 IMPOSTERS SCORING
    room.players.forEach(p => {
      if (p.votedFor === 'NONE') p.score += 2; // Smart! Spotted Paranoia
      else p.score -= 1; // Paranoia penalty for turning on a friend
    });
  } else {
    // 1 OR 2 IMPOSTERS SCORING
    room.players.forEach(p => {
      const isImposter = room.imposterIds.includes(p.id);
      
      if (!isImposter) {
        // Crewmember Scoring
        if (room.imposterIds.includes(p.votedFor)) {
          p.score += 1; // Caught an imposter
        } else if (p.votedFor === 'NONE') {
          p.score -= 1; // Voted nobody when there WAS a threat
        }
      } else {
        // Imposter Scoring
        const gotCaught = mostVotedIds.includes(p.id);
        if (!gotCaught) {
          p.score += (room.gameMode === 'Syndicate' ? 2 : 3); // 3 pts if solo, 2 pts if syndicate
        }
      }
    });
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('createRoom', ({ playerName }) => {
    const roomId = generateRoomCode();
    const newPlayer = {
      id: socket.id, name: playerName, score: 0, answer: '', votedFor: '', hasVoted: false, isHost: true
    };

    rooms.set(roomId, {
      id: roomId,
      players: [newPlayer],
      gameState: 'lobby', 
      revealPhase: 'none', 
      imposterIds: [], // Now an array for multiple imposters
      gameMode: 'Normal',
      currentQuestion: null,
      timer: 0
    });

    socket.join(roomId);
    socket.emit('roomState', rooms.get(roomId));
  });

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const code = roomId.toUpperCase();
    if (!rooms.has(code)) return socket.emit('errorMsg', 'Room not found!');
    
    const room = rooms.get(code);
    if (room.gameState !== 'lobby') return socket.emit('errorMsg', 'Game in progress!');

    room.players.push({
      id: socket.id, name: playerName, score: 0, answer: '', votedFor: '', hasVoted: false, isHost: false
    });
    
    socket.join(code);
    io.to(code).emit('roomState', room);
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.length < 3) return io.to(roomId).emit('errorMsg', 'Need at least 3 players!');

    room.players.forEach(p => { p.answer = ''; p.votedFor = ''; p.hasVoted = false; });

    // THE CHAOS ENGINE: Determine Game Mode
    const roll = Math.random();
    room.imposterIds = [];
    room.gameMode = 'Normal';

    if (roll < 0.15) {
      // 15% Chance: PARANOIA MODE (0 Imposters)
      room.gameMode = 'Paranoia';
    } else if (roll > 0.85 && room.players.length >= 5) {
      // 15% Chance: THE SYNDICATE (2 Imposters, requires 5+ players)
      room.gameMode = 'Syndicate';
      let shuffled = [...room.players].sort(() => 0.5 - Math.random());
      room.imposterIds = [shuffled[0].id, shuffled[1].id];
    } else {
      // 70% Chance: STANDARD (1 Imposter)
      let randomIndex = Math.floor(Math.random() * room.players.length);
      room.imposterIds = [room.players[randomIndex].id];
    }

    room.currentQuestion = QUESTION_BANK[Math.floor(Math.random() * QUESTION_BANK.length)];
    room.gameState = 'question';
    room.revealPhase = 'none';
    io.to(roomId).emit('roomState', room);
  });

  socket.on('submitAnswer', ({ roomId, answer }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.answer = answer;

    if (room.players.every(p => p.answer.trim().length > 0)) {
      room.gameState = 'debate';
      room.timer = 60;
      io.to(roomId).emit('roomState', room);

      const intervalId = setInterval(() => {
        const liveRoom = rooms.get(roomId);
        if (!liveRoom || liveRoom.gameState !== 'debate') return clearInterval(intervalId);
        
        liveRoom.timer--;
        if (liveRoom.timer <= 0) {
          liveRoom.gameState = 'voting';
          clearInterval(intervalId);
        }
        io.to(roomId).emit('roomState', liveRoom);
      }, 1000);
    } else {
      io.to(roomId).emit('roomState', room);
    }
  });

  socket.on('submitVote', ({ roomId, targetPlayerId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    
    if (player && !player.hasVoted) {
      player.votedFor = targetPlayerId;
      player.hasVoted = true;
    }

    if (room.players.every(p => p.hasVoted)) {
      calculateScores(room);
      room.gameState = 'reveal';
      room.revealPhase = 'votes';
      io.to(roomId).emit('roomState', room);

      setTimeout(() => {
        const liveRoom = rooms.get(roomId);
        if (liveRoom && liveRoom.gameState === 'reveal') {
          liveRoom.revealPhase = 'identity';
          io.to(roomId).emit('roomState', liveRoom);
        }
      }, 6000); // 6 second delay for dramatic tension
    } else {
      io.to(roomId).emit('roomState', room);
    }
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) rooms.delete(roomId);
        else {
          if (!room.players.some(p => p.isHost)) room.players[0].isHost = true;
          io.to(roomId).emit('roomState', room);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Suspect Spectrum Chaos Engine live on port ${PORT}`);
});