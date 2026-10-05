import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const a=JSON.parse(gunzipSync(readFileSync('benchmark/reservation-transactions-2026-10-05/sixth-attempt.json.gz')));
let text, reads=0, edits=0;
for(const e of a.events){
 if(e.id==='e9e50fb1-cc35-4a37-872b-79c9766b6c4f')break;
 if(e.kind!=='tool'||e.args?.path!=='test.js'||e.error)continue;
 if(e.name==='read_file'){
  if(typeof e.result?.content!=='string')throw Error('bad read');
  if(text!==undefined&&text!==e.result.content)throw Error('snapshot drift '+e.id);
  text=e.result.content; reads++;
 }
 if(e.name==='write_file'&&e.result?.ok){text=e.args.content;}
 if(e.name==='edit_file'&&e.result?.ok){
  const {old_string:old,new_string:next}=e.args;
  if(text===undefined||!text.includes(old))throw Error('edit mismatch '+e.id);
  if(text.split(old).length-1!==e.result.replacements)throw Error('count mismatch '+e.id);
  text=text.replaceAll(old,next); edits++;
 }
}
writeFileSync('benchmark/reservation-transactions-2026-10-05/sixth-test-at-first-refusal.js.txt',text);
console.log({reads,edits,chars:text.length});
