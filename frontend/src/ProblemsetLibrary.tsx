import React, { useState, useEffect } from 'react';
import { Search, Hash, Star, CheckSquare, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';

interface Problem {
  id: string;
  contest_id: number;
  index: string;
  name: string;
  rating: number | null;
  solved_count: number;
  tags: string[];
  solved_status?: 'OK' | 'FAILED' | 'NONE';
  is_cached?: boolean;
}

interface ProblemsetLibraryProps {
  onSelectProblem: (contestId: number, index: string) => void;
  onShowToast: (message: string, type: 'success' | 'error') => void;
  batchQueue: {
    isActive: boolean;
    total: number;
    currentIndex: number;
    currentProblemId: string | null;
    statusText: string;
    timerCountdown: number;
  };
  onStartBatch: (selectedProblems: any[]) => Promise<void>;
}

// Curated list of popular Codeforces tags for the selector
const POPULAR_TAGS = [
  "implementation", "math", "greedy", "dp", "data structures", 
  "brute force", "constructive algorithms", "graphs", "sortings", 
  "binary search", "dfs and similar", "trees", "strings", 
  "number theory", "combinatorics", "two pointers", "geometry", 
  "bitmasks", "dsu", "shortest paths", "probabilities"
];

export const ProblemsetLibrary: React.FC<ProblemsetLibraryProps> = ({ 
  onSelectProblem, 
  onShowToast,
  batchQueue,
  onStartBatch
}) => {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState<number>(() => {
    const val = localStorage.getItem('cf_lib_page');
    return val ? parseInt(val, 10) : 1;
  });
  const [limit, setLimit] = useState<number>(() => {
    const val = localStorage.getItem('cf_lib_limit');
    return val ? parseInt(val, 10) : 50;
  });
  const [jumpPageInput, setJumpPageInput] = useState('');
  
  // Search & Filter states
  const [searchQuery, setSearchQuery] = useState(() => localStorage.getItem('cf_lib_search_query') || '');
  const [selectedTag, setSelectedTag] = useState(() => localStorage.getItem('cf_lib_selected_tag') || '');
  const [minRating, setMinRating] = useState<string>(() => localStorage.getItem('cf_lib_min_rating') || '');
  const [maxRating, setMaxRating] = useState<string>(() => localStorage.getItem('cf_lib_max_rating') || '');
  
  // Sorting states
  const [sortBy, setSortBy] = useState<'rating' | null>(() => localStorage.getItem('cf_lib_sort_by') as 'rating' | null || null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(() => localStorage.getItem('cf_lib_sort_order') as 'asc' | 'desc' || 'asc');
  
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Checkbox selection states
  const [selectedProblemIds, setSelectedProblemIds] = useState<string[]>(() => {
    const val = localStorage.getItem('cf_lib_selected_ids');
    try {
      return val ? JSON.parse(val) : [];
    } catch (e) {
      return [];
    }
  });

  // Synchronize selection to localStorage
  useEffect(() => {
    localStorage.setItem('cf_lib_selected_ids', JSON.stringify(selectedProblemIds));
  }, [selectedProblemIds]);

  // Automatically clear selection when a batch translation starts
  useEffect(() => {
    if (batchQueue.isActive) {
      setSelectedProblemIds([]);
    }
  }, [batchQueue.isActive]);

  // Synchronize states to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('cf_lib_page', page.toString());
    localStorage.setItem('cf_lib_limit', limit.toString());
    localStorage.setItem('cf_lib_search_query', searchQuery);
    localStorage.setItem('cf_lib_selected_tag', selectedTag);
    localStorage.setItem('cf_lib_min_rating', minRating);
    localStorage.setItem('cf_lib_max_rating', maxRating);
    if (sortBy) {
      localStorage.setItem('cf_lib_sort_by', sortBy);
    } else {
      localStorage.removeItem('cf_lib_sort_by');
    }
    localStorage.setItem('cf_lib_sort_order', sortOrder);
  }, [page, limit, searchQuery, selectedTag, minRating, maxRating, sortBy, sortOrder]);

  // Trigger load whenever filters, page, limit, or sorting changes
  useEffect(() => {
    fetchProblems();
  }, [page, limit, selectedTag, minRating, maxRating, sortBy, sortOrder]);

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setPage(1);
  };

  const handleJumpPage = (e: React.FormEvent) => {
    e.preventDefault();
    const pageNum = parseInt(jumpPageInput, 10);
    if (pageNum && pageNum >= 1 && pageNum <= totalPages) {
      setPage(pageNum);
      setJumpPageInput('');
    } else {
      onShowToast(`请输入 1 到 ${totalPages} 之间的有效页码！`, 'error');
    }
  };

  const fetchProblems = async () => {
    setIsLoading(true);
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

      const response = await fetch(`http://localhost:8000/api/problems?${queryParams.toString()}`);
      if (response.ok) {
        const data = await response.json();
        setProblems(data.problems || []);
        setTotal(data.total || 0);
      } else {
        onShowToast('获取题库列表失败', 'error');
      }
    } catch (e) {
      console.error(e);
      onShowToast('网络错误，无法加载官方题库', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1); // Reset to page 1 on new search
    fetchProblems();
  };

  const handleClearFilters = () => {
    setSearchQuery('');
    setSelectedTag('');
    setMinRating('');
    setMaxRating('');
    setSortBy(null);
    setPage(1);
  };

  const handleSyncLibrary = async () => {
    if (!window.confirm('从 Codeforces 官方同步全部题库可能需要 10~20 秒，您确定要开始同步吗？')) return;
    
    setIsSyncing(true);
    onShowToast('正在从 Codeforces 同步全量官方题库，请稍候...', 'success');
    
    try {
      const response = await fetch('http://localhost:8000/api/problems/sync');
      if (response.ok) {
        const data = await response.json();
        onShowToast(`题库同步成功！共更新了 ${data.count} 道题目。`, 'success');
        setPage(1);
        fetchProblems();
      } else {
        onShowToast('同步官方题库失败，请检查网络或稍后重试', 'error');
      }
    } catch (e) {
      console.error(e);
      onShowToast('同步错误，请确认本地后端服务开启', 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  // Helper to get styled rating difficulty badges based on score
  const getRatingStyle = (rating: number | null) => {
    if (rating === null) return { bg: 'HSL(0, 0%, 94%)', text: 'HSL(0, 0%, 40%)', name: 'Unrated' };
    if (rating < 1200) return { bg: 'HSL(142, 70%, 94%)', text: 'HSL(142, 72%, 29%)', name: 'Novice' }; // Easy Green
    if (rating < 1600) return { bg: 'HSL(187, 75%, 94%)', text: 'HSL(187, 85%, 28%)', name: 'Medium' }; // Cyan
    if (rating < 1900) return { bg: 'HSL(221, 80%, 94%)', text: 'HSL(221, 83%, 45%)', name: 'Expert' }; // Blue
    if (rating < 2100) return { bg: 'HSL(280, 70%, 94%)', text: 'HSL(280, 80%, 40%)', name: 'Candidate Master' }; // Purple
    if (rating < 2400) return { bg: 'HSL(38, 92%, 94%)', text: 'HSL(38, 92%, 40%)', name: 'Master' }; // Orange
    return { bg: 'HSL(350, 80%, 94%)', text: 'HSL(350, 89%, 45%)', name: 'Grandmaster' }; // Red
  };

  const totalPages = Math.ceil(total / limit) || 1;

  const handleTagClick = (tag: string) => {
    setSelectedTag(tag === selectedTag ? '' : tag);
    setPage(1);
  };

  const handleSortByRating = () => {
    if (sortBy !== 'rating') {
      setSortBy('rating');
      setSortOrder('asc');
    } else if (sortOrder === 'asc') {
      setSortOrder('desc');
    } else {
      setSortBy(null);
    }
    setPage(1);
  };

  return (
    <div>
      {/* Page Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">官方算法题库列表</h1>
          <p className="page-subtitle">浏览全网 8000+ 道 Codeforces 经典题目，按算法、难度精准筛选，一键中文翻译做题。</p>
        </div>
        <button
          className="btn-secondary"
          onClick={handleSyncLibrary}
          disabled={isSyncing}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px' }}
        >
          <RefreshCw size={16} className={isSyncing ? 'spinner' : ''} />
          {isSyncing ? '正在同步...' : '同步官方题库'}
        </button>
      </div>

      {/* Modern Filter Dashboard Panel */}
      <div className="search-container">
        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="search-row">
            {/* Keyword search */}
            <div className="search-input-wrapper" style={{ flexGrow: 3 }}>
              <Search className="search-icon" size={20} />
              <input
                type="text"
                className="search-input"
                placeholder="搜索题目名称、比赛ID (例如 '1800' 或 'soft drinking')"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            
            {/* Rating Boundaries */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexGrow: 1 }}>
              <input
                type="number"
                className="form-input"
                style={{ padding: '12.5px 12px', minWidth: '80px' }}
                placeholder="Min Rating (如 800)"
                value={minRating}
                onChange={(e) => setMinRating(e.target.value)}
              />
              <span style={{ color: 'var(--text-secondary)' }}>-</span>
              <input
                type="number"
                className="form-input"
                style={{ padding: '12.5px 12px', minWidth: '80px' }}
                placeholder="Max Rating (如 2000)"
                value={maxRating}
                onChange={(e) => setMaxRating(e.target.value)}
              />
            </div>

            <button type="submit" className="search-button">
              筛选检索
            </button>
          </div>

          {/* Tags list filters */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Hash size={14} /> 算法标签筛选 (Tags)
            </span>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', maxHeight: '72px', overflowY: 'auto', paddingRight: '4px' }}>
              {POPULAR_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleTagClick(tag)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    border: '1px solid ' + (tag === selectedTag ? 'var(--primary)' : 'var(--border-color)'),
                    backgroundColor: tag === selectedTag ? 'var(--primary-light)' : 'var(--bg-card)',
                    color: tag === selectedTag ? 'var(--primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontWeight: tag === selectedTag ? 600 : 500,
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* Clear button */}
          {(searchQuery || selectedTag || minRating || maxRating) && (
            <button
              type="button"
              className="btn-secondary"
              onClick={handleClearFilters}
              style={{ width: 'fit-content', padding: '6px 12px', fontSize: '12px', alignSelf: 'flex-end' }}
            >
              清空筛选条件
            </button>
          )}
        </form>
      </div>

      {/* Grid Library List */}
      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '24px', boxShadow: 'var(--shadow-premium)', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        


        {/* Selected Control Bar */}
        {selectedProblemIds.length > 0 && !batchQueue.isActive && (
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 20px',
            backgroundColor: 'var(--bg-hover)',
            border: '1px solid var(--border-color)',
            borderRadius: '12px',
            marginBottom: '4px',
            animation: 'fadeIn 0.2s ease'
          }}>
            <div style={{ fontSize: '13.5px', color: 'var(--text-secondary)' }}>
              已选中 <strong style={{ color: 'var(--primary)' }}>{selectedProblemIds.length}</strong> 道题目
            </div>
            
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={() => setSelectedProblemIds([])}
                className="btn-secondary"
                style={{ padding: '6px 12px', fontSize: '12.5px', fontWeight: 600 }}
              >
                取消选择
              </button>
              <button
                onClick={() => onStartBatch(problems.filter(p => selectedProblemIds.includes(p.id)))}
                className="search-button"
                style={{
                  padding: '6px 16px',
                  fontSize: '12.5px',
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <span>🚀 批量翻译预热 (每题冷却 60s)</span>
              </button>
            </div>
          </div>
        )}

        {/* Table representation */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '700px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 600 }}>
                <th style={{ padding: '12px 16px', width: '40px' }}>
                  <input
                    type="checkbox"
                    checked={problems.length > 0 && selectedProblemIds.length === problems.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedProblemIds(problems.map(p => p.id));
                      } else {
                        setSelectedProblemIds([]);
                      }
                    }}
                    disabled={batchQueue.isActive}
                    style={{ cursor: 'pointer', transform: 'scale(1.15)' }}
                    title="选择本页所有题目"
                  />
                </th>
                <th style={{ padding: '12px 16px', width: '180px' }}>代码 (Code)</th>
                <th style={{ padding: '12px 16px' }}>题目名称 (Problem Title)</th>
                <th 
                  onClick={handleSortByRating}
                  style={{ padding: '12px 16px', width: '160px', cursor: 'pointer', userSelect: 'none' }}
                  className="hover-sortable"
                  title="点击按难度评分排序"
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>难度评分 (Rating)</span>
                    {sortBy === 'rating' ? (
                      sortOrder === 'asc' ? '🔼' : '🔽'
                    ) : (
                      <span style={{ opacity: 0.3 }}>⇅</span>
                    )}
                  </div>
                </th>
                <th style={{ padding: '12px 16px', width: '150px' }}>解出人数 (Solves)</th>
                <th style={{ padding: '12px 16px', width: '300px' }}>标签 (Tags)</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} style={{ padding: '60px 0', textAlign: 'center' }}>
                    <div className="spinner" style={{ margin: '0 auto 16px auto', width: '36px', height: '36px' }}></div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>正在为您检索本地算法题库...</div>
                  </td>
                </tr>
              ) : problems.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                    没有找到符合筛选条件的题目。请尝试清空筛选条件或重新同步官方题库。
                  </td>
                </tr>
              ) : (
                problems.map((p) => {
                  const ratingStyle = getRatingStyle(p.rating);
                  const isSelected = selectedProblemIds.includes(p.id);
                  return (
                    <tr
                      key={p.id}
                      onClick={() => onSelectProblem(p.contest_id, p.index)}
                      style={{
                        borderBottom: '1px solid var(--border-color)',
                        cursor: 'pointer',
                        transition: 'background-color var(--transition-fast)',
                        backgroundColor: isSelected ? 'var(--primary-light)' : 'transparent'
                      }}
                      className="contest-card-row"
                    >
                      {/* Checkbox */}
                      <td style={{ padding: '16px', width: '40px' }} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedProblemIds(prev => [...prev, p.id]);
                            } else {
                              setSelectedProblemIds(prev => prev.filter(id => id !== p.id));
                            }
                          }}
                          disabled={batchQueue.isActive}
                          style={{ cursor: 'pointer', transform: 'scale(1.15)' }}
                        />
                      </td>
                      
                      {/* Code badge */}
                      <td style={{ padding: '16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'nowrap' }}>
                          {p.solved_status === 'OK' && (
                            <span title="已通过 (Accepted)" style={{ display: 'inline-flex', fontSize: '14px', cursor: 'default', flexShrink: 0 }}>
                              ✅
                            </span>
                          )}
                          {p.solved_status === 'FAILED' && (
                            <span title="尝试过未通过 (Attempted)" style={{ display: 'inline-flex', fontSize: '14px', cursor: 'default', flexShrink: 0 }}>
                              ❌
                            </span>
                          )}
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '13.5px', color: 'var(--primary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                            {p.contest_id}{p.index}
                          </span>
                          {p.is_cached && (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              backgroundColor: 'rgba(16, 185, 129, 0.1)',
                              color: '#10b981',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              fontSize: '11.5px',
                              fontWeight: 600,
                              marginLeft: '4px',
                              cursor: 'default',
                              whiteSpace: 'nowrap',
                              flexShrink: 0
                            }} title="已离线缓存，可秒开阅读">
                              <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block', flexShrink: 0 }}></span>
                              已译
                            </span>
                          )}
                        </div>
                      </td>
                      
                      {/* Name */}
                      <td style={{ padding: '16px' }}>
                        <span style={{ fontWeight: 600, fontSize: '14.5px', color: 'var(--text-primary)' }}>
                          {p.name}
                        </span>
                      </td>
                      
                      {/* Rating */}
                      <td style={{ padding: '16px' }}>
                        {p.rating !== null ? (
                          <div style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            backgroundColor: ratingStyle.bg,
                            color: ratingStyle.text,
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 700
                          }}>
                            <Star size={12} fill={ratingStyle.text} />
                            <span>{p.rating}</span>
                          </div>
                        ) : (
                          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>-</span>
                        )}
                      </td>
                      
                      {/* Solves */}
                      <td style={{ padding: '16px' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                          <CheckSquare size={13} style={{ color: 'var(--success)' }} />
                          <span>{p.solved_count.toLocaleString()} solves</span>
                        </div>
                      </td>

                      {/* Tags */}
                      <td style={{ padding: '16px' }}>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {p.tags.slice(0, 3).map((t) => (
                            <span key={t} style={{
                              fontSize: '11px',
                              backgroundColor: 'var(--bg-main)',
                              color: 'var(--text-secondary)',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              whiteSpace: 'nowrap'
                            }}>
                              {t}
                            </span>
                          ))}
                          {p.tags.length > 3 && (
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)', alignSelf: 'center' }}>
                              +{p.tags.length - 3}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 4. Elegant Pagination Controls */}
        {!isLoading && problems.length > 0 && (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '16px',
            borderTop: '1px solid var(--border-color)',
            paddingTop: '16px',
            marginTop: '8px'
          }}>
            {/* Left side: statistics and limit select */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13.5px', color: 'var(--text-secondary)' }}>
                显示 <b>{(page - 1) * limit + 1} - {Math.min(page * limit, total)}</b> 条 ，共计 <b>{total.toLocaleString()}</b> 道题
              </span>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', color: 'var(--text-secondary)' }}>
                <span>每页显示:</span>
                <select
                  value={limit}
                  onChange={(e) => handleLimitChange(parseInt(e.target.value, 10))}
                  style={{
                    padding: '4px 8px',
                    fontSize: '13.5px',
                    fontWeight: 600,
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--bg-sidebar)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  <option value={10}>10 条</option>
                  <option value={20}>20 条</option>
                  <option value={50}>50 条</option>
                  <option value={100}>100 条</option>
                </select>
              </div>
            </div>

            {/* Right side: smart buttons and page jump input */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              {/* Smart page numbers navigation bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {/* Previous Button */}
                <button
                  className="btn-secondary"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  style={{
                    width: '32px',
                    height: '32px',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  <ChevronLeft size={16} />
                </button>

                {/* Smart Page numbers list */}
                {(() => {
                  const pages = [];
                  const range = 2; // how many pages around current page
                  
                  pages.push(1);
                  
                  if (page > range + 2) {
                    pages.push('...left-ell');
                  }
                  
                  for (let i = Math.max(2, page - range); i <= Math.min(totalPages - 1, page + range); i++) {
                    pages.push(i);
                  }
                  
                  if (page < totalPages - range - 1) {
                    pages.push('...right-ell');
                  }
                  
                  if (totalPages > 1) {
                    pages.push(totalPages);
                  }

                  return pages.map((pNum, idx) => {
                    if (typeof pNum === 'string') {
                      return <span key={`ell-lib-${idx}`} style={{ color: 'var(--text-muted)', padding: '0 2px' }}>...</span>;
                    }
                    const isSelected = page === pNum;
                    return (
                      <button
                        key={`page-lib-${pNum}`}
                        onClick={() => setPage(pNum)}
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
                        {pNum}
                      </button>
                    );
                  });
                })()}

                {/* Next Button */}
                <button
                  className="btn-secondary"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                  style={{
                    width: '32px',
                    height: '32px',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Page Jump Form */}
              <form onSubmit={handleJumpPage} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="number"
                  placeholder="页码..."
                  value={jumpPageInput}
                  onChange={(e) => setJumpPageInput(e.target.value)}
                  style={{
                    width: '64px',
                    padding: '6px 8px',
                    fontSize: '13px',
                    textAlign: 'center',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--bg-sidebar)',
                    color: 'var(--text-primary)',
                    outline: 'none'
                  }}
                />
                <button
                  type="submit"
                  style={{
                    padding: '6px 12px',
                    fontSize: '13px',
                    fontWeight: 600,
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-main)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  跳转
                </button>
              </form>
            </div>
          </div>
        )}
      </div>

      {/* Row Hover Custom Styling helper in CSS */}
      <style>{`
        .contest-card-row:hover {
          background-color: var(--primary-light) !important;
        }
      `}</style>
    </div>
  );
};
