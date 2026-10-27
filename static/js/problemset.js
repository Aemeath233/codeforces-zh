const POPULAR_TAGS = [
    "implementation", "math", "greedy", "dp", "data structures",
    "brute force", "constructive algorithms", "graphs", "sortings",
    "binary search", "dfs and similar", "trees", "strings",
    "number theory", "combinatorics", "two pointers", "geometry",
    "bitmasks", "dsu", "shortest paths", "probabilities"
];

let problems = [];
let total = 0;
let page = Math.max(1, parseInt(cfStorage.getItem('cf_lib_page') || '1', 10) || 1);
let limit = Math.min(100, Math.max(1, parseInt(cfStorage.getItem('cf_lib_limit') || '50', 10) || 50));
let searchQuery = cfStorage.getItem('cf_lib_search_query') || '';
let selectedTag = cfStorage.getItem('cf_lib_selected_tag') || '';
let minRating = cfStorage.getItem('cf_lib_min_rating') || '';
let maxRating = cfStorage.getItem('cf_lib_max_rating') || '';
let sortBy = cfStorage.getItem('cf_lib_sort_by') || null; // 'rating' or null
let sortOrder = cfStorage.getItem('cf_lib_sort_order') || 'asc'; // 'asc' or 'desc'

// Selected problems list for batch processing
let selectedProblems = [];
try {
    const stored = JSON.parse(cfStorage.getItem('cf_lib_selected_problems') || '[]');
    selectedProblems = Array.isArray(stored) ? stored.filter(p => p && /^\d+_[A-Z][A-Z0-9]*$/.test(p.id)).slice(0, 500) : [];
} catch(e) {
    selectedProblems = [];
}

// Sync library state
let isSyncing = false;

// Setup initial values when page is loaded
function initInputs() {
    const searchInput = document.getElementById('searchQuery');
    const minRatingInput = document.getElementById('minRating');
    const maxRatingInput = document.getElementById('maxRating');
    const limitSelectInput = document.getElementById('limit-select');

    if (searchInput) searchInput.value = searchQuery;
    if (minRatingInput) minRatingInput.value = minRating;
    if (maxRatingInput) maxRatingInput.value = maxRating;
    if (limitSelectInput) limitSelectInput.value = limit.toString();
}

// Render filter tag buttons
function renderTagFilters() {
    const container = document.getElementById('tags-container');
    if (!container) return;
    let html = '';
    POPULAR_TAGS.forEach(tag => {
        const isActive = tag === selectedTag;
        html += `
            <button
                type="button"
                onclick="handleTagClick('${tag}')"
                style="padding: 4px 10px; border-radius: 20px; font-size: 12px; border: 1px solid ${isActive ? 'var(--primary)' : 'var(--border-color)'}; background-color: ${isActive ? 'var(--primary-light)' : 'var(--bg-card)'}; color: ${isActive ? 'var(--primary)' : 'var(--text-secondary)'}; cursor: pointer; font-weight: ${isActive ? 600 : 500}; transition: all var(--transition-fast);"
            >
                ${tag}
            </button>
        `;
    });
    container.innerHTML = html;
}

function handleTagClick(tag) {
    selectedTag = selectedTag === tag ? '' : tag;
    page = 1;
    saveState();
    renderTagFilters();
    loadProblems();
}

// Save states to localStorage
function saveState() {
    cfStorage.setItem('cf_lib_page', page.toString());
    cfStorage.setItem('cf_lib_limit', limit.toString());
    cfStorage.setItem('cf_lib_search_query', searchQuery);
    cfStorage.setItem('cf_lib_selected_tag', selectedTag);
    cfStorage.setItem('cf_lib_min_rating', minRating);
    cfStorage.setItem('cf_lib_max_rating', maxRating);
    if (sortBy) {
        cfStorage.setItem('cf_lib_sort_by', sortBy);
    } else {
        cfStorage.removeItem('cf_lib_sort_by');
    }
    cfStorage.setItem('cf_lib_sort_order', sortOrder);
    cfStorage.setItem('cf_lib_selected_problems', JSON.stringify(selectedProblems));
}

