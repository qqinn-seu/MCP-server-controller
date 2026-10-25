import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SessionManager, type CoreEvent } from '../../src/core/session-manager.js';
import { CoreError, resultOf } from '../../src/contracts/errors.js';
import type { CreateData } from '../../src/contracts/types.js';
import type { CoreConfig } from '../../src/core/config.js';
import { spawnPty, type ProcessHandle } from '../../src/core/pty-backend.js';

const fixture = fileURLToPath(new URL('../fixtures/terminal.py', import.meta.url));
const managers: SessionManager[] = [];
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
function manager(config:Partial<CoreConfig> = {}) {
  const m = new SessionManager({ config: { default_terminate_grace_ms: 80, ...config } }); managers.push(m); return m;
}
async function finished(m:SessionManager,id:string) {
  for(let i=0;i<250;i++) {
    const state=m.status({session_id:id});
    if(state.status==='exited'&&state.output_closed&&state.cleanup_result!=='pending')return state;
    await delay(10);
  }
  throw new Error('会话未按时结束。');
}
async function launch(m:SessionManager,mode:string,extra:string[]=[]):Promise<CreateData> {
  return m.create({argv:['python3','-u',fixture,mode,...extra]});
}
async function match(m:SessionManager,s:CreateData,value:string,cursor=s.initial_cursor) {
  return m.waitFor({session_id:s.session_id,cursor,pattern:{type:'literal',value},timeout_ms:2000});
}
afterEach(async()=>{ await Promise.all(managers.splice(0).map(m=>m.close())); });

