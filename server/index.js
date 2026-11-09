import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true } });
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '../dist')));
app.use((_req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));

const rooms = new Map();
const queue = [];
const labels = ['방어권', '행운의 지갑', '응급 키트'];
const random = (arr) => arr[Math.floor(Math.random() * arr.length)];
const publicRoom = (r, viewerId) => ({ id:r.id, phase:r.phase, players:r.players.map(({id,name,hp,coins,alive,shield,hand,spinReady})=>({id,name,hp,coins,alive,shield,hand:id===viewerId?hand:[],spinReady:id===viewerId?spinReady:false,isHost:id===r.players[0]?.id})), turn:r.turn, turnId:r.players[r.turn]?.id, log:r.log.slice(-12), deadline:r.deadline, winner:r.winner });
function emitRoom(r) { for (const p of r.players) io.to(p.id).emit('room', publicRoom(r, p.id)); }
function createRoom() { return { id: Math.random().toString(36).slice(2,8).toUpperCase(), phase:'waiting', players:[], turn:0, log:[], deadline:Date.now()+30000, timer:null, winner:null }; }
function start(r) { if (r.phase !== 'waiting' || r.players.length < 2) return; clearTimeout(r.timer); r.phase='playing'; r.deadline=null; r.log.push('게임 시작! 순서대로 카드를 뽑고 룰렛을 돌리세요.'); emitRoom(r); }
function schedule(r) { r.timer=setTimeout(()=>start(r),30000); }
function addPlayer(socket, name) {
  let r = [...rooms.values()].find(x=>x.phase==='waiting' && x.players.length<4);
  if (!r) { r=createRoom(); rooms.set(r.id,r); schedule(r); }
  r.players.push({id:socket.id,name:(name||'플레이어').slice(0,12),hp:100,coins:1000,alive:true,shield:0,hand:[],spinReady:false});
  socket.join(r.id); socket.data.roomId=r.id;
  r.log.push(`${name||'플레이어'}님이 입장했습니다. (${r.players.length}/4)`);
  if (r.players.length===4 || (r.players.length>=2 && Date.now()>=r.deadline)) start(r); else emitRoom(r);
}
function endCheck(r) { const alive=r.players.filter(p=>p.alive); if(alive.length<=1){r.phase='ended';r.winner=alive[0]?.id||null;r.log.push(alive[0]?`${alive[0].name} 승리!`:'모두 탈락했습니다.');} }
function current(r,socket) { return r.phase==='playing' && r.players[r.turn]?.id===socket.id; }
function advance(r) { let next=r.turn; for(let i=0;i<r.players.length;i++){next=(next+1)%r.players.length;if(r.players[next].alive)break;}r.turn=next; emitRoom(r); }
io.on('connection', socket=>{
  socket.on('join',({name})=>addPlayer(socket,name));
  socket.on('draw',()=>{const r=rooms.get(socket.data.roomId);if(!r||!current(r,socket))return;const p=r.players[r.turn];if(p.hand.length||p.spinReady||p.coins<100)return;p.coins-=100;const card=random(labels);p.hand.push(card);p.spinReady=true;r.log.push(`${p.name} 카드 획득: ${card} (−100 코인)`);if(card==='방어권')p.shield++;if(card==='행운의 지갑')p.coins+=random([200,300,500]);if(card==='응급 키트')p.hp=Math.min(100,p.hp+15);emitRoom(r);});
  socket.on('skipCard',()=>{const r=rooms.get(socket.data.roomId);if(!r||!current(r,socket))return;const p=r.players[r.turn];if(p.hand.length||p.spinReady)return;p.spinReady=true;r.log.push(`${p.name} 카드 뽑기를 건너뛰었습니다.`);emitRoom(r);});
  socket.on('spin',()=>{const r=rooms.get(socket.data.roomId);if(!r||!current(r,socket))return;const p=r.players[r.turn];if(!p.spinReady)return;const outcome=random(['self15','self30','attack15','attack25','heal25']);if(outcome==='heal25'){const restored=Math.min(25,100-p.hp);p.hp=Math.min(100,p.hp+25);r.log.push(`${p.name} 룰렛 결과: HP ${restored} 회복!`);}else if(outcome.startsWith('self')){const damage=Number(outcome.slice(4));p.hp-=damage;r.log.push(`${p.name} 룰렛 결과: ${damage} 피해!`);}else{const targets=r.players.filter(x=>x.alive&&x.id!==p.id);if(!targets.length)return;const target=random(targets),damage=Number(outcome.slice(6));if(target.shield){target.shield--;r.log.push(`${p.name}의 ${damage} 공격! ${target.name}이 방어권으로 막았습니다.`);}else{target.hp-=damage;r.log.push(`${p.name}의 룰렛 공격! ${target.name}에게 ${damage} 피해.`);} }
    p.hand=[];p.spinReady=false; for(const player of r.players){if(player.hp<=0&&player.alive){player.alive=false;r.log.push(`${player.name} 탈락!`);}} endCheck(r);if(r.phase==='playing')advance(r);else emitRoom(r);
  });
  socket.on('disconnect',()=>{const r=rooms.get(socket.data.roomId);if(!r)return;const p=r.players.find(x=>x.id===socket.id);if(p&&r.phase==='waiting'){r.players=r.players.filter(x=>x.id!==socket.id);if(!r.players.length){clearTimeout(r.timer);rooms.delete(r.id);}else emitRoom(r);}else if(p&&r.phase==='playing'){p.alive=false;r.log.push(`${p.name} 연결 종료로 탈락했습니다.`);endCheck(r);if(r.phase==='playing'){if(r.players[r.turn]?.id===p.id)advance(r);else emitRoom(r);}else emitRoom(r);}});
});
httpServer.listen(PORT,'0.0.0.0',()=>console.log(`RISK running on ${PORT}`));
