let viewMode = 'chinese'; // 'bilingual' | 'chinese' | 'english'

// Load active tab highlight in sidebar/topbar
function initProblemView() {
    const activeTabItem = document.getElementById('nav-item-problem');
    if (activeTabItem && typeof PROBLEM_DATA !== 'undefined') {
        activeTabItem.style.display = 'flex';
        const navTitle = document.getElementById('nav-problem-title');
        if (navTitle) {
            navTitle.innerText = `${PROBLEM_DATA.contestId}${PROBLEM_DATA.problemIndex}`;
        }
    }
    const savedMode = cfStorage.getItem('cf_reading_mode');
    setViewMode(PROBLEM_DATA.translated ? (['chinese', 'english', 'bilingual'].includes(savedMode) ? savedMode : 'chinese') : 'english', false);
    setupSampleHighlights();
    initSubmissionLinks();
    const job = PROBLEM_DATA.translationJob;
    if (job && ['queued', 'scraping', 'translating'].includes(job.phase)) {
        watchProblemTranslation();
    } else if (job && job.phase === 'failed') {
        translationNotice(job.detail, true);
    }
    try {
        const scroll = sessionStorage.getItem('cf_problem_reload_scroll');
        if (scroll) { sessionStorage.removeItem('cf_problem_reload_scroll'); window.scrollTo(0, Number(scroll)); }
    } catch {}

}

// Toggle view modes
function setViewMode(mode, persist = true) {
    if (!PROBLEM_DATA.translated && mode !== 'english') mode = 'english';
    viewMode = mode;
    if (persist) cfStorage.setItem('cf_reading_mode', mode);

    // Update buttons
    const btnBilingual = document.getElementById('btn-view-bilingual');
    const btnChinese = document.getElementById('btn-view-chinese');
    const btnEnglish = document.getElementById('btn-view-english');

    if (btnBilingual) btnBilingual.classList.remove('active');
    if (btnChinese) btnChinese.classList.remove('active');
    if (btnEnglish) btnEnglish.classList.remove('active');

    const activeBtn = document.getElementById(`btn-view-${mode}`);
    if (activeBtn) activeBtn.classList.add('active');

    const split = document.getElementById('problem-columns-split');
    const zhCol = document.getElementById('chinese-column');
    const enCol = document.getElementById('english-column');
    if (split && zhCol && enCol) {
        split.classList.toggle('single-column', mode !== 'bilingual');
        zhCol.style.display = mode === 'english' ? 'none' : 'block';
        enCol.style.display = mode === 'chinese' ? 'none' : 'block';
    }
    for (const name of ['chinese', 'bilingual', 'english']) {
        document.getElementById(`btn-view-${name}`)?.setAttribute('aria-pressed', String(name === mode));
    }

    // Toggle Note layout if it exists
    const noteSection = document.getElementById('note-bilingual-section');
    if (noteSection) {
        const noteSplit = document.getElementById('note-columns-split');
        const noteZhCol = document.getElementById('chinese-note-col');
        const noteEnCol = document.getElementById('english-note-col');

        if (noteSplit && noteZhCol && noteEnCol) {
            if (mode === 'bilingual') {
                noteSplit.classList.remove('single-column');
                noteZhCol.style.display = 'block';
                noteEnCol.style.display = 'block';
            } else if (mode === 'chinese') {
                noteSplit.classList.add('single-column');
                noteZhCol.style.display = 'block';
                noteEnCol.style.display = 'none';
            } else if (mode === 'english') {
                noteSplit.classList.add('single-column');
                noteZhCol.style.display = 'none';
                noteEnCol.style.display = 'block';
            }
        }
    }
}

function translationNotice(message, failed = false) {
    const notice = document.getElementById('translation-status');
    notice.hidden = false;
    notice.classList.toggle('failed', failed);
    document.getElementById('translation-status-text').textContent = message;
}

function reloadProblem() {
    try { sessionStorage.setItem('cf_problem_reload_scroll', String(window.scrollY)); } catch {}
    window.location.reload();
}

let watchingTranslation = false;
let checkingProblemTranslation = false;
async function reconcileProblemTranslation() {
    if (PROBLEM_DATA.translated || watchingTranslation || checkingProblemTranslation) return;
    checkingProblemTranslation = true;
    try {
        const response = await fetch(`/api/problem/${PROBLEM_DATA.contestId}/${encodeURIComponent(PROBLEM_DATA.problemIndex)}/status`);
        if (!response.ok) return;
        const data = await response.json();
        if (data.translated) reloadProblem();
        else if (['queued', 'scraping', 'translating'].includes(data.phase)) watchProblemTranslation();
        else if (data.phase === 'failed') translationNotice(data.detail, true);
    } catch {} finally { checkingProblemTranslation = false; }
}

