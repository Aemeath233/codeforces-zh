const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

function setup() {
    const elements = new Map();
    for (const id of ['batch-cancel-btn', 'code-draft', 'draft-status', 'submit-compiler', 'source-file']) {
        elements.set(id, { value: '', textContent: '', style: {}, addEventListener() {} });
    }
    const storage = new Map();
    const notices = [];
    const copies = [];
    const navigations = [];
    const windowEvents = new Map();
    const intervals = [];
    const context = vm.createContext({ console, URLSearchParams, Blob, URL, Event,
        setTimeout: callback => { callback(); return 1; }, clearTimeout() {},
        setInterval: (callback, ms) => { intervals.push({callback, ms}); return intervals.length; }, clearInterval() {},
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        document: { readyState: 'loading', hidden: false, getElementById: id => elements.get(id) || null,
            addEventListener() {}, querySelectorAll: () => [], body: { appendChild() {} },
            createElement: () => ({ style: {}, select() {}, remove() {} }), execCommand: () => false },
        window: { addEventListener: (type, callback) => windowEvents.set(type, callback), open: () => ({ opener: {}, location: { replace: url => navigations.push(url) }, close() {} }), location: { pathname: '/problem/4/A', reload() {} } },
        navigator: { clipboard: { writeText: async text => copies.push(text) } },
        PROBLEM_DATA: { contestId: 4, problemIndex: 'A', translated: true },
    });
    vm.runInContext(fs.readFileSync('static/js/app.js', 'utf8'), context);
    vm.runInContext(fs.readFileSync('static/js/problem.js', 'utf8'), context);
    context.showToast = (message, type) => notices.push({ message, type });
    return { context, elements, storage, notices, copies, navigations, windowEvents, intervals };
}

