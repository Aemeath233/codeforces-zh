import React, { useState } from 'react';
import { LayoutDashboard, Languages, Settings, GraduationCap, X, AlertCircle, History } from 'lucide-react';
import { Dashboard } from './Dashboard';
import { ProblemsetLibrary } from './ProblemsetLibrary';
import { ProblemViewer } from './ProblemViewer';
import { AdminSettings } from './AdminSettings';
import { CachedProblems } from './CachedProblems';

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
  const [currentProblem, setCurrentProblem] = useState<any>(() => {
    const val = localStorage.getItem('cf_current_problem');
    try {
      return val ? JSON.parse(val) : null;
    } catch (e) {
      return null;
    }
  });
  const [isLoadingProblem, setIsLoadingProblem] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

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

  const cancelBatchRef = React.useRef(false);

  // Start the background batch translation loop
  const handleStartBatchTranslation = async (selectedProblems: any[]) => {
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

      let isCached = false;
      try {
        // Trigger scraping and translation on the backend by hitting the GET endpoint
        const response = await fetch(`http://localhost:8000/api/problem/${p.contest_id}/${p.index}`);
        if (!response.ok) {
          throw new Error('翻译接口返回异常');
        }
        
        const data = await response.json();
        // Check if the source is served from local cache
        if (data.source === 'cache') {
          isCached = true;
          console.log(`Problem ${p.contest_id}${p.index} loaded from cache. Skipping delay.`);
        }
      } catch (err) {
        console.error(`Batch translation failed for ${p.contest_id}${p.index}:`, err);
        showToast(`题目 ${p.contest_id}${p.index} 预翻译失败，已跳过。`, 'error');
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
      showToast(`🎉 批量预翻译任务已全部圆满完成！已选题目已被本地离线缓存。`, 'success');
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

  // Function to display global Toast notifications
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { message, type, id }]);
    
    // Automatically clear toast after 3.5 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  };

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
        `http://localhost:8000/api/problem/${contestId}/${index}?force_refresh=${force}`
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

  const handleRefreshCurrentProblem = () => {
    if (currentProblem) {
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
          <Dashboard onSearchProblem={handleFetchProblem} onShowToast={showToast} />
        )}

        {!isLoadingProblem && activeTab === 'problemset' && (
          <ProblemsetLibrary 
            onSelectProblem={handleFetchProblem} 
            onShowToast={showToast} 
            batchQueue={batchQueue}
            onStartBatch={handleStartBatchTranslation}
            onCancelBatch={handleCancelBatchTranslation}
          />
        )}

        {!isLoadingProblem && activeTab === 'cached' && (
          <CachedProblems onSelectProblem={handleFetchProblem} onShowToast={showToast} />
        )}

        {!isLoadingProblem && activeTab === 'problem' && currentProblem && (
          <ProblemViewer
            problemData={currentProblem}
            onRefresh={handleRefreshCurrentProblem}
            onShowToast={showToast}
          />
        )}

        {!isLoadingProblem && activeTab === 'settings' && (
          <AdminSettings onShowToast={showToast} />
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

      {/* 4. Global Floating Batch Queue Progress Widget */}
      {batchQueue.isActive && activeTab !== 'problemset' && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          left: '24px',
          zIndex: 99,
          width: '320px',
          padding: '16px',
          backgroundColor: 'rgba(255, 255, 255, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--border-color)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-premium)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          animation: 'scaleIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px' }}></div>
              <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--primary)' }}>
                批量预热翻译中 ({batchQueue.currentIndex}/{batchQueue.total})
              </span>
            </div>
            <button
              onClick={handleCancelBatchTranslation}
              className="btn-secondary"
              style={{
                padding: '2px 6px',
                fontSize: '11px',
                color: 'var(--danger)',
                borderColor: 'HSL(350, 89%, 90%)',
                backgroundColor: 'white',
                fontWeight: 600
              }}
            >
              取消
            </button>
          </div>

          <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {batchQueue.statusText}
          </div>

          {/* Progress Bar */}
          <div style={{
            width: '100%',
            height: '4px',
            backgroundColor: 'var(--border-color)',
            borderRadius: '2px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${(batchQueue.currentIndex / batchQueue.total) * 100}%`,
              height: '100%',
              backgroundColor: 'var(--primary)',
              transition: 'width 0.4s ease'
            }}></div>
          </div>

          {batchQueue.timerCountdown > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 600 }}>
              ⏱️ 安全冷却倒计时: {batchQueue.timerCountdown} 秒下一题...
            </div>
          )}
        </div>
      )}
    </div>
  );
};
