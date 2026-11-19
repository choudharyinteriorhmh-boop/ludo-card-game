const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function createDeck() {
  const suits = ['♠️', '♥️', '♦️', '♣️'];
  const values = [
    { label: '2', rank: 2 }, { label: '3', rank: 3 }, { label: '4', rank: 4 },
    { label: '5', rank: 5 }, { label: '6', rank: 6 }, { label: '7', rank: 7 },
    { label: '8', rank: 8 }, { label: '9', rank: 9 }, { label: '10', rank: 10 },
    { label: 'J', rank: 11 }, { label: 'Q', rank: 12 }, { label: 'K', rank: 13 },
    { label: 'A', rank: 14 }
  ];
  let deck = [];
  for (let s of suits) {
    for (let v of values) {
      deck.push({ text: v.label + s, rank: v.rank, suit: s });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function evaluateHand(cards) {
  if (!cards || cards.length < 3) return 0;
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const r1 = sorted[0].rank, r2 = sorted[1].rank, r3 = sorted[2].rank;
  const isSameSuit = sorted[0].suit === sorted[1].suit && sorted[1].suit === sorted[2].suit;
  const isSeq = (r1 - r2 === 1 && r2 - r3 === 1) || (r1 === 14 && r2 === 3 && r3 === 2);

  if (r1 === r2 && r2 === r3) return 600 + r1;
  if (isSameSuit && isSeq) return 500 + r1;
  if (isSeq) return 400 + r1;
  if (isSameSuit) return 300 + r1;
  if (r1 === r2 || r2 === r3) return 200 + r2;
  return 100 + r1;
}

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        gameMode: 'ludo',
        turnIndex: 0,
        pot: 0
      };
    }

    const room = rooms[roomId];
    if (room.players.length >= 4) {
      socket.emit('errorMsg', 'रूम फुल है! अधिकतम 4 खिलाड़ी खेल सकते हैं।');
      return;
    }

    const colors = ['#ff4d4d', '#2ecc71', '#f1c40f', '#3498db'];
    const colorNames = ['Red', 'Green', 'Yellow', 'Blue'];

    const player = {
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      color: colors[room.players.length],
      colorName: colorNames[room.players.length],
      coins: 1000,
      ludoPos: 0,
      cards: []
    };

    room.players.push(player);
    io.to(roomId).emit('updateRoom', room);
  });

  socket.on('claimFreeCoins', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.coins += 500;
      io.to(roomId).emit('updateRoom', room);
    }
  });

  socket.on('switchGame', ({ roomId, mode }) => {
    if (rooms[roomId]) {
      rooms[roomId].gameMode = mode;
      io.to(roomId).emit('updateRoom', rooms[roomId]);
    }
  });

  socket.on('startLudoMatch', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) {
      socket.emit('errorMsg', 'खेलने के लिए कम से कम 2 खिलाड़ी चाहिए!');
      return;
    }
    room.pot = 0;
    room.turnIndex = 0;
    room.players.forEach(p => {
      if (p.coins >= 100) {
        p.coins -= 100;
        room.pot += 100;
      }
      p.ludoPos = 0;
    });
    io.to(roomId).emit('ludoStarted', room);
  });

  socket.on('rollDice', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.players.length === 0) return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    const diceValue = Math.floor(Math.random() * 6) + 1;
    currentPlayer.ludoPos += diceValue;

    let winner = null;
    if (currentPlayer.ludoPos >= 40) {
      currentPlayer.ludoPos = 40;
      currentPlayer.coins += room.pot;
      winner = `${currentPlayer.name} (+${room.pot} Coins)`;
      room.pot = 0;
    }

    if (diceValue !== 6 && !winner) {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    }

    io.to(roomId).emit('diceResult', {
      player: currentPlayer.name,
      dice: diceValue,
      room: room,
      winner: winner
    });
  });

  socket.on('dealCards', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) {
      socket.emit('errorMsg', 'कार्ड गेम के लिए कम से कम 2 खिलाड़ी चाहिए!');
      return;
    }

    const deck = createDeck();
    room.pot = 0;
    room.players.forEach((p) => {
      if (p.coins >= 100) {
        p.coins -= 100;
        room.pot += 100;
      }
      p.cards = [deck.pop(), deck.pop(), deck.pop()];
    });

    io.to(roomId).emit('cardsDealt', room);
  });

  socket.on('showCards', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    let bestScore = -1;
    let winnerPlayer = null;

    room.players.forEach(p => {
      const score = evaluateHand(p.cards);
      if (score > bestScore) {
        bestScore = score;
        winnerPlayer = p;
      }
    });

    if (winnerPlayer) {
      winnerPlayer.coins += room.pot;
      const winAmount = room.pot;
      room.pot = 0;
      io.to(roomId).emit('cardWinner', {
        winnerName: winnerPlayer.name,
        winAmount: winAmount,
        room: room
      });
    }
  });

  socket.on('disconnect', () => {
    for (let roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
      } else {
        rooms[roomId].turnIndex = 0;
        io.to(roomId).emit('updateRoom', rooms[roomId]);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
        
