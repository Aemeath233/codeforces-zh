// Core client-side JavaScript for CF Mirror Single-Page Interactivity
const cfStorage = {
    getItem(key) { try { return localStorage.getItem(key); } catch { return null; } },
    setItem(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
    removeItem(key) { try { localStorage.removeItem(key); } catch {} }
};

async function requestTranslation(contestId, index, payload = {}) {
    const response = await fetch(`/api/problem/${contestId}/${encodeURIComponent(index)}/translate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || '无法启动翻译');
    return data;
}

async function monitorTranslation(contestId, index, onUpdate) {
    let failures = 0;
    while (true) {
        try {
            const response = await fetch(`/api/problem/${contestId}/${encodeURIComponent(index)}/status`);
            if (!response.ok) throw new Error('读取翻译状态失败');
            const data = await response.json();
            failures = 0;
            if (onUpdate(data) === false) return data;
            if (data.phase === 'failed') throw new Error(data.detail || '翻译失败，请重试');
            if (data.phase === 'complete') return data;
            if (data.phase === 'idle') throw new Error('翻译任务已中断，请重新点击翻译');
        } catch (error) {
            if (++failures >= 3 || !['TypeError', 'SyntaxError'].includes(error.name)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
}

// 1. Toast Notification Manager
function refreshLucideIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
    }
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const id = Date.now();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.id = `toast-${id}`;

    // Choose icon based on type
    const iconName = type === 'success' ? 'check-circle-2' : 'alert-circle';

    toast.innerHTML = `
        <i data-lucide="${iconName}" style="width: 18px; height: 18px;"></i>
        <span>${escapeHtml(message)}</span>
        <button onclick="removeToast(${id})" style="background: none; border: none; color: inherit; cursor: pointer; display: flex; align-items: center; margin-left: 8px;">
            <i data-lucide="x" style="width: 14px; height: 14px;"></i>
        </button>
    `;

    container.appendChild(toast);
    refreshLucideIcons();

    // Automatically remove after 3.5 seconds
    setTimeout(() => {
        removeToast(id);
    }, 3500);
}

function removeToast(id) {
    const toast = document.getElementById(`toast-${id}`);
    if (toast) {
        toast.style.animation = 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
        setTimeout(() => {
            toast.remove();
        }, 300);
    }
}

// 2. AC Status Syncing logic
let acSyncStatus = null;
let syncPollerId = null;

let checkingAc = false;
async function checkAcStatus() {
    if (checkingAc || document.hidden) return;
    checkingAc = true;
    try {
        const response = await fetch('/api/user/status-sync');
        if (response.ok) {
            const data = await response.json();
            acSyncStatus = data;
            renderAcStatusBar();

            // If on settings tab status view, update the detailed stats
            if (typeof loadStatusTabDetails === 'function') {
                loadStatusTabDetails(data);
            }

            // If it's currently syncing in the background, poll every 2.5 seconds
            if (data.syncing) {
                if (syncPollerId) clearInterval(syncPollerId);
                syncPollerId = setInterval(pollAcSyncStatus, 2500);
            } else if (syncPollerId) {
                clearInterval(syncPollerId);
                syncPollerId = null;
                // If it just finished, notify the user and refresh relevant page lists
                showSyncOutcomeToast(data);
            }
        }
    } catch (e) {
        console.error('Failed to fetch AC status sync info:', e);
    } finally { checkingAc = false; }
}

let pollingAc = false;
async function pollAcSyncStatus() {
    if (pollingAc || document.hidden) return;
    pollingAc = true;
    try {
        const response = await fetch('/api/user/status-sync');
        if (response.ok) {
            const data = await response.json();
            acSyncStatus = data;
            renderAcStatusBar();

            if (typeof loadStatusTabDetails === 'function') {
                loadStatusTabDetails(data);
            }

            if (!data.syncing) {
                clearInterval(syncPollerId);
                syncPollerId = null;
                showSyncOutcomeToast(data);

                // If we are on the problemset or cached pages, reload to show new solve statuses
                if (window.location.pathname === '/problemset' || window.location.pathname === '/cached' || window.location.pathname === '/dashboard') {
                    setTimeout(() => {
                        if (typeof loadProblems === 'function') {
                            loadProblems();
                        } else {
                            window.location.reload();
                        }
                    }, 1000);
                }
            }
        }
    } catch (e) {
        console.error(e);
    } finally { pollingAc = false; }
}

function showSyncOutcomeToast(data) {
    if (data.last_error) {
        showToast(`做题状态同步失败: ${data.last_error}`, 'error');
    } else if (data.record_count === 0) {
        showToast('同步完成，暂无做题记录', 'success');
    } else {
        showToast(`做题状态同步完成！(AC ${data.accepted_count || 0} 题 / 尝试未过 ${data.failed_count || 0} 题 / 共 ${data.record_count || 0} 条记录)`, 'success');
    }
}

async function triggerAcStatusSync() {
    if (acSyncStatus && acSyncStatus.syncing) return;
    showToast('正在同步做题记录…', 'success');

    try {
        const response = await fetch('/api/user/status-sync', { method: 'POST' });
        if (response.ok) {
            if (acSyncStatus) acSyncStatus.syncing = true;
            renderAcStatusBar();
            if (syncPollerId) clearInterval(syncPollerId);
            syncPollerId = setInterval(pollAcSyncStatus, 2500);
        } else {
            const err = await response.json();
            showToast(err.detail || '启动状态同步失败', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，启动状态同步失败', 'error');
    }
}

function renderAcStatusBar() {
    const bar = document.getElementById('ac-sync-status-bar');
    if (!bar) return;

    if (!acSyncStatus || !acSyncStatus.handle) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';

    // Clear styles
    bar.style.transition = 'all var(--transition-fast)';

    if (acSyncStatus.syncing) {
        bar.style.backgroundColor = 'var(--warning-bg, rgba(245, 158, 11, 0.08))';
        bar.style.color = 'var(--warning, #f59e0b)';
        bar.style.border = '1px solid rgba(245, 158, 11, 0.15)';
        bar.title = '做题状态同步中...';
        bar.onclick = null;
        bar.style.cursor = 'default';
        bar.innerHTML = `
            <div class="spinner" style="width: 12px; height: 12px; border-width: 2px; border-top-color: var(--warning, #f59e0b); animation-duration: 0.8s; flex-shrink: 0; margin: 0;"></div>
            <span>同步中…</span>
        `;
    } else if (acSyncStatus.last_error) {
        bar.style.backgroundColor = 'rgba(239, 68, 68, 0.08)';
        bar.style.color = '#ef4444';
        bar.style.border = '1px solid rgba(239, 68, 68, 0.15)';
        bar.title = `同步失败: ${acSyncStatus.last_error}。点击可重试同步。`;
        bar.onclick = event => { event.preventDefault(); triggerAcStatusSync(); };
        bar.style.cursor = 'pointer';
        bar.innerHTML = `
            <span style="display: inline-block; width: 6px; height: 6px; background-color: #ef4444; border-radius: 50%;"></span>
            <span>同步失败</span>
        `;
    } else {
        bar.style.backgroundColor = 'var(--success-bg, rgba(16, 185, 129, 0.08))';
        bar.style.color = 'var(--success, #10b981)';
        bar.style.border = '1px solid rgba(16, 185, 129, 0.15)';

        const syncTime = acSyncStatus.last_fetched > 0 ? new Date(acSyncStatus.last_fetched * 1000).toLocaleTimeString() : '无';
        bar.title = `最近同步时间: ${syncTime}。点击可重新同步。`;
        bar.onclick = event => { event.preventDefault(); triggerAcStatusSync(); };
        bar.style.cursor = 'pointer';
        bar.innerHTML = `
            <span style="display: inline-block; width: 6px; height: 6px; background-color: var(--success, #10b981); border-radius: 50%;"></span>
            <span>AC ${acSyncStatus.accepted_count || 0}</span>
        `;
    }
}


// 3. Batch Translation Queue Logic
let batchPollerId = null;

let checkingBatch = false;
async function checkBatchQueueStatus() {
    if (checkingBatch || document.hidden) return;
    checkingBatch = true;
    try {
        const response = await fetch('/api/batch-translate/status');
        if (response.ok) {
            const data = await response.json();
            updateBatchStatusUI(data);
            if (typeof reconcileProblemTranslation === 'function') reconcileProblemTranslation();

            // If active, ensure poller is running
            if (data.is_active) {
                if (batchPollerId) clearInterval(batchPollerId);
                batchPollerId = setInterval(checkBatchQueueStatus, 1500);
            } else {
                if (batchPollerId) {
                    clearInterval(batchPollerId);
                    batchPollerId = null;

                    // If it just finished, reload list if on problemset page
                    if (window.location.pathname === '/problemset') {
                        setTimeout(() => {
                            if (typeof loadProblems === 'function') {
                                loadProblems();
                            } else {
                                window.location.reload();
                            }
                        }, 1500);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to fetch batch queue status:', e);
    } finally { checkingBatch = false; }
}

async function triggerBatchTranslation(selectedProblemsList) {
    const problemsPayload = selectedProblemsList.map(p => ({
        contest_id: parseInt(p.contest_id, 10),
        index: p.index
    }));

    try {
        const response = await fetch('/api/batch-translate/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ problems: problemsPayload })
        });

        if (response.ok) {
            const res = await response.json();
            showToast(res.message || '已开始翻译', 'success');
            // Immediately start polling status
            checkBatchQueueStatus();
            return true;
        } else {
            const err = await response.json();
            showToast(err.detail || '启动批量翻译失败', 'error');
            return false;
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，启动批量翻译失败', 'error');
        return false;
    }
}

async function cancelBatch() {
    try {
        const response = await fetch('/api/batch-translate/cancel', { method: 'POST' });
        if (response.ok) {
            showToast('正在停止翻译', 'success');
            checkBatchQueueStatus();
        } else {
            const err = await response.json();
            showToast(err.detail || '取消翻译任务失败', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，取消翻译任务失败', 'error');
    }
}

function updateBatchStatusUI(data) {
    const wrapper = document.getElementById('batch-queue-status');
    if (typeof renderSettingsBatchQueue === 'function') renderSettingsBatchQueue(data);
    if (!wrapper) return;

    if (!data || !data.is_active) {
        wrapper.style.display = 'none';
        return;
    }

    wrapper.style.display = 'flex';

    const processed = data.completed + data.failed;
    const currentIndex = Math.min(processed + 1, data.total);

    document.getElementById('batch-progress-text').innerText = `翻译 ${processed}/${data.total}`;

    const countdown = document.getElementById('batch-countdown-text');
    if (data.timer_countdown > 0) {
        countdown.style.display = 'inline-block';
        countdown.innerText = `${data.timer_countdown}s`;
    } else {
        countdown.style.display = 'none';
    }

    let statusText = `正在翻译第 ${currentIndex}/${data.total} 道题`;
    if (data.current_problem) {
        statusText += `: ${data.current_problem}`;
    }
    if (data.timer_countdown > 0) {
        statusText += ` (等待下一题： ${data.timer_countdown}s)`;
    }
    wrapper.title = statusText;


}

document.getElementById('batch-cancel-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    cancelBatch();
});


// Helper to escape HTML strings
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 4. Initial Setup
let mainPollerId = null;

window.addEventListener('DOMContentLoaded', () => {
    // Check solved status sync
    checkAcStatus();
    if (mainPollerId) clearInterval(mainPollerId);
    mainPollerId = setInterval(() => { checkAcStatus(); checkBatchQueueStatus(); }, 30000);

    // Check batch queue status
    checkBatchQueueStatus();


});

window.addEventListener('beforeunload', () => {
    if (mainPollerId) clearInterval(mainPollerId);
    if (syncPollerId) clearInterval(syncPollerId);
    if (batchPollerId) clearInterval(batchPollerId);
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkAcStatus(); checkBatchQueueStatus(); } });
