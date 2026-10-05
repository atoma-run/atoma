// Reconstruct observed draft bytes without executing any recorded commands.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const root=new URL('.',import.meta.url);
const archive=JSON.parse(gunzipSync(readFileSync(new URL('eighth-attempt.json.gz',root))));
const names=new Set(['server.js','test-api.js','README.md','package.json']);
const files=new Map();
for(const e of archive.events){
 if(e.kind!=='tool'||e.error||!names.has(e.args?.path))continue;
 const path=e.args.path,old=files.get(path);
 if(e.name==='read_file'&&typeof e.result?.content==='string'){
  if(old!==undefined&&old!==e.result.content)throw Error('Snapshot mismatch '+e.id);
  files.set(path,e.result.content);
 }
 if(e.name==='write_file'&&e.result?.ok)files.set(path,e.args.content);
 if(e.name==='edit_file'&&e.result?.ok){
  if(old===undefined||!old.includes(e.args.old_string)||old.split(e.args.old_string).length-1!==e.result.replacements)throw Error('Edit mismatch '+e.id);
  files.set(path,old.replaceAll(e.args.old_string,e.args.new_string));
 }
}
mkdirSync(new URL('eighth-draft/',root),{recursive:true});
const hashes=[];
for(const[path,content]of files){
 const sha256=createHash('sha256').update(content).digest('hex'),expected=archive.status.artifactManifest.files.find(f=>f.path===path);
 if(sha256!==expected.sha256||Buffer.byteLength(content)!==expected.size)throw Error('Manifest mismatch '+path);
 writeFileSync(new URL('eighth-draft/'+path+'.txt',root),content);hashes.push({path,size:Buffer.byteLength(content),sha256});
}
writeFileSync(new URL('eighth-draft-hashes.json',root),JSON.stringify({source:'Final partial-run manifest; not published',files:hashes},null,2)+'\n');
console.log(JSON.stringify(hashes));
