const express = require('express');
const app = express();

var server = require('http').createServer(app), // Serveur HTTP
    // io = require('socket.io').listen(server), // Socket.io pour le realtime
    ent = require('ent'), // Ent pour l'encodage
    session = require('express-session'),
    bodyParser = require('body-parser'),
    expressLayouts = require('express-ejs-layouts');

// ใช้ socket.io v4 syntax
const { Server } = require('socket.io');
const io = new Server(server);

const fs = require('fs'),
      // แก้ไขการอ่านไฟล์คำศัพท์: แยกด้วย regex เพื่อรองรับ \r\n หรือ \n, trim แต่ละคำ และกรองคำว่างออก
      wordFamille = fs.readFileSync('words/famille.csv','utf8')
                      .split(/\r?\n/) // แยกด้วย \r\n หรือ \n
                      .map(word => word.trim()) // ลบช่องว่างหัวท้าย
                      .filter(word => word.length > 0), // กรองคำว่างออก
      gameMasterRole = 'ผู้ดำเนินเกม',
      traitorRole = 'ผู้ทรยศ',
      defaultRole = 'พลเมือง';

// เพิ่ม Set สำหรับเก็บชื่อผู้เล่นที่กำลังออนไลน์อยู่
// เปลี่ยนเป็น Map เพื่อเก็บข้อมูล socketID, สถานะ, และ timeout สำหรับการ rejoin
const currentlyActivePlayers = new Map(); // Key: playerName, Value: { socketId: string, status: 'online' | 'disconnected', disconnectTimeout: Timeout }

// กำหนดเวลาที่อนุญาตให้ rejoin (เช่น 60 วินาที)
const REJOIN_TIMEOUT_SECONDS = 60;

app.use(function(req, res, next){
    if (typeof(game) == 'undefined') {
        game = {
            players: [
                {name: 'ผู้เล่น 1', role: '', vote1: null, vote2: null, nbVote2: 0, isGhost: false, permission: null},
                {name: 'ผู้เล่น 2', role: '', vote1: null, vote2: null, nbVote2: 0, isGhost: false, permission: null},
                {name: 'ผู้เล่น 3', role: '', vote1: null, vote2: null, nbVote2: 0, isGhost: false, permission: null},
                {name: 'แอดมิน', role: '', vote1: null, vote2: null, nbVote2: 0, isGhost: false, permission: 'admin'},
            ],
            online: 0,
            settings: { traitorOptional: true, roundTime: 300 },
            resultVote1: null,
            resultVote2: null
        };
    }
    next();
})

.use(expressLayouts)
.use(session({ secret: process.env.SESSION_SECRET || 'session-insider-secret', cookie: { maxAge: null }}))
.use('/static', express.static(__dirname + '/public'))
.use(bodyParser.urlencoded({
   extended: true
}))

.set('view engine', 'ejs')
.set('layout', 'layouts/layout')

.get('/', function (req, res) {
    // กรองผู้เล่นที่กำลังออนไลน์ (status: 'online') ออกไป
    const availablePlayers = game.players.filter((player) => 
        !isGhostPlayer(player) && 
        (!currentlyActivePlayers.has(player.name) || currentlyActivePlayers.get(player.name).status === 'disconnected')
    );
    res.render('welcome.ejs', {players: availablePlayers});
})

.get('/adminPlayer', function (req, res) {
    res.render('adminPlayer.ejs', {players: game.players, settings: game.settings});
})

.post('/setRoundTime', function (req, res) {
    // store round time in seconds (integer)
    const value = parseInt(req.body.roundTime, 10);
    game.settings.roundTime = (isNaN(value) ? 300 : value);
    res.redirect('/adminPlayer');
})

// เพิ่ม route สำหรับบันทึกการตั้งค่าเกม (traitorOptional)
.post('/setGameSettings', function (req, res) {
    game.settings.traitorOptional = (req.body.traitorOptional === 'on');
    res.redirect('/adminPlayer');
})

.get('/deletePlayer', function (req, res) {
    game.players.forEach(function(playerItem, index) {
        if(playerItem.name == req.query.player) {
            // หากผู้เล่นที่ถูกลบกำลังออนไลน์อยู่ ให้ลบออกจาก Map ด้วย
            if (currentlyActivePlayers.has(playerItem.name)) {
                const playerInfo = currentlyActivePlayers.get(playerItem.name);
                if (playerInfo.disconnectTimeout) {
                    clearTimeout(playerInfo.disconnectTimeout); // เคลียร์ timeout ถ้ามี
                }
                currentlyActivePlayers.delete(playerItem.name);
            }
            game.players.splice(index, 1);
        }
    });

    res.redirect('/adminPlayer');
})

