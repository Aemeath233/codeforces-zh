import React, { useState, useEffect } from 'react';
import { Search, Award, X, RefreshCw } from 'lucide-react';

interface Contest {
  id: number;
  name: string;
  type: string;
  phase: string;
  durationSeconds: number;
  startTimeSeconds?: number;
}

interface DashboardProps {
  onSearchProblem: (contestId: number, index: string) => void;
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ onSearchProblem, onShowToast }) => {
  const [contests, setContests] = useState<Contest[]>([]);
  const [isLoadingContests, setIsLoadingContests] = useState(false);

  // Contest search, filter and pagination states
  const [contestSearch, setContestSearch] = useState('');
  const [selectedDiv, setSelectedDiv] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;

  // Contest detail modal states
  const [selectedContest, setSelectedContest] = useState<Contest | null>(null);
  const [contestProblems, setContestProblems] = useState<any[]>([]);
  const [isLoadingProblems, setIsLoadingProblems] = useState(false);

  useEffect(() => {
    fetchContests();
  }, []);

  useEffect(() => {
    setCurrentPage(1);
  }, [contestSearch, selectedDiv]);

  const fetchContests = async () => {
    setIsLoadingContests(true);
    try {
      const response = await fetch('http://localhost:8000/api/contests');
      if (response.ok) {
        const data = await response.json();
        const upcoming = data.upcoming || [];
        const recent = data.recent || [];
        setContests([...upcoming, ...recent]);
      } else {
        onShowToast('拉取 Codeforces 比赛列表失败', 'error');
      }
    } catch (error) {
      console.error(error);
      onShowToast('无法连接本地后端，比赛列表加载失败', 'error');
    } finally {
      setIsLoadingContests(false);
    }
  };


  const fetchContestProblems = async (contestId: number) => {
    setIsLoadingProblems(true);
    setContestProblems([]);
    try {
      const response = await fetch(`http://localhost:8000/api/contest/${contestId}/problems`);
      if (response.ok) {
        const data = await response.json();
        setContestProblems(data.problems || []);
      } else {
        onShowToast('获取比赛题目列表失败，请稍后重试', 'error');
        setSelectedContest(null);
      }
    } catch (error) {
      console.error(error);
      onShowToast('网络错误，无法连接本地服务器，请先启动 backend', 'error');
      setSelectedContest(null);
    } finally {
      setIsLoadingProblems(false);
    }
  };

  const handleContestClick = (contest: Contest) => {
    if (contest.phase === 'BEFORE') {
      onShowToast('💡 提示：该比赛尚未开始，Codeforces 官方尚未公开题目列表，请在比赛开始后再来查看哦！', 'error');
      return;
    }
    setSelectedContest(contest);
    fetchContestProblems(contest.id);
  };

  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '未定';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}小时${minutes > 0 ? ` ${minutes}分钟` : ''}`;
  };

  // Filter contests based on search term and selected Div
  const filteredContests = contests.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(contestSearch.toLowerCase()) ||
                          c.id.toString().includes(contestSearch);
    if (!matchesSearch) return false;

    if (selectedDiv !== 'all') {
      const regex = new RegExp(`div\\.?\\s*${selectedDiv}\\b`, 'i');
      return regex.test(c.name);
    }
    return true;
  });

  // Calculate pagination values
  const totalPages = Math.ceil(filteredContests.length / itemsPerPage);
  const paginatedContests = filteredContests.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Codeforces 官方比赛大厅 (Contests)</h1>
        <p className="page-subtitle">同步官方实时比赛列表，点击比赛即可浏览并智能翻译全部题目。</p>
      </div>

      {/* Unified Contest List Panel */}
      <div className="contest-panel">
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Award size={20} style={{ color: 'var(--primary)' }} />
          <span>Codeforces 官方比赛大厅 (Contests)</span>
        </div>

        {/* Contest Search & Filter Toolbar */}
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          backgroundColor: 'var(--bg-main)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '8px'
        }}>
          {/* Contest Search Input */}
          <div style={{ position: 'relative', flexGrow: 1, minWidth: '240px' }}>
            <Search size={16} style={{
              position: 'absolute',
              left: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-secondary)'
            }} />
            <input
              type="text"
              placeholder="搜索比赛名称或 ID..."
              value={contestSearch}
              onChange={(e) => setContestSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px 8px 36px',
                fontSize: '14px',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--bg-sidebar)',
                outline: 'none',
                color: 'var(--text-primary)',
                transition: 'border-color var(--transition-fast)'
              }}
              onFocus={(e) => e.target.style.borderColor = 'var(--primary)'}
              onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
            />
          </div>

          {/* Div Filter Tags */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {['all', '1', '2', '3', '4'].map((div) => {
              const isSelected = selectedDiv === div;
              const label = div === 'all' ? '全部' : `Div. ${div}`;
              return (
                <button
                  key={div}
                  onClick={() => setSelectedDiv(div)}
                  style={{
                    padding: '6px 14px',
                    fontSize: '13px',
                    fontWeight: 600,
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid',
                    borderColor: isSelected ? 'var(--primary)' : 'var(--border-color)',
                    backgroundColor: isSelected ? 'var(--primary-light)' : 'var(--bg-sidebar)',
                    color: isSelected ? 'var(--primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        
        <div className="contest-list" style={{ maxHeight: '600px', overflowY: 'auto' }}>
          {isLoadingContests ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <RefreshCw size={24} className="spinner" style={{ color: 'var(--primary)', marginBottom: '8px' }} />
              <div>正在同步 Codeforces 比赛大厅...</div>
            </div>
          ) : paginatedContests.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
              未找到匹配的比赛
            </div>
          ) : (
            paginatedContests.map((c) => {
              let statusText = '已结束';
              let statusClass = 'status-finished';
              if (c.phase === 'CODING') {
                statusText = '进行中';
                statusClass = 'status-coding';
              } else if (c.phase === 'BEFORE') {
                statusText = '即将开始';
                statusClass = 'status-before';
              }
              
              return (
                <div key={c.id} className="contest-card" onClick={() => handleContestClick(c)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="contest-info">
                    <span className="contest-name">{c.name}</span>
                    <div className="contest-meta">
                      <span>ID: {c.id}</span>
                      {c.startTimeSeconds && (
                        <span>开始时间: {formatTime(c.startTimeSeconds)}</span>
                      )}
                      <span>时长: {formatDuration(c.durationSeconds)}</span>
                    </div>
                  </div>
                  <span className={`contest-status-badge ${statusClass}`}>
                    {statusText}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Beautiful Pagination Controls */}
        {totalPages > 1 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            marginTop: '16px',
            paddingTop: '16px',
            borderTop: '1px solid var(--border-color)'
          }}>
            {/* Prev Button */}
            <button
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              style={{
                padding: '6px 12px',
                fontSize: '13px',
                fontWeight: 600,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-sidebar)',
                color: currentPage === 1 ? 'var(--text-muted)' : 'var(--text-secondary)',
                cursor: currentPage === 1 ? 'default' : 'pointer',
                opacity: currentPage === 1 ? 0.5 : 1,
                transition: 'all var(--transition-fast)'
              }}
            >
              上一页
            </button>

            {/* Page numbers list */}
            {(() => {
              const pages = [];
              const range = 2; // how many pages to show around current page
              
              // Always show first page
              pages.push(1);
              
              if (currentPage > range + 2) {
                pages.push('...1');
              }
              
              for (let i = Math.max(2, currentPage - range); i <= Math.min(totalPages - 1, currentPage + range); i++) {
                pages.push(i);
              }
              
              if (currentPage < totalPages - range - 1) {
                pages.push('...2');
              }
              
              // Always show last page (if totalPages > 1)
              if (totalPages > 1) {
                pages.push(totalPages);
              }

              return pages.map((page, idx) => {
                if (typeof page === 'string') {
                  return <span key={`ellipsis-${idx}`} style={{ color: 'var(--text-muted)', padding: '0 4px' }}>...</span>;
                }
                const isSelected = currentPage === page;
                return (
                  <button
                    key={`page-${page}`}
                    onClick={() => setCurrentPage(page)}
                    style={{
                      width: '32px',
                      height: '32px',
                      fontSize: '13px',
                      fontWeight: 600,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid',
                      borderColor: isSelected ? 'var(--primary)' : 'var(--border-color)',
                      backgroundColor: isSelected ? 'var(--primary)' : 'var(--bg-sidebar)',
                      color: isSelected ? 'white' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'all var(--transition-fast)'
                    }}
                  >
                    {page}
                  </button>
                );
              });
            })()}

            {/* Next Button */}
            <button
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              style={{
                padding: '6px 12px',
                fontSize: '13px',
                fontWeight: 600,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-sidebar)',
                color: currentPage === totalPages ? 'var(--text-muted)' : 'var(--text-secondary)',
                cursor: currentPage === totalPages ? 'default' : 'pointer',
                opacity: currentPage === totalPages ? 0.5 : 1,
                transition: 'all var(--transition-fast)'
              }}
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* Contest Details Modal Overlay */}
      {selectedContest && (
        <div className="modal-overlay" onClick={() => setSelectedContest(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-wrapper">
                <span className="modal-title">{selectedContest.name}</span>
                <span className="modal-subtitle">比赛 ID: #{selectedContest.id} · 请选择要翻译阅读的题目</span>
              </div>
              <button className="modal-close-btn" onClick={() => setSelectedContest(null)}>
                <X size={18} />
              </button>
            </div>
            
            <div className="modal-body">
              {isLoadingProblems ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '16px' }}>
                  <RefreshCw size={36} className="spinner" style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>正在同步该比赛的题目列表，请稍候...</span>
                </div>
              ) : contestProblems.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                  未获取到该比赛的题目列表
                </div>
              ) : (
                <div className="problems-grid">
                  {contestProblems.map((p) => {
                    let ratingClass = '';
                    if (p.rating) {
                      if (p.rating < 1200) ratingClass = 'rating-easy';
                      else if (p.rating < 1900) ratingClass = 'rating-medium';
                      else ratingClass = 'rating-hard';
                    }
                    
                    return (
                      <div
                        key={p.index}
                        className="problem-item-card"
                        onClick={() => {
                          setSelectedContest(null);
                          onSearchProblem(p.contest_id, p.index);
                        }}
                      >
                        <div className="problem-left">
                          {p.solved_status === 'OK' && (
                            <span title="已通过 (Accepted)" style={{ fontSize: '14px', marginRight: '4px', display: 'inline-flex', alignItems: 'center' }}>✅</span>
                          )}
                          {p.solved_status === 'FAILED' && (
                            <span title="尝试过未通过 (Attempted)" style={{ fontSize: '14px', marginRight: '4px', display: 'inline-flex', alignItems: 'center' }}>❌</span>
                          )}
                          <div className="problem-badge-index">{p.index}</div>
                          <div className="problem-meta-info">
                            <span className="problem-title-name">{p.name}</span>
                            <div className="problem-tags-row">
                              {p.tags && p.tags.slice(0, 3).map((tag: string) => (
                                <span key={tag} className="problem-tag-mini">{tag}</span>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="problem-right">
                          {p.rating ? (
                            <span className={`problem-rating-tag ${ratingClass}`}>
                              ★ {p.rating}
                            </span>
                          ) : (
                            <span className="problem-rating-tag" style={{ backgroundColor: 'var(--border-hover)', color: 'var(--text-secondary)' }}>
                              无评分
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
