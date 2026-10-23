// Usage: node port-contract-typecheck.cjs <exact extracted application root> [Atoma checkout]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const appRoot = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'An exact extracted application root is required');
const repoRoot = path.resolve(process.argv[3] || path.join(__dirname, '../../..'));
const dependencies = createRequire(path.join(repoRoot, 'package.json'));
const ts = dependencies('typescript');
const typeRoots = [path.dirname(path.dirname(dependencies.resolve('@types/node/package.json')))];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'attica-port-contract-'));
const target = path.join(scratch, 'contract.ts');
fs.writeFileSync(target, [
  `import type { createServer } from ${JSON.stringify(path.join(appRoot, 'browser/control-server.ts'))};`,
  "import type { Server } from 'node:http';",
  'declare const application: ReturnType<typeof createServer>;',
  'export const actualPort = application.address().port;',
  'declare const generic: Server;',
  'export const genericPort = generic.address().port;',
].join('\n'));
try {
const program = ts.createProgram([target], {strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,allowImportingTsExtensions:true,types:['node'],typeRoots});
const source=program.getSourceFile(target),checker=program.getTypeChecker();
const diagnostics=ts.getPreEmitDiagnostics(program).filter(d=>d.file?.fileName===target).map(d=>({line:d.file.getLineAndCharacterOfPosition(d.start).line+1,code:d.code,text:ts.flattenDiagnosticMessageText(d.messageText,' ')}));
let type;
function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText()==='actualPort')type=checker.typeToString(checker.getTypeAtLocation(node.initializer));ts.forEachChild(node,visit);}
visit(source);
assert.equal(type,'number');assert(diagnostics.length>0&&diagnostics.every(d=>d.line===6));
console.log(JSON.stringify({scope:'Type resolution of the imported application contract, not a whole application build',actualPortType:type,actualPortDiagnostics:diagnostics.filter(d=>d.line===4),genericServerNegativeControl:diagnostics},null,2));

} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
