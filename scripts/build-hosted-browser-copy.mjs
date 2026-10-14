// The English product catalog remains the only authored source of UI copy.
import { readFileSync, writeFileSync } from 'node:fs';
const [catalogPath, templatePath, outputPath] = process.argv.slice(2);
const copy = Object.fromEntries(Object.entries(JSON.parse(readFileSync(catalogPath,'utf8'))).filter(([key])=>key.startsWith('hostedBrowser.')));
const escape = text => text.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const html = readFileSync(templatePath,'utf8').replace(/\{\{(hostedBrowser\.\w+)\}\}/g,(_match,key)=>{
  if(typeof copy[key]!=='string') throw Error(`Missing product copy: ${key}`);
  return escape(copy[key]);
}).replace('__HOSTED_BROWSER_COPY__',JSON.stringify(copy).replace(/</g,'\\u003c'));
writeFileSync(outputPath,html);
