import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SessionManager, type CoreEvent } from '../../src/core/session-manager.js';
import { FakeBackend } from '../fixtures/fake-backend.js';

const error=(code='EPERM')=>Object.assign(new Error(`kill ${code}`),{code,errno:-1,syscall:'kill'});
async function eventually(check:()=>boolean,ms=1000){
  const deadline=performance.now()+ms;
  while(performance.now()<deadline){if(check())return;await delay(5);}
  expect(check()).toBe(true);
}
function harness(){
  const backend=new FakeBackend(),events:CoreEvent[]=[];
  const m=new SessionManager({backend:backend.factory,config:{drain_timeout_ms:20},onEvent:e=>events.push(e)});
  return {m,backend,events};
}

describe('成功终止信号后的有界只读探测重试',()=>{
  it('POST-KILL-GROUP-EPERM：瞬时拒绝后组消失，但根仍存在时不得提前清空',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;
      const group=h.groupExists.bind(h),signal=h.signalGroup.bind(h);let killed=false,failures=0;
      h.signalGroup=sig=>{signal(sig);if(sig==='SIGKILL')killed=true;};
      h.groupExists=()=>{if(killed&&failures<2){failures++;throw error();}return group();};
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>failures===2&&events.some(e=>e.type==='cleanup_probe_retry'));
      expect(m.status({session_id:s.session_id}).cleanup_result).toBe('pending');
      expect(h.rootExists()).toBe(true);expect(h.signals).toEqual(['SIGTERM','SIGKILL']);
      h.emitExit(null,'SIGKILL');h.emitClosed(true);
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='group_cleared');
      expect(h.groupExists()).toBe(false);expect(h.rootExists()).toBe(false);
      expect(events.filter(e=>e.type==='cleanup_error')).toHaveLength(0);
    }finally{backend.finishAll();await m.close();}
  });

  it('POST-KILL-ROOT-EPERM：根探测权限拒绝不等于根消失，恢复确认后才清空',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;
      const root=h.rootExists.bind(h),signal=h.signalGroup.bind(h);let killed=false,allowProbe=false;
      h.signalGroup=sig=>{signal(sig);if(sig==='SIGKILL'){killed=true;h.finish(null,'SIGKILL');}};
      h.rootExists=()=>{if(killed&&!allowProbe)throw error();return root();};
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>events.some(e=>e.type==='cleanup_probe_retry'&&e.details.operation==='probe_root'));
      expect(m.status({session_id:s.session_id}).cleanup_result).toBe('pending');
      allowProbe=true;
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='group_cleared');
      expect(h.signals).toEqual(['SIGTERM','SIGKILL']);
    }finally{backend.finishAll();await m.close();}
  });

  it('POST-KILL-PERSISTENT-EPERM：同一截止时间到期仍拒绝则failed，不无界续时',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;
      const group=h.groupExists.bind(h),signal=h.signalGroup.bind(h);let killed=false;
      h.signalGroup=sig=>{signal(sig);if(sig==='SIGKILL'){killed=true;h.finish(null,'SIGKILL');}};
      h.groupExists=()=>{if(killed)throw error();return group();};
      const started=performance.now();await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='failed',1400);
      expect(performance.now()-started).toBeLessThan(1400);
      expect(events.filter(e=>e.type==='cleanup_error')).toHaveLength(1);
      expect(events.find(e=>e.type==='cleanup_error')?.details).toMatchObject({code:'EPERM',operation:'probe_group',phase:'final_wait'});
      expect(events.filter(e=>e.type==='cleanup_probe_retry')).toHaveLength(1);
      await m.terminate({session_id:s.session_id,grace_ms:0});expect(h.signals).toEqual(['SIGTERM','SIGKILL']);
    }finally{backend.finishAll();await m.close();}
  });

  it('ACTUAL-KILL-EPERM：TERM成功不授权吞掉KILL发送错误，也不重发KILL',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;
      const signal=h.signalGroup.bind(h);let killAttempts=0;
      h.signalGroup=sig=>{if(sig==='SIGKILL'){killAttempts++;throw error();}signal(sig);};
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='failed');
      await m.terminate({session_id:s.session_id,grace_ms:0});
      expect(killAttempts).toBe(1);expect(events.filter(e=>e.type==='cleanup_probe_retry')).toHaveLength(0);
      expect(events.find(e=>e.type==='cleanup_error')?.details).toMatchObject({code:'EPERM',operation:'signal_group',attempted_signal:'SIGKILL'});
    }finally{backend.finishAll();await m.close();}
  });

  it('POST-SIGNAL-UNKNOWN-ERROR：非EPERM探测错误仍立即failed',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;const group=h.groupExists.bind(h);
      h.groupExists=()=>{if(h.signals.includes('SIGTERM'))throw error('EINVAL');return group();};
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='failed');
      expect(events.filter(e=>e.type==='cleanup_probe_retry')).toHaveLength(0);
      expect(events.find(e=>e.type==='cleanup_error')?.details.code).toBe('EINVAL');
      expect(h.signals).toEqual(['SIGTERM']);
    }finally{backend.finishAll();await m.close();}
  });
});


