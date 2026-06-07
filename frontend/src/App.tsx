import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LayoutDashboard, Languages, Settings, GraduationCap, X, AlertCircle, History } from 'lucide-react';
import { Dashboard } from './Dashboard';
import { ProblemsetLibrary } from './ProblemsetLibrary';
import type { Problem } from './ProblemsetLibrary';
import { ProblemViewer } from './ProblemViewer';
import type { ProblemData } from './ProblemViewer';
import { AdminSettings } from './AdminSettings';
import { CachedProblems } from './CachedProblems';
import { API_BASE } from './api';

type Tab = 'dashboard' | 'problemset' | 'problem' | 'settings' | 'cached';

interface Toast {
  message: string;
  type: 'success' | 'error';
  id: number;
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const val = localStorage.getItem('cf_active_tab') as Tab;
    if (['dashboard', 'problemset', 'problem', 'settings', 'cached'].includes(val)) {
      return val;
    }
    return 'problemset';
  });
  const [currentProblem, setCurrentProblem] = useState<ProblemData | null>(() => {
    const val = localStorage.getItem('cf_current_problem');
    try {
      return val ? JSON.parse(val) as ProblemData : null;
    } catch {
      return null;
    }
  });
  const [isLoadingProblem, setIsLoadingProblem] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [acSyncStatus, setAcSyncStatus] = useState<{
    handle: string;
    syncing: boolean;
    last_fetched: number;
    problem_count: number;
    record_count?: number;
    accepted_count?: number;
    failed_count?: number;
    last_error?: string | null;
    status?: string;
  } | null>(null);
  const [acSyncTrigger, setAcSyncTrigger] = useState(0);

  const lastSyncSignatureRef = useRef<string>('');
  const isSyncActiveRef = useRef<boolean>(false);

  // Function to display global Toast notifications
  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { message, type, id }]);

    // Automatically clear toast after 3.5 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const showSyncOutcomeToast = useCallback((status: {
    last_error?: string | null;
    record_count?: number;
    accepted_count?: number;
    failed_count?: number;
    problem_count: number;
  }) => {
    const accepted = status.accepted_count || 0;
    const failed = status.failed_count || 0;
    const record = status.record_count || 0;
    if (status.last_error) {
      showToast(`❌ 做题状态同步失败: ${status.last_error}`, 'error');
    } else if (record === 0) {
      showToast('Codeforces 做题状态同步完成，暂无记录。', 'success');
    } else {
      showToast(`🎉 做题状态同步完成！(AC ${accepted} 题 / 尝试未过 ${failed} 题 / 共 ${record} 条记录)`, 'success');
    }
  }, [showToast]);

  // Batch translation queue state (lifted up for persistence across unmounts)
  const [batchQueue, setBatchQueue] = useState<{
    isActive: boolean;
    total: number;
    currentIndex: number;
    currentProblemId: string | null;
    statusText: string;
    timerCountdown: number;
  }>({
    isActive: false,
    total: 0,
    currentIndex: 0,
    currentProblemId: null,
    statusText: '',
    timerCountdown: 0
  });

  const cancelBatchRef = useRef(false);

  // Start the background batch translation loop
  const handleStartBatchTranslation = async (selectedProblems: Problem[]) => {
    cancelBatchRef.current = false;
    setBatchQueue({
      isActive: true,
      total: selectedProblems.length,
      currentIndex: 0,
      currentProblemId: null,
      statusText: '正在准备批量翻译...',
      timerCountdown: 0
    });

    showToast(`已启动批量翻译队列，共 ${selectedProblems.length} 道题目...`, 'success');

    let mockCount = 0;
    let failedCount = 0;
    let cachedOrTranslatedCount = 0;

    for (let i = 0; i < selectedProblems.length; i++) {
      if (cancelBatchRef.current) {
        break;
      }

      const p = selectedProblems[i];
      setBatchQueue(prev => ({
        ...prev,
        currentIndex: i + 1,
        currentProblemId: p.id,
        statusText: `正在抓取并翻译第 ${i + 1}/${selectedProblems.length} 道题: ${p.contest_id}${p.index}...`
      }));
      let isCached = p.is_cached || false;

      if (isCached) {
        console.log(`Problem ${p.contest_id}${p.index} is already cached (precheck). Skipping translation and delay.`);
        cachedOrTranslatedCount++;
        setBatchQueue(prev => ({
          ...prev,
          currentIndex: i + 1,
          currentProblemId: p.id,
          statusText: `已检测到本地缓存：自动跳过并加速下一题 ${p.contest_id}${p.index}...`
        }));
        // Small delay just to let the user see the progress bar/text animate smoothly (e.g. 150ms)
        await new Promise(resolve => setTimeout(resolve, 150));
      } else {
        try {
          // Trigger scraping and translation on the backend by hitting the GET endpoint
          const response = await fetch(`${API_BASE}/api/problem/${p.contest_id}/${p.index}`);
          if (!response.ok) {
            throw new Error('翻译接口返回异常');
          }

          const data = await response.json();
          // Check if the source is served from local cache
          if (data.source === 'cache') {
            isCached = true;
            cachedOrTranslatedCount++;
            console.log(`Problem ${p.contest_id}${p.index} loaded from cache. Skipping delay.`);
          } else if (data.source === 'mock') {
            mockCount++;
            console.log(`Problem ${p.contest_id}${p.index} returned mock translation (not cached).`);
          } else {
            cachedOrTranslatedCount++;
            console.log(`Problem ${p.contest_id}${p.index} translated and cached successfully.`);
          }
        } catch (err) {
          console.error(`Batch translation failed for ${p.contest_id}${p.index}:`, err);
          failedCount++;
          showToast(`题目 ${p.contest_id}${p.index} 预翻译失败，已跳过。`, 'error');
        }
      }

      // If there are more problems, start a 60-second countdown (only if it wasn't cached)
      if (i < selectedProblems.length - 1) {
        if (cancelBatchRef.current) break;

        if (isCached) {
          // If the problem was already cached, skip delay and jump directly to the next one!
          continue;
        }

        let secondsLeft = 60;
        setBatchQueue(prev => ({
          ...prev,
          currentProblemId: null,
          statusText: `第 ${i + 1}/${selectedProblems.length} 道已成功预热！安全防风控冷却中...`,
          timerCountdown: secondsLeft
        }));

        const intervalId = setInterval(() => {
          secondsLeft--;
          setBatchQueue(prev => {
            if (prev.timerCountdown <= 1 || cancelBatchRef.current) {
              clearInterval(intervalId);
            }
            return {
              ...prev,
              timerCountdown: Math.max(0, secondsLeft)
            };
          });
        }, 1000);

        // Sleep for 60 seconds (checking cancel status every 1 second for instant abort)
        for (let s = 0; s < 60; s++) {
          if (cancelBatchRef.current) {
            clearInterval(intervalId);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        clearInterval(intervalId);
      }
    }

    // Done
    if (!cancelBatchRef.current) {
      if (mockCount > 0 || failedCount > 0) {
        showToast(
          `批量预热完成：${cachedOrTranslatedCount} 道已缓存/翻译，${mockCount} 道为模拟翻译未缓存，${failedCount} 道失败。`,
          mockCount || failedCount ? 'error' : 'success'
        );
      } else {
        showToast(`🎉 批量预翻译任务已全部圆满完成，已选题目已被本地离线缓存。`, 'success');
      }
    } else {
      showToast('批量翻译任务已手动取消。', 'error');
    }

    setBatchQueue({
      isActive: false,
      total: 0,
      currentIndex: 0,
      currentProblemId: null,
      statusText: '',
      timerCountdown: 0
    });
  };

  const handleCancelBatchTranslation = () => {
    cancelBatchRef.current = true;
    setBatchQueue(prev => ({
      ...prev,
      statusText: '正在终止任务并清理队列...',
      timerCountdown: 0
    }));
  };

  const fetchAcSyncStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/user/status-sync`);
      if (response.ok) {
        const data = await response.json();
        setAcSyncStatus(data);
        if (data) {
          const sig = `${data.handle}:${data.last_fetched}:${data.status}:${data.record_count || 0}:${data.accepted_count || 0}:${data.failed_count || 0}:${data.last_error || ''}`;

          if (data.syncing) {
            isSyncActiveRef.current = true;
          }

          if (!data.syncing && isSyncActiveRef.current) {
            isSyncActiveRef.current = false;
            showSyncOutcomeToast(data);
          }

          if (!data.syncing && data.last_fetched > 0 && lastSyncSignatureRef.current && lastSyncSignatureRef.current !== sig) {
            console.log(`Sync signature changed from "${lastSyncSignatureRef.current}" to "${sig}". Triggering page refresh.`);
            setAcSyncTrigger(prev => prev + 1);
          }

          lastSyncSignatureRef.current = sig;
        }
        return data;
      }
    } catch (e) {
      console.error('Failed to fetch AC sync status:', e);
    }
    return null;
  }, [showSyncOutcomeToast]);

  const handleTriggerAcSync = async () => {
    if (acSyncStatus?.syncing) return;
    try {
      const response = await fetch(`${API_BASE}/api/user/status-sync`, { method: 'POST' });
      if (response.ok) {
        showToast('正在后台向 Codeforces 同步您的做题数据，请稍候...', 'success');
        isSyncActiveRef.current = true;
        setAcSyncStatus(prev => prev ? { ...prev, syncing: true } : { handle: '', syncing: true, last_fetched: 0, problem_count: 0 });
        let attempts = 0;
        const intervalId = window.setInterval(async () => {
          attempts++;
          const nextStatus = await fetchAcSyncStatus();
          if ((nextStatus && !nextStatus.syncing) || attempts > 30) {
            clearInterval(intervalId);
          }
        }, 2000);
      } else {
        const err = await response.json();
        showToast(err.detail || '启动状态同步失败', 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('网络错误，启动状态同步失败', 'error');
    }
  };

  useEffect(() => {
    let intervalId: number | undefined;

    const checkStatus = async () => {
      const status = await fetchAcSyncStatus();
      if (status && status.syncing) {
        if (!intervalId) {
          intervalId = window.setInterval(async () => {
            const nextStatus = await fetchAcSyncStatus();
            if (nextStatus && !nextStatus.syncing) {
              if (intervalId) {
                clearInterval(intervalId);
                intervalId = undefined;
              }
            }
          }, 2000);
        }
      }
    };

    checkStatus();

    const slowInterval = window.setInterval(checkStatus, 30000);

    return () => {
      if (intervalId) clearInterval(intervalId);
      clearInterval(slowInterval);
    };
  }, [fetchAcSyncStatus]);

  // Synchronize tab and problem states to localStorage
  React.useEffect(() => {
    localStorage.setItem('cf_active_tab', activeTab);
  }, [activeTab]);

  React.useEffect(() => {
    if (currentProblem) {
      localStorage.setItem('cf_current_problem', JSON.stringify(currentProblem));
    } else {
      localStorage.removeItem('cf_current_problem');
    }
  }, [currentProblem]);



  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Fetches a Codeforces problem by contest ID and index
  const handleFetchProblem = async (contestId: number, index: string, force: boolean = false) => {
    setIsLoadingProblem(true);
    setActiveTab('problem'); // Switch to reader view immediately
    setCurrentProblem(null); // Clear previous problem

    try {
      const response = await fetch(
        `${API_BASE}/api/problem/${contestId}/${index}?force_refresh=${force}`
      );
      if (response.ok) {
        const data = await response.json();
        setCurrentProblem(data);
        showToast(`成功获取并翻译题目: ${contestId}${index}！`, 'success');
      } else {
        const err = await response.json();
        showToast(err.detail || '获取题目失败，请核对编号。', 'error');
        setActiveTab('problemset'); // Fallback to problemset
      }
    } catch (error) {
      console.error(error);
      showToast('网络错误，无法连接本地翻译服务器，请先启动 backend。', 'error');
      setActiveTab('problemset');
    } finally {
      setIsLoadingProblem(false);
    }
  };

  const handleRefreshCurrentProblem = (newData?: ProblemData) => {
    if (newData) {
      setCurrentProblem(newData);
    } else if (currentProblem) {
      handleFetchProblem(currentProblem.contest_id, currentProblem.index, false);
    }
  };

  return (
    <div className="app-container">
      {/* 1. Top Navigation Bar */}
      <header className="top-navbar">
        <div className="brand">
          <div className="brand-icon">CF</div>
          <div>
            <span className="brand-name">CF 中文镜像站</span>
            <span className="brand-subtitle">AI Smart Mirror</span>
          </div>
        </div>

        <ul className="nav-list">
          <li
            className={`nav-item ${activeTab === 'problemset' ? 'active' : ''}`}
            onClick={() => setActiveTab('problemset')}
          >
            <GraduationCap size={16} />
            <span>官方题库列表</span>
          </li>
          <li
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={16} />
            <span>官方比赛</span>
          </li>
          <li
            className={`nav-item ${activeTab === 'cached' ? 'active' : ''}`}
            onClick={() => setActiveTab('cached')}
          >
            <History size={16} />
            <span>本地已译题目</span>
          </li>
          <li
            className={`nav-item ${activeTab === 'problem' ? 'active' : ''}`}
            onClick={() => {
              if (currentProblem) {
                setActiveTab('problem');
              } else {
                showToast('请先在比赛或题库中选择并翻译一道题目！', 'error');
              }
            }}
          >
            <Languages size={16} />
            <span>在线翻译阅读</span>
          </li>
          <li
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={16} />
            <span>管理后台 (设置)</span>
          </li>
        </ul>

        <div className="navbar-right">
          {batchQueue.isActive && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                backgroundColor: 'var(--primary-light, rgba(59, 130, 246, 0.08))',
                color: 'var(--primary)',
                padding: '5px 12px',
                borderRadius: '20px',
                border: '1px solid rgba(59, 130, 246, 0.15)',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'default'
              }}
              title={batchQueue.statusText}
            >
              <div className="spinner" style={{ width: '12px', height: '12px', borderWidth: '2px', borderTopColor: 'var(--primary)', animationDuration: '0.8s', flexShrink: 0 }}></div>
              <span style={{ whiteSpace: 'nowrap' }}>预热进度: {batchQueue.currentIndex}/{batchQueue.total}</span>
              {batchQueue.timerCountdown > 0 && (
                <span style={{ fontSize: '11.5px', opacity: 0.8, color: '#3b82f6', fontWeight: 700, whiteSpace: 'nowrap' }}>⏱️ {batchQueue.timerCountdown}s</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); handleCancelBatchTranslation(); }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#ef4444',
                  cursor: 'pointer',
                  fontSize: '11.5px',
                  fontWeight: 700,
                  marginLeft: '6px',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(239, 68, 68, 0.08)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0
                }}
                title="取消任务"
              >
                取消
              </button>
            </div>
          )}
          {acSyncStatus && acSyncStatus.handle && (
            <div
              onClick={handleTriggerAcSync}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                backgroundColor: acSyncStatus.syncing
                  ? 'var(--warning-bg, rgba(245, 158, 11, 0.08))'
                  : acSyncStatus.last_error
                    ? 'rgba(239, 68, 68, 0.08)'
                    : 'var(--success-bg, rgba(16, 185, 129, 0.08))',
                color: acSyncStatus.syncing
                  ? 'var(--warning, #f59e0b)'
                  : acSyncStatus.last_error
                    ? '#ef4444'
                    : 'var(--success, #10b981)',
                padding: '5px 12px',
                borderRadius: '20px',
                border: acSyncStatus.syncing
                  ? '1px solid rgba(245, 158, 11, 0.15)'
                  : acSyncStatus.last_error
                    ? '1px solid rgba(239, 68, 68, 0.15)'
                    : '1px solid rgba(16, 185, 129, 0.15)',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: acSyncStatus.syncing ? 'default' : 'pointer',
                transition: 'all var(--transition-fast)',
                userSelect: 'none'
              }}
              title={acSyncStatus.syncing
                ? '做题状态同步中...'
                : acSyncStatus.last_error
                  ? `同步失败: ${acSyncStatus.last_error}。点击可重试同步。`
                  : `最近同步时间: ${acSyncStatus.last_fetched > 0 ? new Date(acSyncStatus.last_fetched * 1000).toLocaleTimeString() : '无'}。点击可重新同步。`}
            >
              {acSyncStatus.syncing ? (
                <>
                  <div className="spinner" style={{ width: '12px', height: '12px', borderWidth: '2px', borderTopColor: 'var(--warning, #f59e0b)', animationDuration: '0.8s', flexShrink: 0 }}></div>
                  <span>AC 同步中...</span>
                </>
              ) : acSyncStatus.last_error ? (
                <>
                  <span style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: '#ef4444', borderRadius: '50%' }}></span>
                  <span>同步失败: {acSyncStatus.handle}</span>
                  <span style={{ fontSize: '10px', opacity: 0.8 }}>🔄</span>
                </>
              ) : (
                <>
                  <span style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: 'var(--success, #10b981)', borderRadius: '50%' }}></span>
                  <span>做题状态已同步: {acSyncStatus.handle} (AC {acSyncStatus.accepted_count || 0} / 尝试未过 {acSyncStatus.failed_count || 0} / 共 {acSyncStatus.record_count || 0} 条记录)</span>
                  <span style={{ fontSize: '10px', opacity: 0.8 }}>🔄</span>
                </>
              )}
            </div>
          )}
          <div className="status-indicator">
            <span className="status-dot"></span>
            <span>本地镜像站已激活</span>
          </div>
        </div>
      </header>

      {/* 2. Main Content Window */}
      <main className="main-content">
        {/* Loading Spinner */}
        {isLoadingProblem && (
          <div className="loading-container">
            <div className="spinner"></div>
            <div style={{ textAlign: 'center' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>正在为您智能爬取并翻译题面...</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                Codeforces API 响应中，正在运用 AI 保护 LaTeX 公式，确保排版完美。
              </p>
            </div>
          </div>
        )}

        {/* Tab Routing */}
        {!isLoadingProblem && activeTab === 'dashboard' && (
          <Dashboard onSearchProblem={handleFetchProblem} onShowToast={showToast} acSyncTrigger={acSyncTrigger} />
        )}

        {!isLoadingProblem && activeTab === 'problemset' && (
          <ProblemsetLibrary
            onSelectProblem={handleFetchProblem}
            onShowToast={showToast}
            batchQueue={batchQueue}
            onStartBatch={handleStartBatchTranslation}
            acSyncTrigger={acSyncTrigger}
          />
        )}

        {!isLoadingProblem && activeTab === 'cached' && (
          <CachedProblems onSelectProblem={handleFetchProblem} onShowToast={showToast} acSyncTrigger={acSyncTrigger} />
        )}

        {!isLoadingProblem && activeTab === 'problem' && currentProblem && (
          <ProblemViewer
            problemData={currentProblem}
            onRefresh={handleRefreshCurrentProblem}
            onShowToast={showToast}
          />
        )}

        {!isLoadingProblem && activeTab === 'settings' && (
          <AdminSettings onShowToast={showToast} onUserConfigSaved={handleTriggerAcSync} />
        )}
      </main>

      {/* 3. Toast Notification Overlay */}
      <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 100, display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <AlertCircle size={18} />
            <span>{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', marginLeft: '8px' }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>


    </div>
  );
};