.post('/addPlayer', function (req, res) {
    console.log(req.body.admin);
    game.players.push(
        {name: req.body.player, role: '', vote1: null, vote2: null, nbVote2: 0, isGhost: false, permission: (req.body.admin === 'on' ? 'admin' : null) },
    );

    res.redirect('/adminPlayer');
})

.post('/setWord', function (req, res) {
    if(req.body.word !== '') {
        game.word = req.body.word;
    }
    res.json('ok');
})

.post('/game', function (req, res) {    
    req.session.player = req.body.player;
    res.redirect('/game');
})

.get('/game', function (req, res) {
    if(!req.session.player) {
        res.redirect('/');
    }

    me = game.players.filter((player) => player.name === req.session.player );

    res.render('board.ejs', { player: me[0], status: game.status, resultVote1: game.resultVote1, resultVote2: game.resultVote2 });
})

function resetGame() {
    // ต้องรีเซ็ต isGhost ด้วย
    game.players.forEach(function(player, index) {
        player.role = defaultRole;
        player.vote1 = null;
        player.vote2 = null;
        player.nbVote2 = 0;
        player.isGhost = false; // เพิ่มบรรทัดนี้
    });

    game.word = '';
    game.countdown = null;
    game.resultVote1 = null;
    game.resultVote2 = null;
    game.status = '';
}

function randomRoles(players) {
    resetGame(); // เรียกใช้ resetGame() เพื่อรีเซ็ต isGhost ด้วย

    players = shuffle(players);
    // สุ่มผู้ดำเนินเกม
    const gmIndex = Math.floor(Math.random() * players.length);
    players[gmIndex].role = gameMasterRole;

    // ตรวจสอบการตั้งค่า traitorOptional
    let hasTraitor = true;
    if (game.settings.traitorOptional) {
        // มีโอกาส 30% ที่จะไม่มีผู้ทรยศ (สามารถปรับเปอร์เซ็นต์ได้)
        if (Math.random() < 0.3) { 
            hasTraitor = false;
        }
    }

    if (hasTraitor) {
        setRole(traitorRole);
    } else {
        // ถ้าไม่มีผู้ทรยศ, ให้เลือกผู้เล่นคนหนึ่งเป็น "Ghost" แทน
        // คนนี้จะไม่มีบทบาทผู้ทรยศ แต่จะถูกนับเป็น "ไม่มีผู้ทรยศ" ในผลโหวต
        addGhostPlayerToGame(players);
    }

    // shuffle อีกครั้งเพื่อไม่ให้ตำแหน่งบทบาทเดาได้ง่าย
    players = shuffle(players);

    players.sort(comparePlayer);
    return players;
}

function comparePlayer(a, b) {
    if (a.isGhost) {
       return 1; 
    } else if (a.name > b.name) {
        return 0;
    };

    return -1;
}

function setRole(role) {
    game.players.some(function(player) {
        if(player.role === defaultRole) {
            player.role = role;
            return true;
        }
    }); 
}

function shuffle(players) {
    let ctr = players.length;
    let temp;
    let index;

    while (ctr > 0) {
        index = Math.floor(Math.random() * ctr);
        ctr--;
        temp = players[ctr];
        players[ctr] = players[index];
        players[index] = temp;
    }

    return players;
}

// ฟังก์ชันใหม่สำหรับเพิ่ม Ghost Player เมื่อไม่มีผู้ทรยศ
function addGhostPlayerToGame(players) {
    // เลือกผู้เล่นที่ยังเป็น defaultRole เพื่อเป็น Ghost Player
    const defaultPlayers = players.filter(player => player.role === defaultRole);
    if (defaultPlayers.length > 0) {
        const ghostIndex = players.indexOf(defaultPlayers[Math.floor(Math.random() * defaultPlayers.length)]);
        players[ghostIndex].isGhost = true;
        // ไม่ต้องกำหนด role พิเศษ แค่ isGhost: true ก็พอ
        console.log(`No Traitor in this game. ${players[ghostIndex].name} is the Ghost Player.`);
    }
    return players;
}