// Sync official library
async function syncLibrary() {
    if (isSyncing) return;

    isSyncing = true;
    const btn = document.getElementById('sync-lib-btn');
    const icon = document.getElementById('sync-icon');
    const text = document.getElementById('sync-btn-text');

    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('spinner');
    if (text) text.innerText = '正在同步...';
    showToast('正在更新题库…', 'success');

    try {
        const response = await fetch('/api/problems/sync', { method: 'POST' });
        if (response.ok) {
            const data = await response.json();
            showToast(`题库同步成功！共更新了 ${data.count} 道题目。`, 'success');
            page = 1;
            saveState();
            loadProblems();
        } else {
            showToast('更新题库失败，请检查网络或稍后重试', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('更新失败，请确认本地服务正在运行', 'error');
    } finally {
        isSyncing = false;
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('spinner');
        if (text) text.innerText = '更新题库';
    }
}

// Load list
let libraryRequest = null;
async function loadProblems() {
    if (libraryRequest) libraryRequest.abort();
    const currentRequest = new AbortController();
    libraryRequest = currentRequest;
    const tbody = document.getElementById('problems-table-body');
    if (!tbody) return;
    let skeletonHtml = '';
    for(let i=0; i<10; i++) {
        skeletonHtml += `
            <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 16px; width: 40px;"><div class="skeleton-box skeleton-checkbox"></div></td>
                <td style="padding: 16px;"><div class="skeleton-box skeleton-id"></div></td>
                <td style="padding: 16px; width: 35%;"><div class="skeleton-box skeleton-title"></div></td>
                <td style="padding: 16px;"><div class="skeleton-box skeleton-rating"></div></td>
                <td style="padding: 16px;"><div class="skeleton-box skeleton-id"></div></td>
                <td style="padding: 16px;"><div class="skeleton-box skeleton-tags"></div></td>
            </tr>
        `;
    }
    tbody.innerHTML = skeletonHtml;

    // Update clear button visibility
    const clearBtn = document.getElementById('clear-filters-btn');
    if (clearBtn) {
        if (searchQuery || selectedTag || minRating || maxRating) {
            clearBtn.style.display = 'inline-block';
        } else {
            clearBtn.style.display = 'none';
        }
    }

    try {
        const queryParams = new URLSearchParams({
            page: page.toString(),
            limit: limit.toString()
        });

        if (searchQuery.trim()) queryParams.append('query', searchQuery.trim());
        if (selectedTag) queryParams.append('tag', selectedTag);
        if (minRating) queryParams.append('min_rating', minRating);
        if (maxRating) queryParams.append('max_rating', maxRating);
        if (sortBy) {
            queryParams.append('sort_by', sortBy);
            queryParams.append('sort_order', sortOrder);
        }

        const response = await fetch(`/api/problems?${queryParams.toString()}`, { signal: currentRequest.signal });
        if (response.ok) {
            const data = await response.json();
            if (currentRequest !== libraryRequest) return;
            problems = data.problems || [];
            total = data.total || 0;
            const lastPage = Math.max(1, Math.ceil(total / limit));
            if (page > lastPage) { page = lastPage; saveState(); return loadProblems(); }
            renderTable();
        } else {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || '获取题库列表失败');
        }
    } catch (e) {
        if (e.name === 'AbortError' || currentRequest !== libraryRequest) return;
        tbody.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center">${escapeHtml(e.message)} <button class="btn-secondary" onclick="loadProblems()">重试</button></td></tr>`;
        showToast(e.message || '网络错误，无法连接服务器', 'error');
    }
}

function getRatingStyle(rating) {
    if (rating === null || rating === undefined) return { bg: 'HSL(0, 0%, 94%)', text: 'HSL(0, 0%, 40%)', name: 'Unrated' };
    if (rating < 1200) return { bg: 'HSL(142, 70%, 94%)', text: 'HSL(142, 72%, 29%)', name: 'Novice' }; // Easy Green
    if (rating < 1600) return { bg: 'HSL(187, 75%, 94%)', text: 'HSL(187, 85%, 28%)', name: 'Medium' }; // Cyan
    if (rating < 1900) return { bg: 'HSL(221, 80%, 94%)', text: 'HSL(221, 83%, 45%)', name: 'Expert' }; // Blue
    if (rating < 2100) return { bg: 'HSL(280, 70%, 94%)', text: 'HSL(280, 80%, 40%)', name: 'Candidate Master' }; // Purple
    if (rating < 2400) return { bg: 'HSL(38, 92%, 94%)', text: 'HSL(38, 92%, 40%)', name: 'Master' }; // Orange
    return { bg: 'HSL(350, 80%, 94%)', text: 'HSL(350, 89%, 45%)', name: 'Grandmaster' }; // Red
}

function renderTable() {
    const tbody = document.getElementById('problems-table-body');
    if (!tbody) return;
    updateBatchControlBar();
    const master = document.getElementById('select-all-checkbox');
    if (master) master.checked = problems.length > 0 && problems.every(p => selectedProblems.some(sp => sp.id === p.id));

    if (problems.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="padding: 60px 0; text-align: center; color: var(--text-muted);">
                    没有找到符合筛选条件的题目。请尝试清空筛选条件或重新更新题库。
                </td>
            </tr>
        `;
        const paginationDiv = document.getElementById('library-pagination');
        if (paginationDiv) paginationDiv.style.display = 'none';
        return;
    }

    let html = '';
    problems.forEach(p => {
        const isSelected = selectedProblems.some(sp => sp.id === p.id);
        const ratingStyle = getRatingStyle(p.rating);

        let solvedBadge = '';
        if (p.solved_status === 'OK') {
            solvedBadge = '<i data-lucide="check-circle-2" style="width: 14px; height: 14px; color: var(--success); flex-shrink: 0;" title="已通过 (Accepted)"></i>';
        } else if (p.solved_status === 'FAILED') {
            solvedBadge = '<i data-lucide="x-circle" style="width: 14px; height: 14px; color: var(--danger); flex-shrink: 0;" title="尝试过未通过 (Attempted)"></i>';
        }

        const cacheBadge = p.is_cached
            ? `<span style="display: inline-flex; align-items: center; gap: 4px; background-color: rgba(16, 185, 129, 0.1); color: #10b981; padding: 2px 6px; border-radius: 4px; font-size: 11.5px; font-weight: 600; margin-left: 4px; cursor: default; white-space: nowrap; flex-shrink: 0;" title="已离线缓存，可秒开阅读">
                 <span style="width: 5px; height: 5px; border-radius: 50%; background-color: #10b981; display: inline-block; flex-shrink: 0;"></span>已译
               </span>`
            : '';

        const ratingHtml = p.rating !== null
            ? `<div style="display: inline-flex; align-items: center; gap: 5px; background-color: ${ratingStyle.bg}; color: ${ratingStyle.text}; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700;">
                 <i data-lucide="star" style="width: 12px; height: 12px; fill: ${ratingStyle.text}; color: ${ratingStyle.text};"></i>
                 <span>${p.rating}</span>
               </div>`
            : `<span style="font-size: 12px; color: var(--text-muted);">-</span>`;

        let tagsHtml = '';
        if (p.tags) {
            p.tags.slice(0, 3).forEach(t => {
                tagsHtml += `<span style="font-size: 11px; background-color: var(--bg-main); color: var(--text-secondary); padding: 2px 8px; border-radius: 4px; white-space: nowrap;">${escapeHtml(t)}</span>`;
            });
            if (p.tags.length > 3) {
                tagsHtml += `<span style="font-size: 10px; color: var(--text-muted); align-self: center;">+${p.tags.length - 3}</span>`;
            }
        }

        html += `
            <tr style="border-bottom: 1px solid var(--border-color); transition: background-color var(--transition-fast); background-color: ${isSelected ? 'var(--primary-light)' : 'transparent'};"
                class="contest-card-row">
                <td style="padding: 16px; width: 40px;">
                    <input
                        type="checkbox"
                        class="row-checkbox"
                        data-id="${p.id}"
                        ${isSelected ? 'checked' : ''}
                        onclick="handleRowCheckbox(this, '${p.id}')"
                        style="cursor: pointer; transform: scale(1.15);"
                    />
                </td>
                <td style="padding: 16px;">
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;">
                        ${solvedBadge}
                        <span style="font-family: var(--font-mono); font-weight: 700; font-size: 13.5px; color: var(--primary); flex-shrink: 0; white-space: nowrap;">
                            ${p.contest_id}${p.index}
                        </span>
                        ${cacheBadge}
                    </div>
                </td>
                <td style="padding: 16px;">
                    <a href="/problem/${p.contest_id}/${p.index}" style="text-decoration: none; display: block; outline: none;">
                        <span style="font-weight: 600; font-size: 14.5px; color: var(--text-primary); transition: color var(--transition-fast);"
                              onmouseover="this.style.color='var(--primary)'" onmouseout="this.style.color='var(--text-primary)'">
                            ${escapeHtml(p.name)}
                        </span>
                    </a>
                </td>
                <td style="padding: 16px;">
                    ${ratingHtml}
                </td>
                <td style="padding: 16px;">
                    <div style="display: inline-flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 13px;">
                        <i data-lucide="check-square" style="width:13px; height: 13px; color: var(--success);"></i>
                        <span>${p.solved_count.toLocaleString()} 人通过</span>
                    </div>
                </td>
                <td style="padding: 16px;">
                    <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                        ${tagsHtml}
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
    window.lucide?.createIcons?.();

    // Update select-all checkbox
    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    if (selectAllCheckbox) {
        const allChecked = problems.length > 0 && problems.every(p => selectedProblems.some(sp => sp.id === p.id));
        selectAllCheckbox.checked = allChecked;
    }

    // Render Pagination
    renderPaginationStats();
    renderPaginationButtons();
    updateBatchControlBar();
}

function renderPaginationStats() {
    const end = Math.min(page * limit, total);
    const start = total === 0 ? 0 : (page - 1) * limit + 1;
    const statsSpan = document.getElementById('pagination-stats');
    if (statsSpan) {
        statsSpan.innerHTML = `
            显示 <b>${start} - ${end}</b> 条 ，共计 <b>${total.toLocaleString()}</b> 道题
        `;
    }
}

function renderPaginationButtons() {
    const totalPages = Math.ceil(total / limit) || 1;
    const container = document.getElementById('pages-buttons-container');
    if (!container) return;

    const paginationDiv = document.getElementById('library-pagination');
    if (paginationDiv) paginationDiv.style.display = 'flex';

    let html = `
        <button class="btn-secondary" ${page <= 1 ? 'disabled' : ''} onclick="changePage(${page - 1})" style="width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-sm);">
            <i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i>
        </button>
    `;

    const pages = [1];
    const range = 2;
    if (page > range + 2) {
        pages.push('...');
    }
    for (let i = Math.max(2, page - range); i <= Math.min(totalPages - 1, page + range); i++) {
        pages.push(i);
    }
    if (page < totalPages - range - 1) {
        pages.push('...');
    }
    if (totalPages > 1) {
        pages.push(totalPages);
    }

    pages.forEach(p => {
        if (p === '...') {
            html += `<span style="color: var(--text-muted); padding: 0 2px;">...</span>`;
        } else {
            const isSelected = page === p;
            html += `
                <button onclick="changePage(${p})" style="width: 32px; height: 32px; font-size: 13px; font-weight: 600; border-radius: var(--radius-sm); border: 1px solid; border-color: ${isSelected ? 'var(--primary)' : 'var(--border-color)'}; background-color: ${isSelected ? 'var(--primary)' : 'var(--bg-sidebar)'}; color: ${isSelected ? 'white' : 'var(--text-secondary)'}; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all var(--transition-fast);">
                    ${p}
                </button>
            `;
        }
    });

    html += `
        <button class="btn-secondary" ${page >= totalPages ? 'disabled' : ''} onclick="changePage(${page + 1})" style="width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-sm);">
            <i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>
        </button>
    `;

    container.innerHTML = html;
    window.lucide?.createIcons?.();
}

function changePage(p) {
    page = p;
    saveState();
    loadProblems();
}

function handleLimitChange(val) {
    limit = parseInt(val, 10);
    page = 1;
    saveState();
    loadProblems();
}

function handleJumpPage(e) {
    e.preventDefault();
    const totalPages = Math.ceil(total / limit) || 1;
    const jumpVal = parseInt(document.getElementById('jump-page-input').value, 10);
    if (jumpVal && jumpVal >= 1 && jumpVal <= totalPages) {
        page = jumpVal;
        document.getElementById('jump-page-input').value = '';
        saveState();
        loadProblems();
    } else {
        showToast(`请输入 1 到 ${totalPages} 之间的有效页码！`, 'error');
    }
}

function handleSearchSubmit(e) {
    e.preventDefault();
    searchQuery = document.getElementById('searchQuery').value.trim();
    const direct = searchQuery.match(/^(?:https?:\/\/(?:mirror\.)?codeforces\.com\/(?:(?:contest|gym)\/(\d+)\/problem\/|problemset\/problem\/(\d+)\/))([A-Za-z][A-Za-z0-9]*)(?:[?#].*)?$/) || searchQuery.match(/^(\d+)[_\s-]*([A-Za-z][A-Za-z0-9]*)$/);
    if (direct) {
        const cid = direct.length === 4 ? (direct[1] || direct[2]) : direct[1];
        const idx = direct.length === 4 ? direct[3] : direct[2];
        window.location.href = `/problem/${cid}/${idx.toUpperCase()}`;
        return;
    }

    minRating = document.getElementById('minRating').value;
    maxRating = document.getElementById('maxRating').value;
    page = 1;
    saveState();
    loadProblems();
}

function handleClearFilters() {
    const searchInput = document.getElementById('searchQuery');
    const minRatingInput = document.getElementById('minRating');
    const maxRatingInput = document.getElementById('maxRating');

    if (searchInput) searchInput.value = '';
    if (minRatingInput) minRatingInput.value = '';
    if (maxRatingInput) maxRatingInput.value = '';

    searchQuery = '';
    minRating = '';
    maxRating = '';
    selectedTag = '';
    sortBy = null;
    page = 1;
    saveState();
    renderTagFilters();
    loadProblems();
}

function handleSortByRating() {
    if (sortBy !== 'rating') {
        sortBy = 'rating';
        sortOrder = 'asc';
    } else if (sortOrder === 'asc') {
        sortOrder = 'desc';
    } else {
        sortBy = null;
    }
    page = 1;
    saveState();

    // Update sorting indicators
    const indicator = document.getElementById('sort-indicator');
    if (indicator) {
        if (sortBy === 'rating') {
            indicator.innerText = sortOrder === 'asc' ? '🔼' : '🔽';
            indicator.style.opacity = '1';
        } else {
            indicator.innerText = '⇅';
            indicator.style.opacity = '0.3';
        }
    }

    loadProblems();
}

// Row selection checkboxes logic
function handleRowCheckbox(checkbox, pId) {
    const problem = problems.find(p => p.id === pId);
    if (!problem) return;

    if (checkbox.checked) {
        if (!selectedProblems.some(sp => sp.id === pId)) {
            selectedProblems.push(problem);
        }
    } else {
        selectedProblems = selectedProblems.filter(sp => sp.id !== pId);
    }
    saveState();

    // Toggle row highlight
    checkbox.closest('tr').style.backgroundColor = checkbox.checked ? 'var(--primary-light)' : 'transparent';
    updateBatchControlBar();
}

function toggleSelectAll(checkbox) {
    problems.forEach(p => {
        const isSelected = selectedProblems.some(sp => sp.id === p.id);
        if (checkbox.checked) {
            if (!isSelected) {
                selectedProblems.push(p);
            }
        } else {
            selectedProblems = selectedProblems.filter(sp => sp.id !== p.id);
        }
    });
    saveState();
    loadProblems(); // Rerender to refresh all checkboxes
}

function clearSelection() {
    selectedProblems = [];
    saveState();
    loadProblems();
}

function updateBatchControlBar() {
    const count = document.getElementById('selected-count');
    const countVal = selectedProblems.length;
    if (count) count.innerText = countVal;

    const btn = document.getElementById('batch-submit-btn');
    if (btn) {
        btn.disabled = (countVal === 0);
        btn.style.opacity = (countVal === 0) ? '0.5' : '1';
        btn.style.cursor = (countVal === 0) ? 'not-allowed' : 'pointer';
    }
}

// Trigger batch translation queue (delegated to core app.js)
async function startBatchTranslation() {
    const list = [...selectedProblems];
    const started = await triggerBatchTranslation(list);
    if (started) {
        selectedProblems = [];
        saveState();
        loadProblems();
    } else {
        updateBatchControlBar();
    }
}



// Initialize on execution
initInputs();
renderTagFilters();
loadProblems();