describe('完整采样与首次成功信号边界',()=>{
  it('LIVE-GROUP-ROOT-EPERM：组仍存在也必须检查根，持续拒绝不能降级为partial',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest,root=h.rootExists.bind(h);
      h.rootExists=()=>{if(h.signals.includes('SIGTERM'))throw error();return root();};
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='failed',1400);
      expect(events.find(e=>e.type==='cleanup_error')?.details).toMatchObject({code:'EPERM',operation:'probe_root'});
      expect(h.signals).toEqual(['SIGTERM']);
    }finally{backend.finishAll();await m.close();}
  });

  it('RESAMPLE-PAIR：根探测重试后必须重采样组，不能沿用先前的组false',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;
      const root=h.rootExists.bind(h),signal=h.signalGroup.bind(h);let killed=false,changed=false;
      h.signalGroup=sig=>{signal(sig);if(sig==='SIGKILL'){killed=true;h.finish(null,'SIGKILL');}};
      h.rootExists=()=>{if(killed&&!changed){changed=true;h.setGroupExists(true);throw error();}return root();};
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>events.some(e=>e.type==='cleanup_probe_retry'));
      await delay(20);
      expect(h.groupExists()).toBe(true);expect(h.rootExists()).toBe(false);
      expect(m.status({session_id:s.session_id}).cleanup_result).toBe('pending');
      expect(h.signals).toEqual(['SIGTERM','SIGKILL']);h.setGroupExists(false);
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='group_cleared');
    }finally{backend.finishAll();await m.close();}
  });

  it('ABSENT-BEFORE-EXIT-CALLBACK：两个探测明确不存在可清空，不伪造迟到的退出信息',async()=>{
    const {m,backend}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;
      const root=h.rootExists.bind(h),signal=h.signalGroup.bind(h);let killed=false;
      h.signalGroup=sig=>{signal(sig);if(sig==='SIGKILL')killed=true;};
      h.rootExists=()=>killed?false:root();
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='group_cleared');
      expect(m.status({session_id:s.session_id})).toMatchObject({status:'stopping',exited_at:null,output_closed:false});
      expect(h.groupExists()).toBe(false);expect(h.rootExists()).toBe(false);
    }finally{backend.finishAll();await m.close();}
  });

  it('TERM-ESRCH-KILL-SUCCESS：首次成功是KILL时仍有一次固定确认窗口',async()=>{
    const {m,backend,events}=harness();
    try{
      const s=await m.create({argv:['/bin/sh']}),h=backend.latest;
      const group=h.groupExists.bind(h),signal=h.signalGroup.bind(h);let killed=false,allowProbe=false,termAttempts=0;
      h.signalGroup=sig=>{if(sig==='SIGTERM'){termAttempts++;throw error('ESRCH');}
        signal(sig);killed=true;h.finish(null,'SIGKILL');};
      h.groupExists=()=>{if(killed&&!allowProbe)throw error();return group();};
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await eventually(()=>events.some(e=>e.type==='cleanup_probe_retry'));
      expect(m.status({session_id:s.session_id}).cleanup_result).toBe('pending');
      allowProbe=true;await eventually(()=>m.status({session_id:s.session_id}).cleanup_result==='group_cleared');
      expect(termAttempts).toBe(1);expect(h.signals).toEqual(['SIGKILL']);
    }finally{backend.finishAll();await m.close();}
  });
});