// removeGhostPlayer เดิม (ในไฟล์เดิมมีการกรองผู้เล่น isGhost: true ออก)
// แต่ถ้าเราจัดการ isGhost: true ใน randomRoles() แล้ว ก็ไม่จำเป็นต้อง remove อีก
// แต่จะเก็บไว้เผื่อกรณีต้องการรีเซ็ตผู้เล่นผี
function removeGhostPlayer() {
    game.players = game.players.filter((player) => !player.isGhost ); 
}

function getGhostPlayer() {
    ghostPlayer = game.players.filter(isGhostPlayer);

    return ghostPlayer.length > 0 ? ghostPlayer[0] : null;
}

function getWord(data) {
    return data[Math.floor(Math.random() * data.length)];
}

function everybodyHasVoted(voteNumber) {
    // ผู้เล่น Ghost ไม่ต้องโหวต (เดิมก็เป็นแบบนี้แล้ว)
    const hasVoted1 = (currentValue) => currentValue.isGhost || currentValue.vote1 !== null;
    const hasVoted2 = (currentValue) => currentValue.isGhost || currentValue.vote2 !== null;

    if(voteNumber == 1) {
        return game.players.every(hasVoted1);
    } else {
        return game.players.every(hasVoted2);
    }
}

function resetVote(voteNumber) {
    game.players.map(function(player) {
        if(voteNumber === 1) {
            player.vote1 = null;
        } else {
            player.vote2 = null;
        }
    });
}

function isNotGameMaster(player) {
    return player.role !== gameMasterRole;
}

function isGhostPlayer(player) {
    return player.isGhost;
}

function addPlayerVote2(playerVote) {

    game.players.map(function(player) {
        if(playerVote === player.name) {
            player.nbVote2 += 1
        }
    });
}

function compareVote(a, b) {
  if (a.nbVote2 < b.nbVote2) return 1;
  if (b.nbVote2 < a.nbVote2) return -1;

  return 0;
}

function processVote1Result() {
    voteResult = {'up': 0, 'down': 0};
    game.players.some(function(player) {
      if(player.vote1 == '1') {
        voteResult.up += 1;
      } else if(!isGhostPlayer(player)) { // ผู้เล่น Ghost ไม่นับเป็น down vote
        voteResult.down += 1;
      }
    })

    game.resultVote1 = voteResult;
}

function processVote2Result() {
    game.players.forEach(function(player, index) {
        addPlayerVote2(player.vote2);
    });
    votePlayers = game.players.filter(isNotGameMaster);
    votePlayers.sort(compareVote);

    // ตรวจสอบว่ามีผู้ทรยศในเกมจริงๆ หรือไม่
    const actualTraitor = game.players.find(p => p.role === traitorRole);
    let hasTraitorInGame = !!actualTraitor;

    let hasWon;
    let finalResultTraitorName = '';
    const topVotedPlayer = votePlayers[0];
    const secondVotedPlayer = votePlayers[1];

    if (hasTraitorInGame) {
        // กรณีมีผู้ทรยศจริง
        // พลเมืองชนะถ้าโหวตผู้ทรยศถูกคนและผู้ทรยศได้คะแนนโหวตสูงสุดคนเดียว
        if (topVotedPlayer && topVotedPlayer.role === traitorRole && (secondVotedPlayer ? topVotedPlayer.nbVote2 > secondVotedPlayer.nbVote2 : true)) {
            hasWon = true; // พลเมืองชนะ
            finalResultTraitorName = topVotedPlayer.name;
        } else {
            hasWon = false; // ผู้ทรยศชนะ (พลเมืองโหวตผิด)
            finalResultTraitorName = actualTraitor.name; // แสดงชื่อผู้ทรยศที่แท้จริง
        }
    } else {
        // กรณีไม่มีผู้ทรยศ (มี Ghost Player)
        // พลเมืองชนะถ้าโหวต Ghost Player ได้คะแนนสูงสุด
        // หรือถ้าไม่มีผู้เล่นคนใดได้คะแนนโหวต (แสดงว่าไม่เจอใคร)
        if (topVotedPlayer && topVotedPlayer.isGhost && (secondVotedPlayer ? topVotedPlayer.nbVote2 > secondVotedPlayer.nbVote2 : true)) {
            hasWon = true; // พลเมืองชนะ (โหวตเจอ Ghost Player)
            finalResultTraitorName = topVotedPlayer.name + ' (ไม่มีผู้ทรยศ)';
        } else if (!topVotedPlayer || (topVotedPlayer && !topVotedPlayer.isGhost && topVotedPlayer.nbVote2 === 0)) {
             hasWon = true; // พลเมืองชนะ (ไม่เจอผู้ทรยศ หรือโหวตผิดคน แต่ไม่มีผู้ทรยศจริง)
             finalResultTraitorName = 'ไม่มีผู้ทรยศ';
        } else {
            hasWon = false; // ผู้ทรยศชนะ (พลเมืองโหวตผิด)
            finalResultTraitorName = 'ไม่มีผู้ทรยศ (แต่ผู้เล่นโหวตพลาด)'; // ผู้ทรยศชนะจริงๆ คือไม่มีใครเลย 
        }
    }

    game.resultVote2 = { 
        hasWon: hasWon, 
        voteDetail: votePlayers, 
        hasTraitor: hasTraitorInGame,
        finalTraitorName: finalResultTraitorName // เพิ่มชื่อผู้ทรยศ/Ghost Player เพื่อแสดงผล
    };
}
 
