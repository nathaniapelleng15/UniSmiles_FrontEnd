import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../components/PhotoBooth.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('PhotoBooth.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function initializer(name){let found;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)===name)found=n.initializer;ts.forEachChild(n,visit);}visit(ast);assert.ok(found,name+' exists');return found;}
function fn(name,scope){return vm.runInNewContext(ts.transpileModule(`const fn=${initializer(name).getText(ast)};fn;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,scope);}
test('native rapid double click prints once and shares server/manual success lock',async()=>{
 let prints=0;const scope={selectedPackage:'print',btPrintState:'idle',printState:'idle',isPrintActive:false,printActionInFlightRef:{current:false},
 NiimbotPrinter:{isSupported:()=>true},setBtPrintError:()=>{},setBtPrintState:()=>{},setPrintState:()=>{},setPrintError:()=>{},clearPersistedPrintJob:()=>{},
 printViaBluetoothCore:async()=>{prints++;await Promise.resolve();},bluetoothPrinterRef:{current:null}};
 const print=fn('handleBluetoothPrint',scope);await Promise.all([print(),print()]);assert.equal(prints,1);
 scope.printState='success';scope.printActionInFlightRef.current=false;await print();assert.equal(prints,1);
});
test('new session clears native success and previous photo choice',()=>{
 const scope={frames:[{}],window:{clearTimeout:()=>{}},printActionInFlightRef:{current:false},printPollTokenRef:{current:0},printPollTimerRef:{current:null},
 finalPhotoUploadPromiseRef:{current:null},sessionCompletedRef:{current:false},clearPersistedPrintJob:()=>{}};
 const state={};function visit(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text.startsWith('set')){const name=n.expression.text;scope[name]=v=>{state[name]=v;};}ts.forEachChild(n,visit);}visit(initializer('handleStart'));
 fn('handleStart',scope)();assert.equal(state.setBtPrintState,'idle');assert.equal(state.setBtPrintError,null);assert.equal(state.setSelectedPrintPhotoIndex,null);assert.equal(state.setPrintSelectionConfirmed,false);
});
test('recovered print job uses digital grid URL instead of print-only asset',()=>{
 assert.equal(fn('digitalImageForPrintJob',{})({imageUrl:'https://cdn/print/crop.png',digitalImageUrl:'https://cdn/grid_frame.png'}),'https://cdn/grid_frame.png');
 assert.equal(fn('digitalImageForPrintJob',{})({imageUrl:'https://cdn/legacy_frame.png'}),'https://cdn/legacy_frame.png');
 assert.match(source,/digitalImageUrl:\s*digitalUrl/);
 assert.match(source,/setFinalUploadedUrl\(digitalImageForPrintJob\(saved\)\)/);
});
