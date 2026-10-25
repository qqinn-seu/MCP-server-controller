import { SessionManager, installShutdownHooks } from '../../dist/index.js';
import { fileURLToPath } from 'node:url';
const fixture=fileURLToPath(new URL('./terminal.py',import.meta.url));
const manager=new SessionManager({config:{default_terminate_grace_ms:50}});
const detach=installShutdownHooks(manager,()=>{
  console.log(JSON.stringify({type:'closed',sessions:manager.list().sessions.length}));
  detach();process.exit(0);
});
const mode=process.argv[2]==='crash'?'ignore-hup':'quiet';
const s=await manager.create({argv:['python3','-u',fixture,mode]});
await manager.waitFor({session_id:s.session_id,cursor:s.initial_cursor,pattern:{type:'literal',value:'READY:'},timeout_ms:2000});
const raw=(await manager.read({session_id:s.session_id,cursor:s.initial_cursor})).events.map(e=>e.text).join('');
const pid=Number(/READY:(\d+)/.exec(raw)?.[1]);
console.log(JSON.stringify({type:'ready',pid,session_id:s.session_id,server_epoch:manager.serverEpoch}));
