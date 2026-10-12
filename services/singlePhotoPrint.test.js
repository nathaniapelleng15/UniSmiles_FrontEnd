import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../components/PhotoBooth.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('PhotoBooth.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// Execute the actual component handlers, injecting only their browser/state dependencies.
function handler(name, scope, text = source) {
  const ast = ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest, true,
    text === source ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, `${name} must exist`);
  const js = ts.transpileModule(`const fn = ${initializer.getText(ast)}; fn;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  return vm.runInNewContext(js, scope);
}
function finishScope(selectedPackage, capturedPhotos) {
  const state = {};
  return { state, selectedPackage, capturedPhotos, window: { innerWidth: 1000 },
    setStep: v => { state.step = v; },
    setSelectedPrintPhotoIndex: v => { state.index = v; },
    setPrintSelectionConfirmed: v => { state.confirmed = v; },
    setIsResultPanelCollapsed: () => {} };
}
test('print grid requires explicit selection before entering result', () => {
  const scope = finishScope('print', ['one', 'two']);
  handler('handleFinish', scope)();
  assert.equal(scope.state.step, 'PRINT_SELECTION');
  assert.equal(scope.state.index, null);
  assert.equal(scope.state.confirmed, false);
});

test('digital skips print selection; one-photo print is automatically selected', () => {
  const digital = finishScope('digital', ['one', 'two']);
  handler('handleFinish', digital)();
  assert.equal(digital.state.step, 'RESULT');
  assert.equal(digital.state.index, null);
  const single = finishScope('print', ['one']);
  handler('handleFinish', single)();
  assert.equal(single.state.step, 'RESULT');
  assert.equal(single.state.index, 0);
  assert.equal(single.state.confirmed, true);
});

test('confirmation refuses invalid selection and freezes a valid choice', () => {
  for (const index of [null, -1, 2, 0.5, NaN, 1]) {
    const scope = { ...finishScope('print', ['one', 'two']), step: 'PRINT_SELECTION',
      selectedPrintPhotoIndex: index, printActionInFlightRef: { current: false },
      isPrintActive: false, btPrintState: 'idle' };
    handler('handleConfirmPrintSelection', scope)();
    assert.equal(scope.state.step, index === 1 ? 'RESULT' : undefined);
    assert.equal(scope.state.confirmed, index === 1 ? true : undefined);
  }
  const busy = { ...finishScope('print', ['one', 'two']), step: 'PRINT_SELECTION',
    selectedPrintPhotoIndex: 1, printActionInFlightRef: { current: true },
    isPrintActive: false, btPrintState: 'idle' };
  handler('handleConfirmPrintSelection', busy)();
  assert.equal(busy.state.step, undefined);
});

test('selection page exposes exactly one choice and explicit confirmation in Indonesian', () => {
  assert.match(source, /step === 'PRINT_SELECTION'/);
  assert.match(source, /Pilih foto yang ingin dicetak/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio"/);
  assert.match(source, /aria-checked=\{selectedPrintPhotoIndex === index\}/);
  assert.match(source, /onClick=\{handleConfirmPrintSelection\}/);
});

function printScope(overrides = {}) {
  return { selectedPackage: 'print', step: 'RESULT', capturedPhotos: ['one', 'two'],
    selectedPrintPhotoIndex: 1, printSelectionConfirmed: true, btPrintState: 'idle',
    processedFrame: { id: 'frame' }, selectedFrame: null, selectedLayoutId: '2x1',
    ...overrides };
}
test('print image uses the confirmed selected photo and matching slot, never a digital fallback', async () => {
  const calls = [];
  const scope = printScope({ generatePrintImage: async (...args) => { calls.push(args); return 'selected-crop'; } });
  assert.equal(await handler('prepareSelectedPrintImage', scope)(), 'selected-crop');
  assert.deepEqual(calls, [['two', scope.processedFrame, '2x1', 1]]);
  for (const invalid of [{selectedPrintPhotoIndex: null}, {selectedPrintPhotoIndex: -1},
    {selectedPrintPhotoIndex: 2}, {selectedPrintPhotoIndex: 0.5},
    {printSelectionConfirmed: false}, {selectedPackage: 'digital'}, {step: 'PRINT_SELECTION'},
    {capturedPhotos: []}]) {
    await assert.rejects(handler('prepareSelectedPrintImage', { ...scope, ...invalid }), /Pilih.*konfirmasi/);
  }
  await assert.rejects(handler('prepareSelectedPrintImage', { ...scope, generatePrintImage: async () => null }), /Gambar cetak/);
});
test('crop dimensions come from selected slot, not first slot', async () => {
  const slots = [{ width: 100, height: 200 }, { width: 400, height: 300 }];
  const canvas = { getContext: () => ({}), toDataURL: () => 'crop' };
  const painted = [];
  const fn = handler('generatePrintImage', { getEffectiveLayoutConfig: () => ({ slots }),
    firstSlot: slots => slots[0],
    loadImageElement: async () => ({ naturalWidth: 600, naturalHeight: 600 }),
    document: { createElement: () => canvas }, paintPrintImage: (...args) => painted.push(args), console });
  assert.equal(await fn('two', null, '2x1', 1), 'crop');
  assert.equal(canvas.width, 400);
  assert.equal(canvas.height, 300);
  assert.equal(painted[0][2], slots[1]);
});

test('Bluetooth prints only the prepared selected crop with exactly one copy', async () => {
  const prints = [];
  const scope = { ...printScope(), finalUploadedUrl: 'digital-grid',
    generatePrintImage: async photo => `crop:${photo}`,
    prepareSelectedPrintImage: async () => 'selected-crop',
    bluetoothPrinterRef: { current: { isConnected: () => true, print: async (...args) => prints.push(args) } },
    kioskPaperSize: '4R', labelMmFromPaperSize: () => ({ widthMm: 100, heightMm: 150 }),
    computeLabelSize: () => ({ width: 100, height: 150 }), labelFrameBox: () => null,
    printMarginTopPx: 0, printMarginRightPx: 0, printMarginLeftPx: 0, printMarginBottomPx: 0,
    DEFAULT_ADJUSTMENTS: {}, photoAdjust: { fitMode: 'cover' }, thermalDensity: 3,
    thermalOffsetYPx: 0, thermalOffsetXPx: 0, isGrayscaleAlgorithm: () => false,
    DEFAULT_GRAYSCALE_ALGORITHM: 'rec601' };
  await handler('printViaBluetoothCore', scope)();
  assert.equal(prints.length, 1);
  assert.equal(prints[0][0], 'selected-crop');
  assert.equal(prints[0][2], 1);
});

test('manual print receives selected-only crop and blocks duplicate in-flight requests', async () => {
  const images = [];
  let printCalls = 0;
  const scope = { ...printScope(), finalUploadedUrl: 'digital-grid', areAssetsReady: true, isPrintActive: false, printState: 'idle',
    printActionInFlightRef: { current: false },
    prepareSelectedPrintImage: async () => 'selected-crop',
    getEffectiveLayoutConfig: () => ({ width: 600, height: 300, slots: [{width:100,height:200},{width:400,height:300}] }),
    setPrintState: () => {}, setPrintError: () => {},
    window: { open: () => ({ focus: () => {}, print: () => { printCalls++; },
      document: { createElement: () => ({}), head: { appendChild: () => {} },
        body: { appendChild: image => { images.push(image); image.onload(); } } } }) } };
  const manual = handler('handleManualPrint', scope);
  await Promise.all([manual(), manual()]);
  assert.equal(images.length, 1);
  assert.equal(images[0].src, 'selected-crop');
  assert.equal(printCalls, 1);
});

function autoScope() {
  const events = [], queued = [], uploads = [];
  const scope = { ...printScope(), events, queued, uploads,
    areAssetsReady: true, sessionCode: 'SESSION', isPrintActive: false, printState: 'idle',
    printActionInFlightRef: { current: false }, getPersistedPrintJob: () => null,
    prepareSelectedPrintImage: async () => { events.push('crop'); return 'selected-crop'; },
    doAutoUpload: async () => { events.push('digital'); return 'https://cdn/SESSION_frame.png'; },
    finalUploadedUrl: 'https://cdn/SESSION_frame.png', uploadStatus: 'success',
    fetch: async url => ({ blob: async () => `blob:${url}` }),
    uploadPhoto: async (...args) => { uploads.push(args); return 'https://cdn/SESSION_print.png'; },
    getEffectiveLayoutConfig: () => ({ width:600,height:300,slots:[{width:100,height:200},{width:400,height:300}] }),
    setPrintError: () => {}, setPrintState: () => {}, setPrintJobId: () => {},
    makeIdempotencyKey: () => 'key', kioskPaperSize: '4R', getPaperSizeForLayout: () => '4R',
    NiimbotPrinter: { isSupported: () => false },
    queuePrintJob: async (...args) => { queued.push(args); return {job_id:'job',status:'queued'}; },
    persistPrintJob: () => {}, clearPersistedPrintJob: () => {}, startPrintPolling: () => {},
    finishPrintAsFailed: e => { throw e; }, console };
  return scope;
}
test('server print uploads a separate single asset, preserves digital URL and queues one copy', async () => {
  const scope = autoScope();
  await handler('handleAutoPrint', scope)();
  assert.equal(scope.uploads.length, 1);
  assert.deepEqual(scope.uploads[0], ['blob:selected-crop', 'SESSION', 'SESSION_print_2.png', 'print']);
  assert.equal(scope.finalUploadedUrl, 'https://cdn/SESSION_frame.png');
  assert.equal(scope.queued.length, 1);
  assert.equal(scope.queued[0][1].image_url, 'https://cdn/SESSION_print.png');
  assert.equal(scope.queued[0][1].copies, 1);
  assert.equal(scope.queued[0][1].orientation, 'landscape');
});
test('successful direct auto print never enqueues another physical server print', async () => {
  const scope = autoScope();
  scope.NiimbotPrinter.isSupported = () => true;
  let printed = 0;
  scope.printViaBluetoothCore = async () => { printed++; };
  scope.recordPrintJob = async () => { scope.queued.push('duplicate'); };
  await handler('handleAutoPrint', scope)();
  assert.equal(printed, 1);
  assert.equal(scope.queued.length, 0);
});

test('upload API includes explicit print purpose and legacy digital uploads stay unchanged', async () => {
  const requests = [];
  const api = readFileSync(new URL('./apiService.ts', import.meta.url), 'utf8');
  const upload = handler('uploadPhoto', { FormData, Date, console: { log: () => {} },
    request: async req => { requests.push(req); return {data:{success:true,data:{url:'/uploads/print/crop.png'}}}; },
    getApiConfig: () => ({baseUrl:'https://cdn'}) }, api);
  const blob = new Blob(['pixels'], {type:'image/png'});
  await upload(blob, 'SESSION', 'crop.png', 'print');
  assert.equal(requests[0].data.get('purpose'), 'print');
  await upload(blob, 'SESSION', 'grid.png');
  assert.equal(requests[1].data.get('purpose'), null);
});