async function watchProblemTranslation() {
    if (watchingTranslation) return;
    watchingTranslation = true;
    const btn = document.getElementById('force-refresh-btn');
    btn.disabled = true;
    try {
        await monitorTranslation(PROBLEM_DATA.contestId, PROBLEM_DATA.problemIndex, data => {
            const labels = { queued: '等待翻译…', scraping: '正在获取原题…', translating: '正在翻译，可以先阅读英文。' };
            if (labels[data.phase]) translationNotice(labels[data.phase]);
        });
        reloadProblem();
    } catch (error) {
        translationNotice(error.message + (PROBLEM_DATA.translated ? ' 原有中文译文已保留。' : ''), true);
        showToast(error.message, 'error');
    } finally {
        btn.disabled = false;
        watchingTranslation = false;
    }
}

async function forceRefreshTranslation() {
    if (watchingTranslation) return;
    const btn = document.getElementById('force-refresh-btn');
    btn.disabled = true;
    try {
        await requestTranslation(PROBLEM_DATA.contestId, PROBLEM_DATA.problemIndex, { force: true });
        await watchProblemTranslation();
    } catch (error) {
        translationNotice(error.message, true);
        showToast(error.message, 'error');
    } finally { btn.disabled = false; }
}

function officialSubmitUrl() {
    const { contestId, problemIndex } = PROBLEM_DATA;
    const section = Number(contestId) >= 100000 ? 'gym' : 'contest';
    const params = new URLSearchParams({ submittedProblemIndex: problemIndex });
    const compiler = cfStorage.getItem('cf_compiler_id') || '';
    if (compiler) params.set('programTypeId', compiler);
    return `https://codeforces.com/${section}/${contestId}/submit?${params}`;
}

function rememberOfficialVisit() {
    cfStorage.setItem('cf_official_visit', String(Date.now()));
}

function initSubmissionLinks() {
    document.querySelectorAll('[data-submit-link]').forEach(link => {
        link.href = officialSubmitUrl();
        link.addEventListener('click', rememberOfficialVisit);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        const visit = Number(cfStorage.getItem('cf_official_visit'));
        if (visit) {
            cfStorage.removeItem('cf_official_visit');
            if (Date.now() - visit < 24 * 3600 * 1000) refreshProblemStatus(true);
        }
    });
}

async function copyTextToClipboard(text, successMsg) {
    try {
        if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(text);
    } catch {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(textArea);
        textArea.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch {}
        textArea.remove();
        if (!copied) { showToast('复制失败，请手动选择内容后复制。', 'error'); return false; }
    }
    if (successMsg) showToast(successMsg, 'success');
    return true;
}

async function refreshProblemStatus(silent = false) {
    if (!acSyncStatus || !acSyncStatus.handle) {
        if (!silent) showToast('请先在设置中填写 CF Handle，才能同步做题状态', 'error');
        return;
    }
    if (!silent) await triggerAcStatusSync();
    else {
        await fetch('/api/user/status-sync', { method: 'POST' }).catch(() => {});
        checkAcStatus();
    }
}

// Copy sample test text
function copyText(text, type) {
    copyTextToClipboard(text, `样例${type}已复制`);
}

