import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { localDockerSchema, LOCAL_DOCKER_MAX_BYTES } from '../src/contracts/localDocker.js';
import { localDockerFiles, localDockerLaunchers, localDockerPackage } from '../src/viz/client-gl/local-docker.js';
import type { WorkspaceIndex } from '../src/contracts/workspaceBrowser.js';

const projectId = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';
const config = localDockerSchema.parse({ version:1, runtime:'docker-compose', composeFile:'compose.yaml',
  appUrl:'http://127.0.0.1:3300/', verificationUrl:'http://127.0.0.1:6081/vnc.html?autoconnect=1', files:['compose.yaml','app.js'] });
const index: WorkspaceIndex = {runId, createdAt:'2026-10-14T00:00:00Z', status:'delivered',
  files:[{path:'compose.yaml',size:3},{path:'app.js',size:2},{path:'not-selected.txt',size:1}]};

describe('local Docker installation contract', () => {
  it('refuses traversal, platform-special paths, profiles and executable URL content', () => {
    for (const path of ['../secret','/etc/passwd','x\\y','x:y','x/../y','a/CON.txt','x.','a%PATH%',"a'cmd",'.env','profile/Cookies','.local-browser/Default/a']) {
      expect(localDockerSchema.safeParse({...config, files:[config.composeFile,path]}).success, path).toBe(false);
    }
    for (const url of ['https://example.com/','http://localhost:3300','http://127.0.0.1:99999','http://127.0.0.1:80','http://127.0.0.1:3300/%PATH%','http://127.0.0.1:3300/";&touch']) {
      expect(localDockerSchema.safeParse({...config,appUrl:url}).success, url).toBe(false);
    }
    expect(localDockerSchema.safeParse({...config,files:['compose.yaml','APP.js','app.js']}).success).toBe(false);
    expect(localDockerSchema.safeParse({...config,files:['app.js']}).success).toBe(false);
    expect(localDockerSchema.safeParse({...config,files:['compose.yaml','src','src/app.js']}).success).toBe(false);
  });
  it('requires a complete, bounded, retained set before requesting any bytes', async () => {
    expect(() => localDockerFiles(config,{...index,status:'partial'})).toThrow();
    expect(() => localDockerFiles(config,{...index,files:[]})).toThrow();
    expect(() => localDockerFiles(config,{...index,files:[{path:'compose.yaml',size:LOCAL_DOCKER_MAX_BYTES},{path:'app.js',size:2}]})).toThrow();
    await expect(localDockerPackage(config,index,projectId,async()=>new Uint8Array(1))).rejects.toThrow('differs');
  });
  it('packages only the declared sources and complete generated launchers', async () => {
    const requested: string[] = [];
    const zip = await localDockerPackage(config,index,projectId,async path => {
      requested.push(path); return new TextEncoder().encode(path==='compose.yaml'?'abc':'xy');
    });
    const entries=unzipSync(zip);
    expect(requested).toEqual(config.files);
    expect(Object.keys(entries).sort()).toEqual(['app/compose.yaml','app/app.js','Start.command','Stop.command','Start.cmd','Stop.cmd','START-HERE.txt'].sort());
    expect(strFromU8(entries['START-HERE.txt']!)).toContain(runId);
    expect(strFromU8(entries['Start.cmd']!)).toContain('--wait --wait-timeout 120');
  });
  it('executes the generated POSIX launcher across a process boundary with a fake Docker engine', () => {
    const root=mkdtempSync(join(tmpdir(),'atoma-install-'));
    try {
      const bin=join(root,'bin'), app=join(root,'app'), home=join(root,'private home'), log=join(root,'docker.log');
      mkdirSync(bin);mkdirSync(app);mkdirSync(home);
      writeFileSync(join(bin,'docker'), '#!/bin/sh\nif [ "$1" = info ] && [ "${ENGINE_DOWN:-}" = 1 ]; then exit 1; fi\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\nprintf "%s\\n" "$ATOMA_LOCAL_DATA_DIR" > "$INSTALL_STATE"\n', {mode:0o755});
      writeFileSync(join(bin,'open'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INSTALL_OPEN"\n', {mode:0o755});
      // Production prepends common Docker paths. Replace those two paths only
      // in this test so the installed real engine cannot be touched.
      const scripts=localDockerLaunchers(config,projectId,runId);
      const env={...process.env,HOME:home,PATH:`${bin}:/usr/bin:/bin`,INSTALL_LOG:log,INSTALL_STATE:join(root,'state'),INSTALL_OPEN:join(root,'opened')};
      for (const name of ['Start.command','Stop.command']) {
        const file=join(root,name);writeFileSync(file,scripts[name]!.replace('$HOME/.docker/bin:/usr/local/bin:/opt/homebrew/bin:',''));
        const result=spawnSync('/bin/bash',[file],{env,encoding:'utf8'});
        expect(result.status,result.stderr).toBe(0);
      }
      expect(readFileSync(log,'utf8')).toContain(`--project-name atoma-${projectId} -f compose.yaml up -d --build --wait --wait-timeout 120`);
      expect(readFileSync(log,'utf8')).toContain('-f compose.yaml stop');
      expect(readFileSync(log,'utf8')).not.toMatch(/down|--volumes/);
      expect(readFileSync(join(root,'opened'),'utf8').trim()).toBe(config.appUrl);
      const stopped=spawnSync('/bin/bash',[join(root,'Start.command')],{env:{...env,ENGINE_DOWN:'1'},input:'\n',encoding:'utf8'});
      expect(stopped.status).toBe(1);expect(stopped.stdout).toContain('Open Docker Desktop');
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
});
