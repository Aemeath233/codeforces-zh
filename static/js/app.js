// Core client-side JavaScript for CF Mirror Single-Page Interactivity

// 1. Toast Notification Manager
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
    lucide.createIcons();

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

async function checkAcStatus() {
    try {
        const response = await fetch('/api/user/status-sync');
        if (response.ok) {
            const data = await response.json();
            acSyncStatus = data;
            renderAcStatusBar();
            
            // If on settings tab status view, update the detailed stats
            if (typeof loadStatusTabDetails === 'function') {
                loadStatusTabDetails();
            }

            // If it's currently syncing in the background, poll every 2.5 seconds
            if (data.syncing) {
                if (!syncPollerId) {
                    syncPollerId = setInterval(pollAcSyncStatus, 2500);
                }
            } else if (syncPollerId) {
                clearInterval(syncPollerId);
                syncPollerId = null;
                // If it just finished, notify the user and refresh relevant page lists
                showSyncOutcomeToast(data);
            }
        }
    } catch (e) {
        console.error('Failed to fetch AC status sync info:', e);
    }
}

async function pollAcSyncStatus() {
    try {
        const response = await fetch('/api/user/status-sync');
        if (response.ok) {
            const data = await response.json();
            acSyncStatus = data;
            renderAcStatusBar();
            
            if (typeof loadStatusTabDetails === 'function') {
                loadStatusTabDetails();
            }

            if (!data.syncing) {
                clearInterval(syncPollerId);
                syncPollerId = null;
                showSyncOutcomeToast(data);
                
                // If we are on the problemset or cached pages, reload to show new solve statuses
                if (window.location.pathname === '/problemset' || window.location.pathname === '/cached' || window.location.pathname === '/dashboard') {
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
}

function showSyncOutcomeToast(data) {
    if (data.last_error) {
        showToast(`❌ 做题状态同步失败: ${data.last_error}`, 'error');
    } else if (data.record_count === 0) {
        showToast('Codeforces 做题状态同步完成，暂无记录。', 'success');
    } else {
        showToast(`🎉 做题状态同步完成！(AC ${data.accepted_count || 0} 题 / 尝试未过 ${data.failed_count || 0} 题 / 共 ${data.record_count || 0} 条记录)`, 'success');
    }
}

async function triggerAcStatusSync() {
    if (acSyncStatus && acSyncStatus.syncing) return;
    showToast('正在后台向 Codeforces 同步您的做题数据，请稍候...', 'success');
    
    try {
        const response = await fetch('/api/user/status-sync', { method: 'POST' });
        if (response.ok) {
            if (acSyncStatus) acSyncStatus.syncing = true;
            renderAcStatusBar();
            if (!syncPollerId) {
                syncPollerId = setInterval(pollAcSyncStatus, 2500);
            }
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
            <span>AC 同步中...</span>
        `;
    } else if (acSyncStatus.last_error) {
        bar.style.backgroundColor = 'rgba(239, 68, 68, 0.08)';
        bar.style.color = '#ef4444';
        bar.style.border = '1px solid rgba(239, 68, 68, 0.15)';
        bar.title = `同步失败: ${acSyncStatus.last_error}。点击可重试同步。`;
        bar.onclick = triggerAcStatusSync;
        bar.style.cursor = 'pointer';
        bar.innerHTML = `
            <span style="display: inline-block; width: 6px; height: 6px; background-color: #ef4444; border-radius: 50%;"></span>
            <span>同步失败: ${escapeHtml(acSyncStatus.handle)}</span>
            <span style="font-size: 10px; opacity: 0.8;">🔄</span>
        `;
    } else {
        bar.style.backgroundColor = 'var(--success-bg, rgba(16, 185, 129, 0.08))';
        bar.style.color = 'var(--success, #10b981)';
        bar.style.border = '1px solid rgba(16, 185, 129, 0.15)';
        
        const syncTime = acSyncStatus.last_fetched > 0 ? new Date(acSyncStatus.last_fetched * 1000).toLocaleTimeString() : '无';
        bar.title = `最近同步时间: ${syncTime}。点击可重新同步。`;
        bar.onclick = triggerAcStatusSync;
        bar.style.cursor = 'pointer';
        bar.innerHTML = `
            <span style="display: inline-block; width: 6px; height: 6px; background-color: var(--success, #10b981); border-radius: 50%;"></span>
            <span>做题状态已同步: ${escapeHtml(acSyncStatus.handle)} (AC ${acSyncStatus.accepted_count || 0} / 尝试未过 ${acSyncStatus.failed_count || 0} / 共 ${acSyncStatus.record_count || 0} 条记录)</span>
            <span style="font-size: 10px; opacity: 0.8;">🔄</span>
        `;
    }
}


// 3. Batch Translation Queue Logic
let batchQueue = {
    isActive: false,
    total: 0,
    currentIndex: 0,
    currentProblemId: null,
    statusText: '',
    timerCountdown: 0
};
let cancelBatchFlag = false;

async function triggerBatchTranslation(selectedProblemsList) {
    if (batchQueue.isActive) return;

    cancelBatchFlag = false;
    batchQueue = {
        isActive: true,
        total: selectedProblemsList.length,
        currentIndex: 0,
        currentProblemId: null,
        statusText: '正在准备批量翻译...',
        timerCountdown: 0
    };
    
    updateBatchStatusUI();
    showToast(`已启动批量翻译队列，共 ${selectedProblemsList.length} 道题目...`, 'success');

    let mockCount = 0;
    let failedCount = 0;
    let cachedOrTranslatedCount = 0;

    for (let i = 0; i < selectedProblemsList.length; i++) {
        if (cancelBatchFlag) break;

        const p = selectedProblemsList[i];
        batchQueue.currentIndex = i + 1;
        batchQueue.currentProblemId = p.id;
        batchQueue.statusText = `正在抓取并翻译第 ${i + 1}/${selectedProblemsList.length} 道题: ${p.contest_id}${p.index}...`;
        updateBatchStatusUI();

        let isCached = p.is_cached || false;

        if (isCached) {
            cachedOrTranslatedCount++;
            batchQueue.statusText = `已检测到本地缓存：自动跳过并加速下一题 ${p.contest_id}${p.index}...`;
            updateBatchStatusUI();
            await new Promise(resolve => setTimeout(resolve, 150));
        } else {
            try {
                // Request problem translation from backend API
                const response = await fetch(`/api/problem/${p.contest_id}/${p.index}`);
                if (!response.ok) {
                    throw new Error('翻译接口异常');
                }
                const data = await response.json();
                
                if (data.source === 'cache') {
                    isCached = true;
                    cachedOrTranslatedCount++;
                } else if (data.source === 'mock') {
                    mockCount++;
                } else {
                    cachedOrTranslatedCount++;
                }
            } catch (err) {
                console.error(err);
                failedCount++;
                showToast(`题目 ${p.contest_id}${p.index} 预翻译失败，已跳过。`, 'error');
            }
        }

        // Cool down for 60 seconds if it wasn't cached and not the last problem
        if (i < selectedProblemsList.length - 1 && !cancelBatchFlag) {
            if (isCached) continue; // Skip cooldown delay for cached items!

            let secondsLeft = 60;
            batchQueue.currentProblemId = null;
            batchQueue.statusText = `第 ${i + 1}/${selectedProblemsList.length} 道已成功预热！安全防风控冷却中...`;
            batchQueue.timerCountdown = secondsLeft;
            updateBatchStatusUI();

            const intervalId = setInterval(() => {
                secondsLeft--;
                batchQueue.timerCountdown = Math.max(0, secondsLeft);
                if (secondsLeft <= 0 || cancelBatchFlag) {
                    clearInterval(intervalId);
                }
                updateBatchStatusUI();
            }, 1000);

            // Wait 60s
            for (let s = 0; s < 60; s++) {
                if (cancelBatchFlag) {
                    clearInterval(intervalId);
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            clearInterval(intervalId);
        }
    }

    // Done
    batchQueue.isActive = false;
    updateBatchStatusUI();

    if (!cancelBatchFlag) {
        if (mockCount > 0 || failedCount > 0) {
            showToast(
                `批量预热完成：${cachedOrTranslatedCount} 道已缓存/翻译，${mockCount} 道为模拟翻译，${failedCount} 道失败。`,
                'error'
            );
        } else {
            showToast(`🎉 批量预翻译任务已全部圆满完成，已选题目已被本地离线缓存。`, 'success');
        }
        
        // Reload list to update local badges
        if (window.location.pathname === '/problemset') {
            setTimeout(() => { window.location.reload(); }, 1500);
        }
    } else {
        showToast('批量翻译任务已手动取消。', 'error');
    }
}

function cancelBatch() {
    cancelBatchFlag = true;
    batchQueue.statusText = '正在终止任务并清理队列...';
    batchQueue.timerCountdown = 0;
    updateBatchStatusUI();
}

function updateBatchStatusUI() {
    const wrapper = document.getElementById('batch-queue-status');
    if (!wrapper) return;

    if (!batchQueue.isActive) {
        wrapper.style.display = 'none';
        return;
    }

    wrapper.style.display = 'flex';
    document.getElementById('batch-progress-text').innerText = `预热进度: ${batchQueue.currentIndex}/${batchQueue.total}`;
    
    const countdown = document.getElementById('batch-countdown-text');
    if (batchQueue.timerCountdown > 0) {
        countdown.style.display = 'inline-block';
        countdown.innerText = `⏱️ ${batchQueue.timerCountdown}s`;
    } else {
        countdown.style.display = 'none';
    }
    
    wrapper.title = batchQueue.statusText;
}

document.getElementById('batch-cancel-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    cancelBatch();
});


// Helper to escape HTML strings
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 4. Initial Setup
window.addEventListener('DOMContentLoaded', () => {
    // Check solved status sync
    checkAcStatus();
    setInterval(checkAcStatus, 30000); // Poll silently every 30 seconds
});
