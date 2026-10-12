import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../components/PhotoBooth.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('PhotoBooth.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
async function runNativeFailure(message) {
 let init; const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='handleAutoPrint')init=n.initializer;ts.forEachChild(n,visit);};visit(ast);
 let prints=0,queues=0,uploads=0,failure;
 const scope={selectedPackage:'print',step:'RESULT',printSelectionConfirmed:true,selectedPrintPhotoIndex:1,
  capturedPhotos:['one','two'],processedFrame:null,selectedFrame:null,selectedLayoutId:'2x1',
  printActionInFlightRef:{current:false},isPrintActive:false,printState:'idle',btPrintState:'idle',areAssetsReady:true,sessionCode:'SESSION',
  setPrintError:()=>{},setPrintState:()=>{},prepareSelectedPrintImage:async()=>'selected-crop',getPersistedPrintJob:()=>null,
  finalUploadedUrl:'https://example.test/SESSION_frame.png',getEffectiveLayoutConfig:()=>({width:600,height:300,slots:[{width:100,height:200},{width:400,height:300}]}),
  makeIdempotencyKey:()=> 'key',kioskPaperSize:'4R',NiimbotPrinter:{isSupported:()=>true},
  PRINTER_BELUM_DIPASANGKAN:'PAIR_FIRST',
  printViaBluetoothCore:async()=>{prints++;throw new Error(message);},
  fetch:async()=>({blob:async()=>new Blob()}),uploadPhoto:async()=>{uploads++;return 'https://example.test/print.png';},
  queuePrintJob:async()=>{queues++;return {job_id:'second-job',status:'queued'};},
  setPrintJobId:()=>{},persistPrintJob:()=>{},startPrintPolling:()=>{},finishPrintAsFailed:e=>{failure=e;},console:{warn:()=>{},error:()=>{}},KioskApiError:Error};
 const js=ts.transpileModule(`const fn=${init.getText(ast)};fn;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 await vm.runInNewContext(js,scope)();
 return {prints,queues,uploads,failure};
}
test('ambiguous native print failure must not enqueue a second physical print',async()=>{
 const {prints,queues,uploads,failure}=await runNativeFailure('printer response timeout after sending image');
 assert.equal(prints,1);
 assert.equal(queues,0,'uncertain native outcome must not silently start a second print');
 assert.equal(uploads,0);
 assert.match(failure?.message||'',/timeout/);
});
test('unpaired native preflight can safely fall back to one selected-only server job',async()=>{
 const {queues,uploads,failure}=await runNativeFailure('PAIR_FIRST');
 assert.equal(queues,1);
 assert.equal(uploads,1);
 assert.equal(failure,undefined);
});
