import { describe, expect, it } from 'vitest';
import { SessionManager, type CoreEvent } from '../../src/core/session-manager.js';
import { FakeBackend } from '../fixtures/fake-backend.js';

const scenarios = [
  {name:'CLEANUP-GROUP-EPERM',operation:'probe_group',phase:'group_ready',signal:null},
  {name:'CLEANUP-ROOT-EPERM',operation:'probe_root',phase:'group_ready',signal:null},
  {name:'CLEANUP-SIGNAL-EPERM',operation:'signal_group',phase:'term',signal:'SIGTERM'},
] as const;

describe('清理错误诊断，不吞权限失败',()=>{
  it.each(scenarios)('$name：保留failed与errno，重复terminate不另起清理',async scenario=>{
    const backend=new FakeBackend();const errors:CoreEvent[]=[];
    const m=new SessionManager({backend:backend.factory,config:{drain_timeout_ms:20},
      onEvent:event=>{if(event.type==='cleanup_error')errors.push(event);}});
    try{
      const s=await m.create({argv:['/bin/sh']});const h=backend.latest;
      const denied=()=>{throw Object.assign(new Error('kill EPERM'),{code:'EPERM',errno:-1,syscall:'kill'});};
      if(scenario.operation==='probe_group')h.groupExists=denied;
      if(scenario.operation==='probe_root'){h.setGroupExists(false);h.rootExists=denied;}
      if(scenario.operation==='signal_group')h.signalGroup=denied;
      await m.terminate({session_id:s.session_id,grace_ms:0});
      await m.terminate({session_id:s.session_id,grace_ms:0});
      expect(m.status({session_id:s.session_id}).cleanup_result).toBe('failed');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.details).toMatchObject({code:'EPERM',errno:-1,syscall:'kill',
        operation:scenario.operation,phase:scenario.phase,attempted_signal:scenario.signal,
        pid:h.pid,pgid:h.pgid,root_exit_observed:false,status:'stopping'});
    }finally{backend.finishAll();await m.close();}
  });
});