// Format HTML elements to plain text (Markdown representation)
function cleanHtmlToText(html) {
    if (!html) return '';
    let text = html;
    // Clean loading badges if any
    text = text.replace(/<div style=['"]background:\s*#(eff6ff|fee2e2|fef08a)[^>]*>([\s\S]*?)<\/div>/i, '');
    text = text.replace(/<p[^>]*>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<li[^>]*>/gi, '\n* ');
    text = text.replace(/<\/li>/gi, '');
    text = text.replace(/<ul[^>]*>/gi, '');
    text = text.replace(/<\/ul>/gi, '\n');
    text = text.replace(/<pre[^>]*><code[^>]*>/gi, '\n```\n');
    text = text.replace(/<\/code><\/pre>/gi, '\n```\n');
    text = text.replace(/<code[^>]*>/gi, '`');
    text = text.replace(/<\/code>/gi, '`');
    text = text.replace(/<[^>]+>/g, '');

    const entities = {
        '&quot;': '"',
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&nbsp;': ' ',
        '&apos;': "'",
        '&middot;': '·',
        '&ldquo;': '“',
        '&rdquo;': '”',
        '&hellip;': '…'
    };
    text = text.replace(/&[a-z0-9#]+;/gi, (match) => entities[match] || match);
    return text.split('\n').map(line => line.trim()).filter((line, i, arr) => line !== '' || arr[i-1] !== '').join('\n');
}

// Copy the original statement data, before MathJax changes the DOM.
function copyProblem(lang) {
    if (typeof PROBLEM_DATA === 'undefined') return;
    const {
        titleZh, titleEn,
        descZh, descEn,
        inputSpecZh, inputSpecEn,
        outputSpecZh, outputSpecEn,
        noteZh, noteEn,
        timeLimit, memoryLimit,
        hasNote, samples
    } = PROBLEM_DATA;

    const title = lang === 'zh' ? titleZh : titleEn;

    let descHtml = lang === 'zh' ? descZh : descEn;
    descHtml = descHtml.replace(/^<div style=['"]background:\s*#(eff6ff|fee2e2|fef08a)[^>]*>([\s\S]*?)<\/div>/i, '');
    descHtml = descHtml.replace(/^<div style=['"][^'"]*['"]>\s*.*?(?:智能加速翻译|系统提示|多API回退告警|智能翻译节点).*?<\/div>/i, '');

    const desc = cleanHtmlToText(descHtml);

    const inputSpecHtml = lang === 'zh' ? inputSpecZh : inputSpecEn;
    const inputSpec = cleanHtmlToText(inputSpecHtml);

    const outputSpecHtml = lang === 'zh' ? outputSpecZh : outputSpecEn;
    const outputSpec = cleanHtmlToText(outputSpecHtml);

    const noteHtml = lang === 'zh' ? noteZh : noteEn;
    const note = cleanHtmlToText(noteHtml);

    let fullMarkdown = lang === 'zh' ? `# 题目: ${title}\n` : `# Problem: ${title}\n`;
    fullMarkdown += lang === 'zh'
        ? `**时间限制**: ${timeLimit} | **内存限制**: ${memoryLimit}\n\n`
        : `**Time Limit**: ${timeLimit} | **Memory Limit**: ${memoryLimit}\n\n`;

    fullMarkdown += lang === 'zh' ? `## 题目描述\n${desc}\n\n` : `## Description\n${desc}\n\n`;

    if (inputSpec) {
        fullMarkdown += lang === 'zh' ? `## 输入格式说明\n${inputSpec}\n\n` : `## Input\n${inputSpec}\n\n`;
    }
    if (outputSpec) {
        fullMarkdown += lang === 'zh' ? `## 输出格式说明\n${outputSpec}\n\n` : `## Output\n${outputSpec}\n\n`;
    }

    if (note && hasNote) {
        fullMarkdown += lang === 'zh' ? `## 提示与说明\n${note}\n\n` : `## Note\n${note}\n\n`;
    }

    if (samples && samples.length > 0) {
        fullMarkdown += lang === 'zh' ? `## 评测样例数据 (Examples)\n` : `## Examples\n`;
        samples.forEach((sample, idx) => {
            const cleanInput = sample.input;
            const cleanOutput = sample.output;
            fullMarkdown += `### Example #${idx + 1}\n`;
            fullMarkdown += `**Input**:\n\`\`\`\n${cleanInput}\n\`\`\`\n`;
            fullMarkdown += `**Output**:\n\`\`\`\n${cleanOutput}\n\`\`\`\n\n`;
        });
    }

    copyTextToClipboard(fullMarkdown.trim(), '题面已复制');
}

// Setup interactive test case line highlighting (Codeforces style)
function setupSampleHighlights() {
    document.querySelectorAll('.sample-block').forEach(block => {
        const inputPre = block.querySelector('.sample-input-cell .sample-pre');
        const outputPre = block.querySelector('.sample-output-cell .sample-pre');
        if (!inputPre || !outputPre) return;
        const inputLines = [...inputPre.querySelectorAll('.sample-line')];
        const outputLines = [...outputPre.querySelectorAll('.sample-line')];
        // Old caches may only have CF's alternating group classes.
        if (!inputLines.some(line => line.hasAttribute('data-group'))) {
            let group = 0, previous = null;
            inputLines.forEach(line => {
                const style = line.classList.contains('even') ? 'even' : line.classList.contains('odd') ? 'odd' : null;
                if (!style) return;
                if (style !== previous) group++;
                line.dataset.group = String(group);
                previous = style;
            });
        }
        const groups = [...new Set(inputLines.map(line => line.dataset.group).filter(g => g && g !== '0'))];
        // Only infer a one-line output for each explicitly known input group.
        // Unequal output sizes cannot be inferred safely from line counts.
        if (!outputLines.some(line => line.hasAttribute('data-group')) && outputLines.length === groups.length) {
            outputLines.forEach((line, index) => { line.dataset.group = groups[index]; });
        }
        block.querySelectorAll('.sample-line[data-group]').forEach(line => {
            const group = line.dataset.group;
            if (!group || group === '0' || !/^\d+$/.test(group)) return;
            line.addEventListener('mouseenter', () => {
                block.querySelectorAll(`.sample-line[data-group="${group}"]`).forEach(other => other.classList.add('highlighted-line'));
            });
            line.addEventListener('mouseleave', () => {
                block.querySelectorAll('.highlighted-line').forEach(other => other.classList.remove('highlighted-line'));
            });
        });
    });
}

// Run setup on load if document is already ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProblemView);
} else {
    initProblemView();
}
