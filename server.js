import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allows any frontend to connect
    methods: ["GET", "POST"]
  }
});

// Global game state stored entirely in RAM (100% Free)
const rooms = new Map();

// High-quality question bank with subtle variations and ranges for the imposter
const QUESTION_BANK = [
  { trueQuestion: "How many minutes are in 3.5 hours?", decoyQuestion: "Guess a number between 180 and 240" },
  { trueQuestion: "What is the standard cooking temperature (in Celsius) for baking a cake?", decoyQuestion: "Guess a temperature between 150°C and 200°C" },
  { trueQuestion: "How many keys are on a standard grand piano?", decoyQuestion: "How many human bones are in an adult body?" },
  { trueQuestion: "What is the typical flight speed of a commercial passenger jet in mph?", decoyQuestion: "Pick a high speed number between 450 and 600" },
  { trueQuestion: "How many days are in a leap year?", decoyQuestion: "Pick a number between 350 and 370" },
  { trueQuestion: "What is the capital city of Australia?", decoyQuestion: "Name a well-known Australian city that is NOT Sydney" },
  { trueQuestion: "What animal is known as the 'Ship of the Desert'?", decoyQuestion: "Name a large mammal found in hot, arid environments" },
  { trueQuestion: "How many structural bones make up a human adult skull?", decoyQuestion: "Pick a number between 15 and 30" }
];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function calculateScores(room) {
  const imposter = room.players.find(p => p.id === room.imposterId);
  if (!imposter) return;

  // Count votes
  const voteCounts = {};
  room.players.forEach(p => {
    if (p.votedFor) {
      voteCounts[p.votedFor] = (voteCounts[p.votedFor] || 0) + 1;
    }
  });

  // Find who got the most votes
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

  const imposterCaught = mostVotedIds.includes(room.imposterId);

  // Update scores based on game rules
  room.players.forEach(p => {
    if (p.id !== room.imposterId) {
      // Crewmembers get 1 point if they correctly voted for the imposter
      if (p.votedFor === room.imposterId) {
        p.score += 1;
      }
    } else {
      // Imposter gets 3 points if they successfully blended in and weren't caught
      if (!imposterCaught) {
        p.score += 3;
      }
    }
  });
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('createRoom', ({ playerName }) => {
    const roomId = generateRoomCode();
    const newPlayer = {
      id: socket.id,
      name: playerName,
      score: 0,
      answer: '',
      votedFor: '',
      hasVoted: false,
      isHost: true
    };

    rooms.set(roomId, {
      id: roomId,
      players: [newPlayer],
      gameState: 'lobby', // lobby, question, debate, voting, reveal
      revealPhase: 'none', // none, votes, identity
      imposterId: null,
      currentQuestion: null,
      timer: 0
    });

    socket.join(roomId);
    socket.emit('roomState', rooms.get(roomId));
  });

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const code = roomId.toUpperCase();
    if (!rooms.has(code)) {
      return socket.emit('errorMsg', 'Room not found!');
    }

    const room = rooms.get(code);
    if (room.gameState !== 'lobby') {
      return socket.emit('errorMsg', 'Game already in progress!');
    }

    const newPlayer = {
      id: socket.id,
      name: playerName,
      score: 0,
      answer: '',
      votedFor: '',
      hasVoted: false,
      isHost: false
    };

    room.players.push(newPlayer);
    socket.join(code);
    io.to(code).emit('roomState', room);
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.players.length < 3) {
      return io.to(roomId).emit('errorMsg', 'Need at least 3 players to start!');
    }

    // Reset loop states
    room.players.forEach(p => {
      p.answer = '';
      p.votedFor = '';
      p.hasVoted = false;
    });

    // Select Imposter
    const randomIndex = Math.floor(Math.random() * room.players.length);
    room.imposterId = room.players[randomIndex].id;

    // Select Question
    const randomQuestion = QUESTION_BANK[Math.floor(Math.random() * QUESTION_BANK.length)];
    room.currentQuestion = randomQuestion;

    room.gameState = 'question';
    room.revealPhase = 'none';
    io.to(roomId).emit('roomState', room);
  });

  socket.on('submitAnswer', ({ roomId, answer }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.answer = answer;

    // Check if everyone has submitted an answer
    const allSubmitted = room.players.every(p => p.answer.trim().length > 0);
    if (allSubmitted) {
      room.gameState = 'debate';
      room.timer = 60; // 60 second debate window
      io.to(roomId).emit('roomState', room);

      // Simple server-side debate countdown clock
      const intervalId = setInterval(() => {
        const liveRoom = rooms.get(roomId);
        if (!liveRoom || liveRoom.gameState !== 'debate') {
          clearInterval(intervalId);
          return;
        }

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

    const allVoted = room.players.every(p => p.hasVoted);
    if (allVoted) {
      calculateScores(room);
      room.gameState = 'reveal';
      room.revealPhase = 'votes'; // Show who voted who first
      io.to(roomId).emit('roomState', room);

      // Automated Dramatic Delay Chain for the "Red Screen" reveal effect
      setTimeout(() => {
        const liveRoom = rooms.get(roomId);
        if (liveRoom && liveRoom.gameState === 'reveal') {
          liveRoom.revealPhase = 'identity'; // Instant global device execution shift
          io.to(roomId).emit('roomState', liveRoom);
        }
      }, 5000); // Wait 5 seconds displaying voting maps before screen color blast
    } else {
      io.to(roomId).emit('roomState', room);
    }
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          // Pass host duties if host left
          if (!room.players.some(p => p.isHost)) {
            room.players[0].isHost = true;
          }
          io.to(roomId).emit('roomState', room);
        }
      }
    });
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Suspect Spectrum Engine running flawlessly on port ${PORT}`);
});