(async () => {
    let t = setup();
    await t.context.copyText('a\\n\nactual newline', '输入');
    assert.equal(t.copies[0], 'a\\n\nactual newline', 'sample copying must not turn literal backslash-n into newline');

    t.elements.get('submit-compiler').value = '89';
    assert.equal(t.context.officialSubmitUrl(), 'https://codeforces.com/contest/4/submit?submittedProblemIndex=A&programTypeId=89');
    t.context.PROBLEM_DATA.contestId = 600000;
    t.context.PROBLEM_DATA.problemIndex = 'A1';
    t.elements.get('submit-compiler').value = '';
    assert.equal(t.context.officialSubmitUrl(), 'https://codeforces.com/gym/600000/submit?submittedProblemIndex=A1');

    t = setup();
    t.elements.get('code-draft').value = 'int main(){return 0;}';
    await t.context.copyCodeAndSubmit();
    assert.equal(t.copies[0], 'int main(){return 0;}');
    assert.equal(t.navigations.length, 1);
    assert.equal(t.storage.get('cf_draft_4_A'), 'int main(){return 0;}');

    t = setup();
    let closed = false;
    t.context.window.open = () => ({ close() { closed = true; }, location: { replace() { throw Error('must not navigate after copy failed'); } } });
    t.context.navigator.clipboard.writeText = async () => { throw Error('denied'); };
    t.elements.get('code-draft').value = 'code';
    await t.context.copyCodeAndSubmit();
    assert.equal(closed, true);
    assert.equal(t.notices.at(-1).type, 'error');

    t = setup();
    t.context.window.open = () => { throw Error('must not open a window for an empty draft'); };
    await t.context.copyCodeAndSubmit();
    assert.equal(t.notices.at(-1).type, 'error');

    t = setup();
    t.context.window.open = () => null;
    t.elements.get('code-draft').value = 'code';
    await t.context.copyCodeAndSubmit();
    assert.equal(t.copies[0], 'code');
    assert.match(t.notices.at(-1).message, /拦截/);

    t = setup();
    t.context.localStorage.setItem = () => { throw Error('Quota exceeded'); };
    t.elements.get('code-draft').value = 'code';
    t.context.saveDraft();
    assert.match(t.elements.get('draft-status').textContent, /保存失败/);

    t = setup();
    t.context.fetch = async () => ({ ok: true, json: async () => ({ phase: 'failed', detail: 'model unavailable' }) });
    await assert.rejects(t.context.monitorTranslation(4, 'A', () => {}), /model unavailable/);

    t = setup();
    t.storage.set('cf_draft_4_A', 'old code');
    t.context.initDraft();
    t.storage.set('cf_draft_4_A', 'new code in another tab');
    t.windowEvents.get('beforeunload')({ preventDefault() { throw Error('clean tab should close freely'); } });
    assert.equal(t.storage.get('cf_draft_4_A'), 'new code in another tab', 'closing an untouched old tab must not overwrite newer code');

    t = setup();
    t.storage.set('cf_draft_4_A', 'old code');
    t.context.initDraft();
    t.storage.set('cf_draft_4_A', 'new code');
    t.windowEvents.get('storage')({ key: 'cf_draft_4_A', newValue: 'new code' });
    assert.equal(t.elements.get('code-draft').value, 'new code', 'clean tabs should reflect shared draft changes');
    t.elements.get('code-draft').value = 'my unsaved changes';
    t.storage.set('cf_draft_4_A', 'other unsaved changes');
    t.windowEvents.get('storage')({ key: 'cf_draft_4_A', newValue: 'other unsaved changes' });
    assert.equal(t.context.saveDraft(), false);
    assert.equal(t.storage.get('cf_draft_4_A'), 'other unsaved changes');
    assert.equal(t.elements.get('code-draft').value, 'my unsaved changes');
    let warned = false;
    t.windowEvents.get('beforeunload')({ preventDefault() { warned = true; } });
    assert.equal(warned, true, 'a conflicting unsaved draft must not be discarded silently');

    let reloaded = false;
    t.context.window.location.reload = () => { reloaded = true; };
    t.context.translationNotice = message => t.notices.push({ message });
    t.context.reloadProblem();
    assert.equal(reloaded, false, 'translation completion must not reload over an unsaved conflicting draft');
    assert.match(t.notices.at(-1).message, /备份/);

    t = setup();
    t.context.PROBLEM_DATA.translated = false;
    t.context.fetch = async () => ({ ok: true, json: async () => ({ phase: 'complete', translated: true }) });
    reloaded = false;
    t.context.reloadProblem = () => { reloaded = true; };
    await t.context.reconcileProblemTranslation();
    assert.equal(reloaded, true, 'an original-only page must discover a completed batch translation');

    t = setup();
    t.context.PROBLEM_DATA.translated = false;
    t.context.fetch = async () => ({ ok: true, json: async () => ({ phase: 'translating', translated: false }) });
    let watching = false;
    t.context.watchProblemTranslation = () => { watching = true; };
    await t.context.reconcileProblemTranslation();
    assert.equal(watching, true, 'a page opened before the batch began must discover its running job');

    t = setup();
    for (const id of ['modal-title', 'formNodeId', 'formName', 'formApiKey', 'formBaseUrl', 'formModel', 'formPriority', 'node-modal-overlay', 'save-node-btn']) {
        t.elements.set(id, { value: '', innerText: '', style: {} });
    }
    vm.runInContext(fs.readFileSync('static/js/settings.js', 'utf8'), t.context);
    t.context.openEditForm({ id: 7, name: 'disabled', api_key_configured: true, base_url: 'https://example.com/v1', model: 'test', priority: 0, is_active: false });
    let savedNode;
    t.context.fetch = async (url, options) => { savedNode = JSON.parse(options.body); return { ok: true }; };
    await t.context.saveNode({ preventDefault() {} });
    assert.equal(savedNode.is_active, false, 'editing a disabled model must not enable it');
    assert.equal(savedNode.priority, 0, 'priority zero must survive editing');
    assert.equal(savedNode.api_key, null, 'editing should preserve the stored secret');

    t = setup();
    for (const id of ['contest-search', 'modal-problems-body', 'contest-modal-overlay']) {
        t.elements.set(id, { innerHTML: '', style: {}, addEventListener() {} });
    }
    t.context.AbortController = AbortController;
    const template = fs.readFileSync('templates/dashboard.html', 'utf8');
    const script = template.match(/<script>([\s\S]*?)<\/script>/)[1].split('// Start loading')[0];
    vm.runInContext(script, t.context);
    const responses = [];
    t.context.fetch = () => new Promise(resolve => responses.push(resolve));
    const oldRequest = t.context.loadContestProblems(1);
    const newRequest = t.context.loadContestProblems(2);
    const reply = (id, name) => ({ ok: true, json: async () => ({ problems: [{ contest_id: id, index: 'A', name, tags: [] }] }) });
    responses[1](reply(2, 'new contest'));
    await newRequest;
    responses[0](reply(1, 'old contest'));
    await oldRequest;
    assert.match(t.elements.get('modal-problems-body').innerHTML, /new contest/);
    assert.doesNotMatch(t.elements.get('modal-problems-body').innerHTML, /old contest/);

    t = setup();
    t.context.PROBLEM_DATA.translated = false;
    t.context.setViewMode('chinese');
    assert.equal(vm.runInContext('viewMode', t.context), 'english', 'untranslated problems must not switch to an empty Chinese column');

    t = setup();
    let acChecks = 0, batchChecks = 0;
    t.context.checkAcStatus = () => { acChecks++; };
    t.context.checkBatchQueueStatus = () => { batchChecks++; };
    t.windowEvents.get('DOMContentLoaded')();
    const periodic = t.intervals.find(timer => timer.ms === 30000);
    periodic.callback();
    assert.equal(acChecks, 2);
    assert.equal(batchChecks, 2, 'an already-visible tab must discover jobs started later in another window');
    console.log('17 frontend regression scenarios passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
