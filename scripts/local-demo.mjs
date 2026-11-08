import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspace=path.resolve(repo,'../work');
const bundled=path.join(workspace,'spacetime-tools/spacetimedb-cli');
const cli=process.env.SPACETIME_CLI || (existsSync(bundled)?bundled:'spacetime');
const root=path.join(workspace,'spacetime-runtime');
const action=process.argv[2];
let command,args;
if(action==='server') {command=cli;args=['--root-dir',root,'start','--listen-addr','127.0.0.1:3000','--data-dir',path.join(workspace,'spacetime-data'),'--non-interactive'];}
else if(action==='publish') {command=cli;args=['--root-dir',root,'publish','tandem-nessie-local','--server','http://127.0.0.1:3000','--module-path','spacetimedb'];}
else if(action==='web') {command=process.execPath;args=['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174'];}
else throw Error('Use server, publish, or web');
const child=spawn(command,args,{cwd:repo,stdio:'inherit',env:process.env});
child.on('error',()=>{console.error('Unable to launch local demo. Install SpacetimeDB or set SPACETIME_CLI to its executable.');process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1;});
