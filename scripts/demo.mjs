import { SessionManager } from '../dist/index.js';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('../tests/fixtures/terminal.py', import.meta.url));
const manager = new SessionManager({config:{default_terminate_grace_ms:100}});
const show = (title,data) => console.log(title,JSON.stringify(data));
const wait = (session, value, cursor=session.initial_cursor) => manager.waitFor({
  session_id:session.session_id,cursor,pattern:{type:'literal',value},timeout_ms:3000});
try {
  console.log('阶段①纯 PTY 会话内核演示（不接 MCP、无审批与网络服务）');
  const repl = await manager.create({argv:['python3','-i','-q'],label:'demo-repl'});
  await wait(repl,'>>> ');
  await manager.write({session_id:repl.session_id,text:'values = [2, 3, 5]\n'});
  await manager.write({session_id:repl.session_id,text:'print("RESULT:", sum(values))\n'});
  show('REPL 状态保持',await wait(repl,'RESULT: 10'));
  await manager.terminate({session_id:repl.session_id});
  const wizard = await manager.create({argv:['python3','-u',fixture,'wizard'],label:'demo-wizard'});
  show('无换行提示',await wait(wizard,'Name? '));
  await manager.write({session_id:wizard.session_id,text:'Ada\n'});
  await wait(wizard,'Age? ');
  await manager.write({session_id:wizard.session_id,text:'42\n'});
  show('同进程向导',await wait(wizard,'ANSWER:Ada:42'));
  const run = await manager.run({argv:['python3','-u',fixture,'long','0.3'],wait_timeout_ms:10,label:'demo-long'});
  show('限时返回同一后台会话',run);
  let cursor=run.next_cursor;
  for(let i=0;i<100;i++) {
    const page=await manager.read({session_id:run.session_id,cursor,wait_ms:100,max_bytes:256});
    show('输出页',page);cursor=page.next_cursor;if(page.eof)break;
  }
  show('非零退出是进程结果',manager.status({session_id:run.session_id}));
  const ctrl=await manager.create({argv:['python3','-u',fixture,'ctrl'],label:'demo-ctrl'});
  await wait(ctrl,'CTRL_READY');await manager.write({session_id:ctrl.session_id,key:'CTRL_C'});
  show('Ctrl-C 前台中断',await wait(ctrl,'INTERRUPTED'));
} finally {
  await manager.close();
  show('正常关闭后的空列表',manager.list());
}
