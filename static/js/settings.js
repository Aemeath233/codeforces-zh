// Tab switching logic for settings page
function switchSettingsTab(tabName) {
    document.querySelectorAll('.settings-content-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    const pane = document.getElementById(`pane-${tabName}`);
    const tabBtn = document.getElementById(`tab-btn-${tabName}`);

    if (pane && tabBtn) {
        pane.classList.add('active');
        tabBtn.classList.add('active');
        cfStorage.setItem('settings_active_tab', tabName);
    }

    // Fetch running status details when status tab is active
    if (tabName === 'status') {
        loadStatusTabDetails();
        refreshSystemLogs();
    }
}

// Fetch and render system logs
async function refreshSystemLogs() {
    const logsTextarea = document.getElementById('system-logs-textarea');
    if (!logsTextarea) return;

    try {
        const response = await fetch('/api/logs');
        if (response.ok) {
            const data = await response.json();
            logsTextarea.value = data.logs || '暂无日志内容';
            // Scroll to bottom so newest logs are immediately visible
            logsTextarea.scrollTop = logsTextarea.scrollHeight;
        } else {
            logsTextarea.value = '加载日志失败';
        }
    } catch (e) {
        console.error(e);
        logsTextarea.value = '网络错误，加载日志失败';
    }
}

// Clear log file content
async function clearSystemLogsFile() {
    if (!confirm('确定要清空当前的系统运行日志文件吗？')) return;

    try {
        const response = await fetch('/api/logs', { method: 'DELETE' });
        if (response.ok) {
            const data = await response.json();
            showToast(data.message || '日志已清空', 'success');
            refreshSystemLogs();
        } else {
            showToast('清空日志失败', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，清空日志失败', 'error');
    }
}

// Fetch and render settings status details
async function loadStatusTabDetails(existingData = null) {
    const card = document.getElementById('status-sync-details-card');
    if (!card) return;

    try {
        const response = existingData ? null : await fetch('/api/user/status-sync');
        if (existingData || response.ok) {
            const data = existingData || await response.json();

            if (data.handle) {
                let statusHtml = '';
                if (data.syncing) {
                    statusHtml = `
                        <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--warning);">
                            <div class="spinner" style="width: 14px; height: 14px; border-width: 2px; border-top-color: var(--warning); animation-duration: 0.8s; margin: 0;"></div>
                            <span>后台同步任务正在进行中 (Syncing...)</span>
                        </div>
                    `;
                } else if (data.last_error) {
                    statusHtml = `
                        <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--danger);">
                            <span style="width: 8px; height: 8px; background-color: var(--danger); border-radius: 50%;"></span>
                            <span>上次同步失败: ${escapeHtml(data.last_error)}</span>
                        </div>
                    `;
                } else {
                    statusHtml = `
                        <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--success);">
                            <span style="width: 8px; height: 8px; background-color: var(--success); border-radius: 50%;"></span>
                            <span>同步状态健康 (Connected)</span>
                        </div>
                    `;
                }

                const syncTime = data.last_fetched > 0 ? new Date(data.last_fetched * 1000).toLocaleString() : '从无';

                card.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0,0,0,0.05); padding-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div>
                                    <div style="font-weight: 700; font-size: 16px; color: var(--text-primary);">${escapeHtml(data.handle)}</div>
                                    <div style="font-size: 12px; color: var(--text-secondary);">已绑定的 Codeforces 账号</div>
                                </div>
                            </div>
                            ${statusHtml}
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; text-align: center;">
                            <div style="background-color: var(--bg-card); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
                                <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">已通过题目 (AC)</div>
                                <strong style="font-size: 20px; color: var(--success);">${data.accepted_count || 0} 题</strong>
                            </div>
                            <div style="background-color: var(--bg-card); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
                                <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">尝试未通过</div>
                                <strong style="font-size: 20px; color: var(--warning);">${data.failed_count || 0} 题</strong>
                            </div>
                            <div style="background-color: var(--bg-card); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
                                <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">同步总条数</div>
                                <strong style="font-size: 20px; color: var(--text-primary);">${data.record_count || 0} 条</strong>
                            </div>
                        </div>

                        <div style="font-size: 12.5px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px;">
                            <span>上次同步成功时间:</span>
                            <strong>${syncTime}</strong>
                        </div>
                    </div>
                `;
            } else {
                card.innerHTML = `
                    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; text-align: center;">
                        <div style="font-weight: 700; color: var(--text-primary);">您尚未绑定 Codeforces 账号</div>
                        <p style="font-size: 13px; color: var(--text-secondary); max-width: 450px;">
                            绑定 Codeforces 账号后，本地系统可以自动拉取您的 AC 记录并在题库中高亮标记。
                        </p>
                        <button onclick="switchSettingsTab('account')" class="btn-secondary" style="padding: 8px 16px; margin-top: 4px;">
                            立即前往导入账号
                        </button>
                    </div>
                `;
            }
        }
        // Re-initialize icons inside settings panel
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            window.lucide?.createIcons?.();
        }
        // Check batch queue status to update Tab 1 card as well
        if (typeof checkBatchQueueStatus === 'function') {
            checkBatchQueueStatus();
        }
    } catch (error) {
        console.error('Failed to load status details:', error);
        card.innerHTML = `<div style="color: var(--danger); font-weight: 600;">获取状态详情失败，请检查网络。</div>`;
    }
}

// Render batch translation queue details on Tab 1 card
function renderSettingsBatchQueue(data) {
    const detailsDiv = document.getElementById('batch-queue-details');
    if (!detailsDiv) return;

    if (!data || !data.is_active) {
        detailsDiv.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--text-secondary); font-size: 14px; min-height: 80px;">
                <i data-lucide="info" style="width: 18px; height: 18px; color: var(--text-muted);"></i>
                <span>${data && data.total ? `上次任务：成功 ${data.completed} 题，失败 ${data.failed} 题${data.cancel_flag ? "（已取消）" : ""}` : "当前没有批量翻译任务"}</span>${data && data.errors && data.errors.length ? `<p>${data.errors.map(escapeHtml).join("<br>")}</p>` : ""}
            </div>
        `;
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            window.lucide?.createIcons?.();
        }
        return;
    }

    const processed = data.completed + data.failed + data.mocked;
    const currentIndex = Math.min(processed + 1, data.total);
    const percent = Math.round((processed / data.total) * 100) || 0;

    let statusBadge = '';
    if (data.timer_countdown > 0) {
        statusBadge = `
            <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--warning);">
                <div class="spinner" style="width: 14px; height: 14px; border-width: 2px; border-top-color: var(--warning); animation-duration: 0.8s; margin: 0;"></div>
                <span>冷却等待中 (${data.timer_countdown}s)</span>
            </div>
        `;
    } else {
        statusBadge = `
            <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--primary);">
                <div class="spinner" style="width: 14px; height: 14px; border-width: 2px; border-top-color: var(--primary); animation-duration: 0.8s; margin: 0;"></div>
                <span>正在抓取并翻译...</span>
            </div>
        `;
    }

    detailsDiv.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0,0,0,0.05); padding-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                <div>
                    <div style="font-weight: 700; font-size: 16px; color: var(--text-primary);">
                        批量翻译进度: ${currentIndex} / ${data.total}
                    </div>
                    <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                        当前翻译题目: <strong style="color: var(--primary); font-family: var(--font-mono);">${data.current_problem || '准备中'}</strong>
                    </div>
                </div>
                ${statusBadge}
            </div>

            <!-- Progress Bar -->
            <div style="width: 100%; height: 8px; background-color: var(--border-color); border-radius: 4px; overflow: hidden; position: relative;">
                <div style="width: ${percent}%; height: 100%; background-color: var(--primary); transition: width 0.3s ease;"></div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; text-align: center;">
                <div style="background-color: var(--bg-card); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
                    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">翻译成功</div>
                    <strong style="font-size: 20px; color: var(--success);">${data.completed || 0} 题</strong>
                </div>
                <div style="background-color: var(--bg-card); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
                    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">剩余待翻译</div>
                    <strong style="font-size: 20px; color: var(--warning);">${data.remaining_problems ? data.remaining_problems.length : 0} 题</strong>
                </div>
                <div style="background-color: var(--bg-card); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
                    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">翻译失败</div>
                    <strong style="font-size: 20px; color: var(--danger);">${data.failed || 0} 题</strong>
                </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
                <div style="font-size: 12.5px; color: var(--text-secondary);">
                    剩余待翻译题目: <strong>${data.remaining_problems ? data.remaining_problems.length : 0} 题</strong>
                </div>
                <button onclick="cancelBatch()" class="btn-secondary" style="padding: 6px 16px; color: var(--danger); border-color: var(--danger-bg); background-color: rgba(239, 68, 68, 0.04); font-size: 12.5px; font-weight: 600;">
                    取消批量翻译
                </button>
            </div>
        </div>
    `;
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        window.lucide?.createIcons?.();
    }
}

// Helper to escape HTML strings inside JS


// Load cached compiler settings on initialization
const cachedCompiler = cfStorage.getItem('cf_compiler_id') || '';
const compilerSelect = document.getElementById('cfCompiler');
if (compilerSelect) {
    compilerSelect.value = cachedCompiler;
}

// Load active settings tab on load
const savedSettingsTab = cfStorage.getItem('settings_active_tab');
const activeSettingsTab = ['status', 'account', 'api', 'prompt'].includes(savedSettingsTab) ? savedSettingsTab : 'status';
switchSettingsTab(activeSettingsTab);

// Save CF credentials
async function saveUserAuth(e) {
    e.preventDefault();
    const handle = document.getElementById('cfHandle').value.trim();
    const compiler = document.getElementById('cfCompiler').value;
    const cooldown = parseInt(document.getElementById('batchCooldown').value, 10) || 0;

    // Save compiler choice to localstorage
    cfStorage.setItem('cf_compiler_id', compiler);

    const btn = document.getElementById('save-user-btn');
    btn.innerText = '正在保存配置...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/config/user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cf_handle: handle,
                batch_cooldown: cooldown
            })
        });
        if (response.ok) {
            if (handle) {
                showToast('设置保存成功！做题状态同步功能已激活。', 'success');
                triggerAcStatusSync();
            } else {
                showToast('设置已保存。未填写 Handle，将跳过做题状态同步。', 'success');
                checkAcStatus();
            }
        } else {
            const data = await response.json().catch(() => ({}));
            showToast(data.detail || '保存设置失败', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，保存设置失败', 'error');
    } finally {
        btn.innerText = '保存设置';
        btn.disabled = false;
    }
}

// Modal helpers
let editingNodeActive = true;
function openAddForm() {
    editingNodeActive = true;
    document.getElementById('modal-title').innerText = '添加全新大模型 API 节点';
    document.getElementById('formNodeId').value = '';
    document.getElementById('formName').value = '';
    document.getElementById('formApiKey').value = '';
    document.getElementById('formBaseUrl').value = 'https://api.openai.com/v1';
    document.getElementById('formModel').value = 'gpt-4o-mini';
    document.getElementById('formPriority').value = '1';

    document.getElementById('node-modal-overlay').style.display = 'flex';
}

function openEditForm(node) {
    editingNodeActive = node.is_active;
    document.getElementById('modal-title').innerText = '修改 API 节点参数';
    document.getElementById('formNodeId').value = node.id;
    document.getElementById('formName').value = node.name;
    document.getElementById('formApiKey').value = node.api_key_configured ? '****' : '';
    document.getElementById('formBaseUrl').value = node.base_url;
    document.getElementById('formModel').value = node.model;
    document.getElementById('formPriority').value = node.priority;

    document.getElementById('node-modal-overlay').style.display = 'flex';
}

function closeModal() {
    document.getElementById('node-modal-overlay').style.display = 'none';
}

// Save LLM Node
async function saveNode(e) {
    e.preventDefault();
    const nodeId = document.getElementById('formNodeId').value;
    const name = document.getElementById('formName').value.trim();
    const priority = Number(document.getElementById('formPriority').value);
    const apiKey = document.getElementById('formApiKey').value;
    const baseUrl = document.getElementById('formBaseUrl').value.trim();
    const model = document.getElementById('formModel').value.trim();

    if (!name) {
        showToast('请填写节点标识名称！', 'error');
        return;
    }

    const btn = document.getElementById('save-node-btn');
    btn.innerText = '正在保存...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/config/llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: nodeId ? parseInt(nodeId) : null,
                name: name,
                api_key: apiKey === '****' ? null : apiKey,
                base_url: baseUrl,
                model: model,
                priority: priority,
                is_active: editingNodeActive
            })
        });

        if (response.ok) {
            showToast(nodeId ? 'API 节点已更新！' : 'API 节点添加成功！', 'success');
            closeModal();
            window.location.reload();
        } else {
            const error = await response.json().catch(() => ({}));
            showToast(error.detail || '保存 API 节点失败', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，保存节点失败', 'error');
    } finally {
        btn.innerText = '确认并保存节点';
        btn.disabled = false;
    }
}

// Toggle node active status
async function toggleActive(node) {
    try {
        const response = await fetch('/api/config/llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: node.id,
                name: node.name,
                base_url: node.base_url,
                model: node.model,
                priority: node.priority,
                is_active: !node.is_active
            })
        });
        if (response.ok) {
            showToast(`${node.name} 已${!node.is_active ? '启用' : '禁用'}`, 'success');
            window.location.reload();
        }
    } catch (e) {
        console.error(e);
    }
}

// Delete LLM Node
async function deleteNode(id) {
    if (!confirm('您确定要删除这个 API 节点吗？')) return;
    try {
        const response = await fetch(`/api/config/llm/${id}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            showToast('API 节点已成功移除！', 'success');
            window.location.reload();
        } else {
            showToast('移除 API 节点失败', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，删除失败', 'error');
    }
}

// Test connection
async function testNode(node) {
    const resultDiv = document.getElementById(`test-result-${node.id}`);
    resultDiv.style.display = 'flex';
    resultDiv.style.backgroundColor = 'var(--bg-main)';
    resultDiv.style.color = 'var(--text-primary)';
    resultDiv.style.border = '1px solid var(--border-color)';
    resultDiv.innerHTML = `<div class="spinner" style="width: 16px; height: 16px; border-width: 2px; margin: 0;"></div><span>正在发送轻量级 token 测试连接...</span>`;

    showToast(`正在向 ${node.name} 发送测试连接...`, 'success');

    try {
        const response = await fetch('/api/config/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: node.id,
                api_key: '****',
                base_url: node.base_url,
                model: node.model
            })
        });

        const data = await response.json();
        if (response.ok) {
            resultDiv.style.backgroundColor = 'var(--success-bg)';
            resultDiv.style.color = 'var(--success)';
            resultDiv.style.border = '1px solid rgba(22, 101, 52, 0.2)';
            resultDiv.innerHTML = `<i data-lucide="check-circle-2" style="width:16px; height:16px;"></i><span>连接成功！大模型响应内容: <b>“${escapeHtml(data.reply)}”</b> (连通性完美)</span>`;
            showToast(`测试成功！大模型已成功响应。`, 'success');
        } else {
            resultDiv.style.backgroundColor = 'var(--danger-bg)';
            resultDiv.style.color = 'var(--danger)';
            resultDiv.style.border = '1px solid rgba(153, 27, 27, 0.2)';
            resultDiv.innerHTML = `<i data-lucide="alert-circle" style="width:16px; height:16px;"></i><span>连接失败！故障详情: <code>${escapeHtml(data.detail || '接口连接失败，请检查配置')}</code></span>`;
            showToast(`测试失败：${data.detail || '无法连接'}`, 'error');
        }
        window.lucide?.createIcons?.();
    } catch (e) {
        console.error(e);
        resultDiv.style.backgroundColor = 'var(--danger-bg)';
        resultDiv.style.color = 'var(--danger)';
        resultDiv.style.border = '1px solid rgba(153, 27, 27, 0.2)';
        resultDiv.innerHTML = `<i data-lucide="alert-circle" style="width:16px; height:16px;"></i><span>网络错误，无法连接接口</span>`;
        showToast('连接测试失败，请检查本地后端状态。', 'error');
        window.lucide?.createIcons?.();
    }
}

// Save prompt tuner
async function savePrompt(e) {
    e.preventDefault();
    const prompt = document.getElementById('systemPrompt').value;
    const btn = document.getElementById('save-prompt-btn');
    btn.innerText = '正在保存...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/config/system_prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_prompt: prompt })
        });
        if (response.ok) {
            showToast('系统翻译提示词保存成功！', 'success');
        } else {
            showToast('系统提示词保存失败', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('网络错误，无法保存提示词', 'error');
    } finally {
        btn.innerHTML = `<i data-lucide="save" style="width:16px; height:16px;"></i>保存系统提示词`;
        btn.disabled = false;
        window.lucide?.createIcons?.();
    }
}
