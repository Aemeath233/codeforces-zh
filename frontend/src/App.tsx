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
          <ProblemsetLibrary onSelectProblem={handleFetchProblem} onShowToast={showToast} />
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
    </div>
  );
};