// On enclenche le socket d'échange
io.sockets.on('connection', function (socket) {

    socket.on('admin_request_word_roles', function() {
        // ตรวจสอบว่าเป็นแอดมินจริง (permission == 'admin')
        // (ในระบบนี้ client เช็คปุ่ม, ฝั่ง server ส่งข้อมูลให้ทุกคนที่กด แต่ควรเพิ่มความปลอดภัยถ้าต้องการ)
        io.to(socket.id).emit('admin_word_roles', {
            word: game.word,
            players: game.players.map(p => ({ name: p.name, role: p.role }))
        });
    });
 
    socket.join('game');

    // ฟังก์ชันสำหรับส่งรายชื่อผู้เล่นที่ออนไลน์ไปยัง Client ทุกคน
    function emitOnlinePlayerListUpdate() {
        const onlinePlayersArray = Array.from(currentlyActivePlayers.values()).map(p => ({
            name: p.playerName,
            status: p.status
        }));
        io.in('game').emit('onlinePlayerListUpdate', onlinePlayersArray);
    }

    socket.on('newPlayer', function(playerName) {
        // ตรวจสอบว่าชื่อผู้เล่นนี้อยู่ใน Map แล้วหรือไม่
        const existingPlayer = currentlyActivePlayers.get(playerName);

        if (existingPlayer) {
            // ถ้าชื่อถูกใช้งานอยู่แล้ว (สถานะ online)
            if (existingPlayer.status === 'online') {
                console.log(`ชื่อผู้เล่น "${playerName}" ถูกใช้งานอยู่แล้ว`);
                io.to(socket.id).emit('nameInUse', { message: `ชื่อ "${playerName}" ถูกใช้งานอยู่แล้ว กรุณาเลือกชื่ออื่น` });
                return; // หยุดการทำงานของ event นี้
            } 
            // ถ้าชื่ออยู่ใน Map แต่สถานะเป็น 'disconnected' (พยายาม rejoin)
            else if (existingPlayer.status === 'disconnected') {
                console.log(`ผู้เล่น "${playerName}" กลับเข้าสู่เกม`);
                clearTimeout(existingPlayer.disconnectTimeout); // เคลียร์ timeout เดิม
                currentlyActivePlayers.set(playerName, { 
                    ...existingPlayer, 
                    socketId: socket.id, 
                    status: 'online',
                    disconnectTimeout: null // Reset timeout
                });
                socket.playerName = playerName; // เก็บชื่อผู้เล่นไว้ใน socket object
                
                // แจ้งเตือนสถานะผู้เล่น
                game.online = Array.from(currentlyActivePlayers.values()).filter(p => p.status === 'online').length;
                humanPlayers = game.players.filter((player) => !isGhostPlayer(player) );
                offline = humanPlayers.length - game.online;
                io.in('game').emit('playerStatusUpdate', { online: game.online, offline: offline });
                emitOnlinePlayerListUpdate(); // อัปเดตรายชื่อผู้เล่นที่ออนไลน์/หลุด
                return; // จบการทำงานของ event นี้
            }
        }

        // หากชื่อยังไม่ถูกใช้งาน หรือเป็นผู้เล่นใหม่ที่ไม่เคยเชื่อมต่อมาก่อน
        console.log('ผู้เล่นใหม่เชื่อมต่อ : ' + playerName);
        currentlyActivePlayers.set(playerName, { 
            socketId: socket.id, 
            playerName: playerName, 
            status: 'online', 
            disconnectTimeout: null 
        });
        socket.playerName = playerName; // เก็บชื่อผู้เล่นไว้ใน socket object

        game.online = Array.from(currentlyActivePlayers.values()).filter(p => p.status === 'online').length;
        humanPlayers = game.players.filter((player) => !isGhostPlayer(player) );
        offline = humanPlayers.length - game.online;
        console.log('ผู้เล่นออนไลน์ : ' + game.online);

        emitOnlinePlayerListUpdate(); // ส่งข้อมูลผู้เล่นที่ออนไลน์ทั้งหมดไปยังทุก client
        io.in('game').emit('playerStatusUpdate', { online: game.online, offline: offline });
    });

    socket.on('disconnect', function () {
      console.log('ผู้เล่นตัดการเชื่อมต่อ');
      if (socket.playerName) {
          const playerName = socket.playerName;
          const playerInfo = currentlyActivePlayers.get(playerName);

          if (playerInfo && playerInfo.status === 'online') {
              console.log(`ผู้เล่น "${playerName}" หลุดการเชื่อมต่อ`);
              // ทำเครื่องหมายว่าหลุดและตั้งเวลาสำหรับการลบออกจาก Map จริงๆ
              playerInfo.status = 'disconnected';
              playerInfo.disconnectTimeout = setTimeout(() => {
                  console.log(`ผู้เล่น "${playerName}" ถูกลบออกจากเกมหลังจากหลุดการเชื่อมต่อเป็นเวลานาน`);
                  currentlyActivePlayers.delete(playerName);
                  game.online = Array.from(currentlyActivePlayers.values()).filter(p => p.status === 'online').length;
                  humanPlayers = game.players.filter((player) => !isGhostPlayer(player) );
                  offline = humanPlayers.length - game.online;
                  io.in('game').emit('playerStatusUpdate', { online: game.online, offline: offline });
                  emitOnlinePlayerListUpdate();
              }, REJOIN_TIMEOUT_SECONDS * 1000); // แปลงเป็นมิลลิวินาที

              game.online = Array.from(currentlyActivePlayers.values()).filter(p => p.status === 'online').length;
              humanPlayers = game.players.filter((player) => !isGhostPlayer(player) );
              offline = humanPlayers.length - game.online;

              emitOnlinePlayerListUpdate(); // ส่งข้อมูลผู้เล่นที่ออนไลน์ทั้งหมดไปยังทุก client
              io.in('game').emit('playerStatusUpdate', { online: game.online, offline: offline });
          }
      }
    });
    
    socket.on('resetGame', function (object) {
        if (game.countdown !== null) {
            clearInterval(game.countdown);
        }
        game.players = randomRoles(game.players);
        game.word = getWord(wordFamille);
        io.in('game').emit('newRole', { players: game.players });
        game.status = 'role';
    })

    socket.on('revealWord', function (object) {
        io.in('game').emit('revealWord', { players: game.players , word: game.word });
        game.status = 'word';
    })

    socket.on('wordFound', function (object) {
        if (game.countdown !== null) {
            clearInterval(game.countdown);
        }
        io.in('game').emit('wordFound');
        game.status = 'vote1';
    })

    socket.on('displayVote1', function (object) {
        resetVote(1);
        io.in('game').emit('displayVote1');
        game.status = 'vote1';
    })

    socket.on('displayVote2', function () {
        resetVote(2);
        io.in('game').emit('displayVote2', game.players.filter(isNotGameMaster));
        game.status = 'vote2';
    })

    socket.on('vote1', function (object) {
        game.players.map(function(player) {
            if(object.player === player.name) {
                player.vote1 = object.vote;
            }
        });

        if(everybodyHasVoted(1)) {
            processVote1Result();
            io.in('game').emit('vote1Ended', game.resultVote1);
            game.status = 'vote2';
        }
    })

    socket.on('vote2', function (object) {
        game.players.map(function(player) {
            if(object.player === player.name) {
                player.vote2 = object.vote;
            }
        });

        if(everybodyHasVoted(2)) {
            processVote2Result();
            io.in('game').emit('vote2Ended', game.resultVote2);
            game.status = 'end';
        }
    })

    socket.on('startGame', function (object) {
        let counter = game.settings && game.settings.roundTime ? game.settings.roundTime : 300;
        if (game.countdown !== null) {
            clearInterval(game.countdown);
        }  
        game.countdown = setInterval(function(){
            counter--
            if (counter === 0) {
              clearInterval(this);
            }
            io.in('game').emit('countdownUpdate', counter);
        }, 1000);

        io.in('game').emit('startGame', {});
        game.status = 'in_progress';
    })
 
}) 
 
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
