import { SessionManager } from '../dist/index.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const fixture=fileURLToPath(new URL('../tests/fixtures/terminal.py',import.meta.url));
const manager=new SessionManager({config:{default_terminate_grace_ms:100}});
const lines=[];
const log=(line)=>{lines.push(line);console.log(line);};
const tracked=new Set(),groups=new Set();
const snapshot=()=>{
  const raw=execFileSync('ps',['-axo','pid,ppid,pgid,stat,command'],{encoding:'utf8'});
  const rows=raw.split('\n').slice(1).filter(line=>{
    const fields=line.trim().split(/\s+/);return tracked.has(Number(fields[0]))||groups.has(Number(fields[2]));
  });
  return rows;
};
log('UTC='+new Date().toISOString()+' OS='+process.platform+' ARCH='+process.arch+' NODE='+process.version+' UID='+process.getuid());
try {
  const sessions=[];
  for(const mode of ['group','ignore-term']) {
    const s=await manager.create({argv:['python3','-u',fixture,mode]});
    await manager.waitFor({session_id:s.session_id,cursor:s.initial_cursor,pattern:{type:'literal',value:mode==='group'?'GROUP:':'READY:'},timeout_ms:2000});
    const output=(await manager.read({session_id:s.session_id,cursor:s.initial_cursor})).events.map(e=>e.text).join('');
    const match=mode==='group'?/GROUP:(\d+):(\d+)/.exec(output):/READY:(\d+)/.exec(output);
    if(!match)throw new Error('无法取得fixture进程ID');
    match.slice(1).map(Number).forEach(pid=>tracked.add(pid));groups.add(Number(match[1]));sessions.push(s);
  }
  log('COMMAND: ps -axo pid,ppid,pgid,stat,command');
  log('TRACKED_PIDS='+[...tracked].join(',')+' TRACKED_PGIDS='+[...groups].join(','));
  log('BEFORE_TERMINATE\n'+snapshot().join('\n'));
  for(const s of sessions)await manager.terminate({session_id:s.session_id,grace_ms:100});
  for(const s of sessions){
    const until=Date.now()+5000;
    while(Date.now()<until){
      const state=manager.status({session_id:s.session_id});
      if(state.status==='exited'&&state.output_closed&&state.cleanup_result!=='pending'){
        log('FINAL_STATUS='+JSON.stringify(state));break;
      }
      await sleep(20);
    }
  }
  await manager.close();await sleep(100);
  const after=snapshot();log('AFTER_TERMINATE\n'+(after.join('\n')||'(no rows)'));
  const zombies=after.filter(line=>line.trim().split(/\s+/)[3]?.startsWith('Z'));
  log('REMAINING_TRACKED_ROWS='+after.length+' TRACKED_ZOMBIES='+zombies.length);
  if(after.length)throw new Error('受管fixture仍残留，证据验收失败。');
  log('PASS：所有本次跟踪的根进程、组内子进程均不再出现在 ps 中。');
  log('范围：只证明本次fixture与受管PGID；不声称清除逃逸后代或全部OS进程。');
} finally {
  await manager.close();mkdirSync('docs/evidence',{recursive:true});
  writeFileSync('docs/evidence/process-cleanup.txt',lines.join('\n')+'\n');
}