describe('真实 PTY：15.1 Linux 全量验收',()=>{
  it('TTY-CONTROL：stdin/stdout 是终端且受管 PGID 与 SID 相同',async()=>{
    const m=manager();const out=await m.run({argv:['python3','-u',fixture,'tty'],wait_timeout_ms:2000});
    expect(out.mode).toBe('pty');expect(out.outcome).toBe('completed');
    const line=out.events.map(x=>x.text).join('');const parts=/TTY:True:True:(\d+):(\d+)/.exec(line);
    expect(parts).not.toBeNull();expect(parts?.[1]).toBe(parts?.[2]);expect(out.exit_code).toBe(0);
  });
  it('REPL-STATE：同一个 Python REPL 保留变量与后续输入',async()=>{
    const m=manager();const s=await m.create({argv:['python3','-i','-q']});
    expect((await match(m,s,'>>> ')).outcome).toBe('matched');
    await m.write({session_id:s.session_id,text:'values = [2, 3, 5]\n'});
    const cursor=m.status({session_id:s.session_id}).latest_cursor!;
    await m.write({session_id:s.session_id,text:'print("RESULT:", sum(values))\n'});
    expect((await match(m,s,'RESULT: 10',cursor)).outcome).toBe('matched');
    await m.write({session_id:s.session_id,text:'print("NEXT:", len(values))\n'});
    expect((await match(m,s,'NEXT: 3',cursor)).outcome).toBe('matched');
    await m.write({session_id:s.session_id,text:'exit()\n'});expect((await finished(m,s.session_id)).exit_code).toBe(0);
    await expect(m.write({session_id:s.session_id,text:'x\n'})).rejects.toMatchObject({code:'SESSION_NOT_RUNNING'});
  });
  it('WIZARD-NO-LF：无换行提示可读，write 不隐式换行',async()=>{
    const m=manager(),s=await launch(m,'wizard');
    expect((await match(m,s,'Name? ')).outcome).toBe('matched');
    await m.write({session_id:s.session_id,text:'Ada'});
    const absent=await m.waitFor({session_id:s.session_id,cursor:s.initial_cursor,pattern:{type:'literal',value:'HELLO:Ada'},timeout_ms:60});
    expect(absent.outcome).toBe('timeout');
    await m.write({session_id:s.session_id,text:'\n'});
    expect((await match(m,s,'HELLO:Ada')).outcome).toBe('matched');
    await m.write({session_id:s.session_id,text:'42\n'});expect((await match(m,s,'ANSWER:Ada:42')).outcome).toBe('matched');
    expect((await finished(m,s.session_id)).exit_code).toBe(0);
  });
  it('WAIT-SGR-SPLIT：调用内跨块去颜色并匹配，原日志保留 SGR',async()=>{
    const m=manager(),s=await launch(m,'split');
    const wait=await match(m,s,'Server listening');expect(wait.outcome).toBe('matched');
    expect(wait.matched_text).toBe('Server listening');
    const raw=(await m.read({session_id:s.session_id,cursor:s.initial_cursor})).events.map(x=>x.text).join('');
    expect(raw).toContain('\x1b[32m');
  });
  it('RUN-SAME-NONZERO：超时 background 的同一会话继续运行且非零退出不报工具失败',async()=>{
    const m=manager();const out=await m.run({argv:['python3','-u',fixture,'long','0.2'],wait_timeout_ms:10});
    expect(out.outcome).toBe('background');expect(m.list().sessions).toHaveLength(1);
    const s=await finished(m,out.session_id);expect(s.exit_code).toBe(7);expect(s.signal).toBeNull();
    const result=await resultOf(()=>m.read({session_id:out.session_id,cursor:out.initial_cursor}));
    expect(result.ok).toBe(true);if(result.ok)expect(result.data.events.map(x=>x.text).join('')).toContain('FINAL_ERROR');
    expect(m.list().sessions[0]?.session_id).toBe(out.session_id);
  });
  it('RUN-PAGE：run 只返回预算内一页，next_cursor 可续读完整超长输出',async()=>{
    const m=manager();const out=await m.run({argv:['python3','-u',fixture,'long','0'],wait_timeout_ms:2000,max_output_bytes:256});
    expect(out.outcome).toBe('completed');expect(out.has_more).toBe(true);
    let text=out.events.map(x=>x.text).join(''),cursor=out.next_cursor;
    for(let i=0;i<100;i++){
      const page=await m.read({session_id:out.session_id,cursor,max_bytes:256});
      expect(Buffer.byteLength(page.events.map(x=>x.text).join(''))).toBeLessThanOrEqual(256);
      text+=page.events.map(x=>x.text).join('');cursor=page.next_cursor;if(page.eof)break;
    }
    expect(text).toContain('FINAL_ERROR');expect(text).toContain('汉字🙂');expect(text).not.toContain('\ufffd');
  });
  it('TWO-READERS：同游标重读不消费且会话输出不串流',async()=>{
    const m=manager();const a=await m.run({argv:['/bin/sh','-c','printf ONLY_A'],wait_timeout_ms:1000});
    const b=await m.run({argv:['/bin/sh','-c','printf ONLY_B'],wait_timeout_ms:1000});
    const [r1,r2]=await Promise.all([m.read({session_id:a.session_id,cursor:a.initial_cursor}),m.read({session_id:a.session_id,cursor:a.initial_cursor})]);
    expect(r1.events).toEqual(r2.events);expect(r1.events.map(x=>x.text).join('')).toBe('ONLY_A');
    expect((await m.read({session_id:b.session_id,cursor:b.initial_cursor})).events.map(x=>x.text).join('')).toBe('ONLY_B');
    await expect(m.read({session_id:b.session_id,cursor:a.initial_cursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  });
  it('RING-GAPS：旧 read 报过期、wait 报缺口、run 首页保留缺口事实',async()=>{
    const m=manager({per_session_output_bytes:1024});
    const out=await m.run({argv:['python3','-u',fixture,'flood'],wait_timeout_ms:2000,max_output_bytes:256});
    expect(out.gap?.reason).toBe('retention_eviction');
    expect(m.status({session_id:out.session_id}).retained_output_bytes).toBeLessThanOrEqual(1024);
    await expect(m.read({session_id:out.session_id,cursor:out.initial_cursor})).rejects.toMatchObject({code:'CURSOR_EXPIRED',details:{earliest_cursor:out.earliest_cursor}});
    expect((await m.waitFor({session_id:out.session_id,cursor:out.initial_cursor,pattern:{type:'literal',value:'TAIL_DONE'},timeout_ms:0})).outcome).toBe('output_gap');
    expect(m.status({session_id:out.session_id}).log_has_gaps).toBe(true);
  });
  it('READ-TIMEOUT：无新增的 read 返回正常空页并保留 cursor',async()=>{
    const m=manager(),s=await launch(m,'quiet');await match(m,s,'READY:');
    const cursor=m.status({session_id:s.session_id}).latest_cursor!;
    const result=await m.read({session_id:s.session_id,cursor,wait_ms:30});
    expect(result.timed_out).toBe(true);expect(result.next_cursor).toBe(cursor);expect(result.eof).toBe(false);
  });
  it('TERM-KILL-REAP：忽略 TERM 的根进程被 KILL，重复终止不新建任务且 PID 已回收',async()=>{
    const m=manager(),s=await launch(m,'ignore-term');await match(m,s,'READY:');
    const raw=(await m.read({session_id:s.session_id,cursor:s.initial_cursor})).events.map(x=>x.text).join('');
    const pid=Number(/READY:(\d+)/.exec(raw)?.[1]);expect(pid).toBeGreaterThan(1);
    const first=await m.terminate({session_id:s.session_id,grace_ms:30});
    expect(first.cleanup_result).toBe('pending');await m.terminate({session_id:s.session_id,grace_ms:30});
    const final=await finished(m,s.session_id);expect(final.signal).toBe('SIGKILL');expect(final.exit_code).toBeNull();
    expect(final.cleanup_result).toBe('group_cleared');expect(()=>process.kill(pid,0)).toThrow();
  });
  it('CTRL-C：控制字符作用于前台程序，不等于 terminate',async()=>{
    const m=manager(),s=await launch(m,'ctrl');await match(m,s,'CTRL_READY');
    const receipt=await m.write({session_id:s.session_id,key:'CTRL_C'});expect(receipt.delivery).toBe('queued');
    const final=await finished(m,s.session_id);expect(final.termination_reason).toBeNull();
    expect((await m.read({session_id:s.session_id,cursor:s.initial_cursor})).events.map(x=>x.text).join('')).toContain('INTERRUPTED');
  });
  it('CTRL-SHELL：Ctrl-C 结束前台 sleep 后，根 Shell 仍能继续交互',async()=>{
    const m=manager();const s=await m.create({argv:['/bin/sh','-i']});
    await delay(40);await m.write({session_id:s.session_id,text:'sleep 5\n'});await delay(70);
    await m.write({session_id:s.session_id,key:'CTRL_C'});await delay(50);
    const cursor=m.status({session_id:s.session_id}).latest_cursor!;
    await m.write({session_id:s.session_id,text:'printf "SHELL_%s\\n" ALIVE\n'});
    expect((await match(m,s,'SHELL_ALIVE',cursor)).outcome).toBe('matched');expect(m.status({session_id:s.session_id}).status).toBe('running');
  });
  it('GROUP-CLEAN：组内子进程终止，fixture 父进程 wait 回收子进程',async()=>{
    const m=manager(),s=await launch(m,'group');await match(m,s,'GROUP:');
    const raw=(await m.read({session_id:s.session_id,cursor:s.initial_cursor})).events.map(x=>x.text).join('');
    const ids=/GROUP:(\d+):(\d+)/.exec(raw);expect(ids).not.toBeNull();
    await m.terminate({session_id:s.session_id,grace_ms:500});
    expect((await finished(m,s.session_id)).cleanup_result).toBe('group_cleared');
    for(const pid of ids!.slice(1).map(Number))expect(()=>process.kill(pid,0)).toThrow();
  });
  it('CLOSE-ALL：正常 close 清理全部受管会话，不恢复新实例旧会话',async()=>{
    const m=manager();const a=await launch(m,'quiet'),b=await launch(m,'ignore-term');
    await match(m,a,'READY:');await match(m,b,'READY:');
    const pids=await Promise.all([a,b].map(async s=>Number(/READY:(\d+)/.exec((await m.read({session_id:s.session_id,cursor:s.initial_cursor})).events.map(x=>x.text).join(''))?.[1])));
    await m.close();expect(m.list().sessions).toHaveLength(0);
    for(const pid of pids)expect(()=>process.kill(pid,0)).toThrow();
    const next=manager();expect(next.serverEpoch).not.toBe(m.serverEpoch);expect(next.list().sessions).toHaveLength(0);
    expect(()=>next.status({session_id:a.session_id})).toThrowError(CoreError);
  });
  it('SCHEMA-CORE：基础互斥与边界、Pipe、列表分页均拒绝',async()=>{
    const m=manager();
    const bad=[{argv:['/bin/sh'],shell_command:'echo x'},{argv:['/bin/sh'],mode:'pipe'},{argv:[]},
      {argv:['/bin/sh'],cols:0},{argv:['/bin/sh'],runtime_timeout_ms:0},{argv:['/bin/sh'],foo:'unknown'},
      {argv:['/bin/sh'],shell:'/bin/sh'},{argv:['/bin/sh'],env:{'bad-key':'x'}}];
    for(const input of bad)await expect(m.create(input as any)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
    expect(()=>m.list({limit:1} as any)).toThrowError(CoreError);
    await expect(m.create({argv:['missing-program-for-test-uniquename']})).rejects.toMatchObject({code:'SPAWN_FAILED'});
    expect(m.list().sessions).toHaveLength(0);
  });
});


describe('真实 forkpty 初始竞态压力回归', () => {
  it('IMMEDIATE-TERMINATE：256次 create 后零宽限终止，不能误报存活根已清空', async () => {
    const handles:ProcessHandle[]=[];
    const events:CoreEvent[]=[];
    const m=new SessionManager({config:{max_session_records:512,default_terminate_grace_ms:10},
      backend:(spec,callbacks)=>{const h=spawnPty(spec,callbacks);handles.push(h);return h;},
      onEvent:event=>{if(['signal','cleanup_error','cleanup','exited','output_closed'].includes(event.type))events.push(event);}});
    managers.push(m);
    const diagnostic=(iteration:number,id:string,h:ProcessHandle,extra?:unknown)=>{
      let processRows:string[];
      try{
        processRows=execFileSync('ps',['-axo','pid,ppid,pgid,uid,stat,command'],{encoding:'utf8'})
          .split('\n').filter(row=>{const columns=row.trim().split(/\s+/);return Number(columns[0])===h.pid||Number(columns[2])===h.pgid;});
      }catch(error){processRows=[`ps failed: ${String(error)}`];}
      return 'IMMEDIATE_TERMINATE_DIAGNOSTIC='+JSON.stringify({iteration,session_id:id,
        pid:h.pid,pgid:h.pgid,state:m.status({session_id:id}),
        events:events.filter(event=>event.session_id===id),process_rows:processRows,extra});
    };
    try {
      for(let n=0;n<256;n++){
        const s=await m.create({argv:['/bin/sleep','30']});const h=handles.at(-1)!;
        await m.terminate({session_id:s.session_id,grace_ms:0});
        const deadline=Date.now()+3000;
        while(Date.now()<deadline){
          const state=m.status({session_id:s.session_id});
          if(state.cleanup_result==='failed')throw new Error(diagnostic(n,s.session_id,h));
          if(state.cleanup_result==='group_cleared'){
            try{
              expect(h.rootExists(),`iteration=${n}: root must be gone when group_cleared`).toBe(false);
              expect(h.groupExists(),`iteration=${n}: managed group must be gone`).toBe(false);
            }catch(error){throw new Error(diagnostic(n,s.session_id,h,String(error)));}
          }
          if(state.status==='exited'&&state.output_closed&&state.cleanup_result==='group_cleared')break;
          await delay(1);
        }
        if(m.status({session_id:s.session_id}).cleanup_result!=='group_cleared')
          throw new Error(diagnostic(n,s.session_id,h,'cleanup did not clear within deadline'));
        expect(h.rootExists()).toBe(false);
      }
    }finally{
      await m.close();
      // 即使回归失败也由harness清理其自己记录的PID，不依赖误报的cleanup结果。
      for(const h of handles){
        let exists=true;
        try{exists=h.rootExists();}catch(error){console.error(`HARNESS_ROOT_PROBE pid=${h.pid}: ${String(error)}`);}
        if(!exists)continue;
        try{h.signalGroup('SIGKILL');}catch{
          try{process.kill(h.pid,'SIGKILL');}catch(error){
            if((error as NodeJS.ErrnoException).code!=='ESRCH')console.error(`HARNESS_KILL pid=${h.pid}: ${String(error)}`);
          }
        }
      }
    }
  },30000);
});
