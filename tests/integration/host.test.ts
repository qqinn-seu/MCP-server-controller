import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/session-manager.js';
const host=fileURLToPath(new URL('../fixtures/kernel-host.mjs',import.meta.url));
async function start(mode='normal') {
  // harness 管道只用于观察测试宿主，不是 V1 Pipe 模式或 Pipe 后端。
  const child=spawn(process.execPath,[host,mode],{stdio:['ignore','pipe','pipe']});
  let text='',error='';child.stdout.on('data',data=>text+=data.toString());child.stderr.on('data',data=>error+=data.toString());
  for(let i=0;i<400;i++) {
    const ready=text.split('\n').find(line=>line.includes('"type":"ready"'));
    if(ready)return {child,ready:JSON.parse(ready) as {pid:number;session_id:string;server_epoch:string},text:()=>text};
    if(child.exitCode!==null)throw new Error('宿主提前退出：'+error);await sleep(5);
  }
  child.kill('SIGKILL');throw new Error('宿主没有就绪：'+error);
}
function exists(pid:number) {try{process.kill(pid,0);return true;}catch{return false;}}
async function gone(pid:number) {for(let i=0;i<150&&exists(pid);i++)await sleep(10);expect(exists(pid)).toBe(false);}
describe('真实内核宿主的退出边界',()=>{
  it('HOST-SIGTERM：显式正常退出钩子清理受管根进程',async()=>{
    const h=await start();const exited=once(h.child,'exit');
    try {h.child.kill('SIGTERM');expect((await exited)[0]).toBe(0);expect(h.text()).toContain('"type":"closed"');await gone(h.ready.pid);}
    finally {if(h.child.exitCode===null)h.child.kill('SIGKILL');if(exists(h.ready.pid))process.kill(h.ready.pid,'SIGKILL');}
  });
  it('HOST-CRASH：崩溃可有残留，新实例为空且不碰旧进程，harness 人工收尾',async()=>{
    const h=await start('crash');const exited=once(h.child,'exit');
    try {
      h.child.kill('SIGKILL');await exited;await sleep(40);expect(exists(h.ready.pid)).toBe(true);
      const next=new SessionManager();
      try {expect(next.serverEpoch).not.toBe(h.ready.server_epoch);expect(next.list().sessions).toEqual([]);expect(()=>next.status({session_id:h.ready.session_id})).toThrow();expect(exists(h.ready.pid)).toBe(true);}
      finally {await next.close();}
      // 操作只针对fixture自己报告的PID/PGID，明确不是 Server 重启自动扫描或身份核验。
      process.kill(-h.ready.pid,'SIGTERM');await gone(h.ready.pid);
      const rows=execFileSync('ps',['-axo','pid,ppid,pgid,stat,command'],{encoding:'utf8'}).split('\n');
      expect(rows.some(row=>Number(row.trim().split(/\s+/)[0])===h.ready.pid)).toBe(false);
    } finally {if(h.child.exitCode===null)h.child.kill('SIGKILL');if(exists(h.ready.pid))process.kill(h.ready.pid,'SIGKILL');}
  });
});
