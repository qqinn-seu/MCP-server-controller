import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePty } from '../../scripts/prepare-pty.mjs';

const roots:string[]=[];
function fixture(version='1.1.0') {
  const root=mkdtempSync(join(tmpdir(),'pty-helper-'));roots.push(root);
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'node-pty',version}));
  return root;
}
function helper(root:string,dir='prebuilds/darwin-arm64',mode=0o644) {
  const folder=join(root,dir);mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'pty.node'),'fixture-not-a-native-binary');
  const file=join(folder,'spawn-helper');writeFileSync(file,'fixture',{mode});return file;
}
function mode(file:string){return statSync(file).mode & 0o777;}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

describe('PTY 安装准备：只修复 macOS helper 执行位',()=>{
  it('PREPARE-LINUX：Linux 完全不更改文件权限',()=>{
    const root=fixture(),file=helper(root);
    const result=preparePty({platform:'linux',arch:'arm64',packageDir:root});
    expect(result.skipped).toBe(true);expect(mode(file)).toBe(0o644);
  });
  it('PREPARE-DARWIN：644 只增加 owner execute 为744，不拓宽其他权限',()=>{
    const root=fixture(),file=helper(root);
    const result=preparePty({platform:'darwin',arch:'arm64',packageDir:root});
    expect(result.changed).toEqual([file]);expect(mode(file)).toBe(0o744);
  });
  it('PREPARE-IDEMPOTENT：重复运行不改变已正确设置的模式',()=>{
    const root=fixture(),file=helper(root,'build/Release',0o755);
    const first=preparePty({platform:'darwin',arch:'arm64',packageDir:root});
    const second=preparePty({platform:'darwin',arch:'arm64',packageDir:root});
    expect(first.changed).toEqual([]);expect(second.changed).toEqual([]);expect(mode(file)).toBe(0o755);
  });
  it('PREPARE-ARCH：只处理实际 Node 架构候选，不修改其他架构',()=>{
    const root=fixture(),arm=helper(root),x64=helper(root,'prebuilds/darwin-x64');
    preparePty({platform:'darwin',arch:'arm64',packageDir:root});
    expect(mode(arm)).toBe(0o744);expect(mode(x64)).toBe(0o644);
  });
  it('PREPARE-FAIL-CLEAR：版本变化、缺失和非普通文件明确失败',()=>{
    const wrong=fixture('9.9.9');expect(()=>preparePty({platform:'darwin',arch:'arm64',packageDir:wrong})).toThrow('pinned');
    const missing=fixture();expect(()=>preparePty({platform:'darwin',arch:'arm64',packageDir:missing})).toThrow('No node-pty native module');
    const root=fixture(),file=helper(root);rmSync(file);
    expect(()=>preparePty({platform:'darwin',arch:'arm64',packageDir:root})).toThrow('Missing PTY spawn-helper');
    const other=join(root,'other');writeFileSync(other,'x');symlinkSync(other,file);
    expect(()=>preparePty({platform:'darwin',arch:'arm64',packageDir:root})).toThrow('regular file');
  });
});
