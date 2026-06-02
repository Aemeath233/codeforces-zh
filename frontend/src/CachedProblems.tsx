import React, { useState, useEffect } from 'react';
import { Trash2, Clock, Calendar, ArrowRight } from 'lucide-react';

interface CachedProblem {
  id: string;
  contest_id: number;
  index: string;
  title: string;
  translated_title: string;
  created_at: string | null;
  solved_status?: 'OK' | 'FAILED' | 'NONE';
}

interface CachedProblemsProps {
  onSelectProblem: (contestId: number, index: string) => void;
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

export const CachedProblems: React.FC<CachedProblemsProps> = ({ onSelectProblem, onShowToast }) => {
  const [problems, setProblems] = useState<CachedProblem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchCachedProblems = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('http://localhost:8000/api/problems/cached');
      if (response.ok) {
        const data = await response.json();
        setProblems(data.problems || []);
      } else {
        onShowToast('获取本地已译题目列表失败', 'error');
      }
    } catch (error) {
      console.error(error);
      onShowToast('网络错误，无法连接服务器', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCachedProblems();
  }, []);

  const handleDeleteCache = async (e: React.MouseEvent, contestId: number, index: string) => {
    e.stopPropagation(); // Prevent row click
    if (!confirm(`确定要清除题目 ${contestId}${index} 的本地翻译缓存吗？\n清除后，再次阅读该题将重新请求大模型进行翻译。`)) {
      return;
    }

    try {
      const response = await fetch(`http://localhost:8000/api/problem/${contestId}/${index}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        onShowToast(`已成功清除题目 ${contestId}${index} 的本地缓存！`, 'success');
        // Refresh local state
        setProblems((prev) => prev.filter((p) => !(p.contest_id === contestId && p.index === index)));
      } else {
        const err = await response.json();
        onShowToast(err.detail || '清除本地缓存失败', 'error');
      }
    } catch (error) {
      console.error(error);
      onShowToast('网络错误，清除本地缓存失败', 'error');
    }
  };

  const formatDate = (isoString: string | null) => {
    if (!isoString) return '未知时间';
    try {
      const date = new Date(isoString);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      return `${y}-${m}-${d} ${hh}:${mm}`;
    } catch {
      return '时间格式错误';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 0 }}>
        <div>
          <h1 className="page-title">📚 本地已译题目</h1>
          <p className="page-subtitle">
            您翻译并缓存的全部双语题面都在这里（当前共 {problems.length} 道），支持离线极速秒开阅读。
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="loading-container">
          <div className="spinner"></div>
          <div style={{ textAlign: 'center' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>正在加载本地已译题目列表...</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              正在快速读取本地 SQLite 缓存数据
            </p>
          </div>
        </div>
      ) : problems.length === 0 ? (
        /* Empty State */
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '64px 32px',
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-premium)',
          textAlign: 'center',
          gap: '16px'
        }}>
          <span style={{ fontSize: '48px' }}>📪</span>
          <h3 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>暂无本地已译题目历史</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14.5px', maxWidth: '500px', lineHeight: 1.6, margin: '0 auto 8px auto' }}>
            当您在“仪表盘”或“官方题库列表”中选择并翻译一道新题目后，系统便会自动将其中文翻译和原版题面**完整离线记录**到本地的数据库中，并同步显示在此处！
          </p>
          <div style={{ fontSize: '13.5px', color: 'var(--primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
            提示：已译题目在此页面可无网络极速秒开，无需任何 API 额度。
          </div>
        </div>
      ) : (
        /* Table List */
        <div style={{
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-premium)',
          overflow: 'hidden'
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-main)' }}>
                <th style={{ padding: '16px 24px', fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', width: '120px' }}>题号</th>
                <th style={{ padding: '16px 24px', fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)' }}>中文译名 / 原文名称</th>
                <th style={{ padding: '16px 24px', fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', width: '180px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Calendar size={14} />
                    <span>翻译时间</span>
                  </div>
                </th>
                <th style={{ padding: '16px 24px', fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', width: '180px', textAlign: 'center' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => onSelectProblem(p.contest_id, p.index)}
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)'
                  }}
                  className="cached-row"
                >
                  {/* Problem Index */}
                  <td style={{ padding: '18px 24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {p.solved_status === 'OK' && (
                        <span title="已通过 (Accepted)" style={{ display: 'inline-flex', fontSize: '14px', cursor: 'default' }}>
                          ✅
                        </span>
                      )}
                      {p.solved_status === 'FAILED' && (
                        <span title="尝试过未通过 (Attempted)" style={{ display: 'inline-flex', fontSize: '14px', cursor: 'default' }}>
                          ❌
                        </span>
                      )}
                      <span style={{
                        display: 'inline-block',
                        padding: '4px 10px',
                        backgroundColor: 'var(--primary-light)',
                        color: 'var(--primary)',
                        fontWeight: 800,
                        fontSize: '13px',
                        borderRadius: '6px',
                        fontFamily: 'var(--font-mono)'
                      }}>
                        {p.contest_id}{p.index}
                      </span>
                    </div>
                  </td>

                  {/* Problem Title */}
                  <td style={{ padding: '18px 24px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {p.translated_title || p.title}
                      </span>
                      <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                        {p.title}
                      </span>
                    </div>
                  </td>

                  {/* Cache Date */}
                  <td style={{ padding: '18px 24px', fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Clock size={13} style={{ color: 'var(--text-muted)' }} />
                      <span>{formatDate(p.created_at)}</span>
                    </div>
                  </td>

                  {/* Action Buttons */}
                  <td style={{ padding: '18px 24px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
                      <button
                        onClick={() => onSelectProblem(p.contest_id, p.index)}
                        className="btn-secondary"
                        style={{
                          padding: '6px 12px',
                          fontSize: '12.5px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          borderColor: 'var(--border-color)',
                          color: 'var(--primary)',
                          fontWeight: 600
                        }}
                      >
                        <span>阅读</span>
                        <ArrowRight size={12} />
                      </button>
                      <button
                        onClick={(e) => handleDeleteCache(e, p.contest_id, p.index)}
                        className="btn-secondary"
                        style={{
                          padding: '6px',
                          borderColor: 'var(--border-color)',
                          color: 'var(--danger)'
                        }}
                        title="删除该题本地缓存"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
