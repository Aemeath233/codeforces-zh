import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, BookOpen, Layers, Languages, Copy, Check, Clock, Cpu, FileText, Send, AlertTriangle } from 'lucide-react';

interface Sample {
  input: string;
  output: string;
}

interface ProblemData {
  problem_id: string;
  contest_id: number;
  index: string;
  title: string;
  time_limit: string;
  memory_limit: string;
  input_file: string;
  output_file: string;
  description_html: string;
  input_spec_html: string;
  output_spec_html: string;
  samples: Sample[];
  note_html: string;
  translated: {
    title: string;
    description_html: string;
    input_spec_html: string;
    output_spec_html: string;
    note_html: string;
  };
}

const COMPILERS = [
  { id: '91', name: 'GNU G++23 14.2 (C++23)' },
  { id: '89', name: 'GNU G++20 13.2 (C++20)' },
  { id: '54', name: 'GNU G++17 7.3.0 (C++17)' },
  { id: '31', name: 'Python 3.8.10' },
  { id: '70', name: 'PyPy 3.10 (7.3.15)' },
  { id: '87', name: 'Java 21 64bit' },
  { id: '60', name: 'Java 17 64bit' },
  { id: '75', name: 'Rust 1.75.0' },
  { id: '55', name: 'Node.js 20.11.1' },
];

interface ProblemContentProps {
  problemData: ProblemData;
  viewMode: 'bilingual' | 'chinese' | 'english';
  hasNote: boolean;
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

const ProblemContent = React.memo(({ problemData, viewMode, hasNote, onShowToast }: ProblemContentProps) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [copiedIndex, setCopiedIndex] = useState<{ [key: number]: 'input' | 'output' | null }>({});

  const handleCopyToClipboard = (text: string, index: number, type: 'input' | 'output') => {
    navigator.clipboard.writeText(text);
    setCopiedIndex((prev) => ({ ...prev, [index]: type }));
    onShowToast(`已复制样例${type === 'input' ? '输入' : '输出'}到剪贴板！`, 'success');
    
    // Reset copy state after 2 seconds
    setTimeout(() => {
      setCopiedIndex((prev) => ({ ...prev, [index]: null }));
    }, 2000);
  };

  // Re-run MathJax rendering whenever problemData or viewMode changes
  useEffect(() => {
    let isMounted = true;
    let pollCount = 0;
    const maxPolls = 100; // Poll for up to 5 seconds (50ms * 100)
    let pollInterval: any = null;

    const runTypeset = () => {
      const mathJax = (window as any).MathJax;
      if (mathJax && mathJax.typesetPromise && contentRef.current) {
        try {
          mathJax.typesetClear([contentRef.current]);
        } catch (e) {
          console.warn('MathJax typesetClear warning:', e);
        }

        mathJax.typesetPromise([contentRef.current]).catch((err: any) => {
          console.error('MathJax rendering error:', err);
        });

        if (pollInterval) {
          clearInterval(pollInterval);
        }
        return true;
      }
      return false;
    };

    const timer = setTimeout(() => {
      if (!isMounted) return;
      const success = runTypeset();
      if (!success) {
        pollInterval = setInterval(() => {
          if (!isMounted) {
            clearInterval(pollInterval);
            return;
          }
          pollCount++;
          const done = runTypeset();
          if (done || pollCount >= maxPolls) {
            clearInterval(pollInterval);
          }
        }, 50);
      }
    }, 50);

    return () => {
      isMounted = false;
      clearTimeout(timer);
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [problemData, viewMode]);

  return (
    <div ref={contentRef} className="tex2jax_process" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* 2. Reader Body */}
      <div className={`problem-reader-split ${viewMode !== 'bilingual' ? 'single-column' : ''}`}>
        
        {/* Chinese Content Column */}
        {(viewMode === 'bilingual' || viewMode === 'chinese') && (
          <div className="reader-column">
            {viewMode === 'bilingual' && <div className="column-header-tab">中文智能翻译</div>}
            
            {/* Title */}
            <div className="problem-html">
              <h2 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '16px', color: 'var(--primary)' }}>
                {problemData.translated.title}
              </h2>
              
              {/* Description */}
              <div 
                dangerouslySetInnerHTML={{ __html: problemData.translated.description_html }} 
              />
              
              {/* Input format */}
              {problemData.translated.input_spec_html && (
                <>
                  <div className="section-subtitle">输入格式说明</div>
                  <div dangerouslySetInnerHTML={{ __html: problemData.translated.input_spec_html }} />
                </>
              )}

              {/* Output format */}
              {problemData.translated.output_spec_html && (
                <>
                  <div className="section-subtitle">输出格式说明</div>
                  <div dangerouslySetInnerHTML={{ __html: problemData.translated.output_spec_html }} />
                </>
              )}

              {/* Note/Hint */}
              {viewMode === 'chinese' && hasNote && (
                <>
                  <div className="section-subtitle">提示与说明</div>
                  <div dangerouslySetInnerHTML={{ __html: problemData.translated.note_html || problemData.note_html }} />
                </>
              )}
            </div>
          </div>
        )}

        {/* English Content Column */}
        {(viewMode === 'bilingual' || viewMode === 'english') && (
          <div className="reader-column">
            {viewMode === 'bilingual' && <div className="column-header-tab en">Original English</div>}
            
            <div className="problem-html">
              <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '16px', color: 'var(--text-primary)' }}>
                {problemData.title}
              </h2>
              
              <div 
                dangerouslySetInnerHTML={{ __html: problemData.description_html }} 
              />
              
              {problemData.input_spec_html && (
                <>
                  <div className="section-subtitle" style={{ borderColor: 'var(--text-secondary)' }}>Input</div>
                  <div dangerouslySetInnerHTML={{ __html: problemData.input_spec_html }} />
                </>
              )}

              {problemData.output_spec_html && (
                <>
                  <div className="section-subtitle" style={{ borderColor: 'var(--text-secondary)' }}>Output</div>
                  <div dangerouslySetInnerHTML={{ __html: problemData.output_spec_html }} />
                </>
              )}

              {viewMode === 'english' && hasNote && (
                <>
                  <div className="section-subtitle" style={{ borderColor: 'var(--text-secondary)' }}>Note</div>
                  <div dangerouslySetInnerHTML={{ __html: problemData.note_html }} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 3. Sample Tests & Note (Always full width at bottom for comfortable reading) */}
      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '32px', boxShadow: 'var(--shadow-premium)' }}>
        
        {/* Samples */}
        {problemData.samples && problemData.samples.length > 0 && (
          <div>
            <h2 className="panel-title" style={{ fontSize: '18px', borderBottom: 'none', paddingBottom: 0, marginBottom: '16px' }}>
              📊 评测样例数据 (Examples)
            </h2>
            <div className="samples-container">
              {problemData.samples.map((sample, idx) => (
                <div key={idx} className="sample-block">
                  <div className="sample-header">
                    <span>样例 #{idx + 1}</span>
                  </div>
                  
                  <div className="sample-grid">
                    {/* Input cell */}
                    <div className="sample-input-cell">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="sample-cell-title">输入 (Input)</div>
                        <button
                          className="sample-copy-btn"
                          onClick={() => handleCopyToClipboard(sample.input, idx, 'input')}
                        >
                          {copiedIndex[idx] === 'input' ? (
                            <>
                              <Check size={12} />
                              已复制
                            </>
                          ) : (
                            <>
                              <Copy size={12} />
                              复制输入
                            </>
                          )}
                        </button>
                      </div>
                      <pre className="sample-pre">{sample.input}</pre>
                    </div>

                    {/* Output cell */}
                    <div className="sample-output-cell">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="sample-cell-title">输出 (Output)</div>
                        <button
                          className="sample-copy-btn"
                          onClick={() => handleCopyToClipboard(sample.output, idx, 'output')}
                        >
                          {copiedIndex[idx] === 'output' ? (
                            <>
                              <Check size={12} />
                              已复制
                            </>
                          ) : (
                            <>
                              <Copy size={12} />
                              复制输出
                            </>
                          )}
                        </button>
                      </div>
                      <pre className="sample-pre">{sample.output}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Note if in bilingual mode */}
        {viewMode === 'bilingual' && hasNote && (
          <div style={{ marginTop: '32px', borderTop: '1px solid var(--border-color)', paddingTop: '24px' }}>
            <h2 className="panel-title" style={{ fontSize: '18px', border: 'none', padding: 0, marginBottom: '16px' }}>
              💡 样例说明 / 提示 (Note)
            </h2>
            <div className="problem-reader-split">
              {/* Chinese Note */}
              <div className="problem-html">
                <div className="column-header-tab" style={{ marginBottom: '12px' }}>说明 (译)</div>
                <div dangerouslySetInnerHTML={{ __html: problemData.translated.note_html || problemData.note_html }} />
              </div>
              {/* English Note */}
              <div className="problem-html">
                <div className="column-header-tab en" style={{ marginBottom: '12px' }}>Original Note</div>
                <div dangerouslySetInnerHTML={{ __html: problemData.note_html }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return prevProps.viewMode === nextProps.viewMode &&
         prevProps.hasNote === nextProps.hasNote &&
         prevProps.problemData.problem_id === nextProps.problemData.problem_id &&
         prevProps.problemData.translated?.description_html === nextProps.problemData.translated?.description_html &&
         prevProps.problemData.description_html === nextProps.problemData.description_html;
});

interface ProblemViewerProps {
  problemData: ProblemData;
  onRefresh: () => void;
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

export const ProblemViewer: React.FC<ProblemViewerProps> = ({ problemData, onRefresh, onShowToast }) => {
  const [viewMode, setViewMode] = useState<'bilingual' | 'chinese' | 'english'>('chinese');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Direct Submission States
  const [cfUser, setCfUser] = useState<{ cf_handle: string; cf_cookies_configured: boolean } | null>(null);
  const [compilerId, setCompilerId] = useState(() => localStorage.getItem('cf_compiler_id') || '89'); // Default to C++20 or memorized choice

  const handleForceRefresh = async () => {
    setIsRefreshing(true);
    onShowToast('正在为您重构并重新翻译题面，请稍候...', 'success');
    try {
      const response = await fetch(
        `http://localhost:8000/api/problem/${problemData.contest_id}/${problemData.index}?force_refresh=true`
      );
      if (response.ok) {
        onShowToast('重新翻译成功！已更新题面。', 'success');
        onRefresh(); // Trigger parent fetch to update state
      } else {
        const err = await response.json();
        onShowToast(err.detail || '重构翻译失败，请检查配置或网络', 'error');
      }
    } catch (error) {
      console.error(error);
      onShowToast('网络错误，重新翻译失败', 'error');
    } finally {
      setIsRefreshing(false);
    }
  };

  const checkUserConfig = async () => {
    try {
      const response = await fetch('http://localhost:8000/api/config/user');
      if (response.ok) {
        const data = await response.json();
        setCfUser(data);
      }
    } catch (error) {
      console.error('Failed to check user config:', error);
    }
  };

  useEffect(() => {
    checkUserConfig();
  }, [problemData]);

  const hasNote = !!(problemData.note_html || (problemData.translated && problemData.translated.note_html));

  return (
    <div className="problem-viewer-container">
      {/* 1. Problem Meta Header */}
      <div className="problem-header-card">
        <div>
          <h1 className="page-title" style={{ fontSize: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span>{problemData.index}. {problemData.translated.title || problemData.title}</span>
            <span style={{ fontSize: '14px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>
              ({problemData.title})
            </span>
          </h1>
          
          <div className="problem-meta-list">
            <div className="problem-meta-item">
              <Clock size={16} />
              <span className="problem-meta-label">单点时限:</span>
              <span className="problem-meta-value">{problemData.time_limit}</span>
            </div>
            <div className="problem-meta-item">
              <Cpu size={16} />
              <span className="problem-meta-label">内存限制:</span>
              <span className="problem-meta-value">{problemData.memory_limit}</span>
            </div>
            <div className="problem-meta-item">
              <FileText size={16} />
              <span className="problem-meta-label">标准输入/输出:</span>
              <span className="problem-meta-value">{problemData.input_file} / {problemData.output_file}</span>
            </div>
          </div>
        </div>

        {/* Action controls */}
        <div className="view-actions">
          {/* Mode Switchers */}
          <div style={{ display: 'flex', border: '1px solid var(--border-color)', borderRadius: '10px', overflow: 'hidden' }}>
            <button
              className={`btn-secondary ${viewMode === 'bilingual' ? 'active' : ''}`}
              onClick={() => setViewMode('bilingual')}
              style={{ border: 'none', borderRadius: 0, padding: '10px 14px' }}
              title="双语对照模式"
            >
              <Languages size={16} />
              <span style={{ fontSize: '13px' }}>双语对照</span>
            </button>
            <button
              className={`btn-secondary ${viewMode === 'chinese' ? 'active' : ''}`}
              onClick={() => setViewMode('chinese')}
              style={{ border: 'none', borderLeft: '1px solid var(--border-color)', borderRadius: 0, padding: '10px 14px' }}
              title="纯中文模式"
            >
              <BookOpen size={16} />
              <span style={{ fontSize: '13px' }}>中文阅读</span>
            </button>
            <button
              className={`btn-secondary ${viewMode === 'english' ? 'active' : ''}`}
              onClick={() => setViewMode('english')}
              style={{ border: 'none', borderLeft: '1px solid var(--border-color)', borderRadius: 0, padding: '10px 14px' }}
              title="纯英文原版"
            >
              <Layers size={16} />
              <span style={{ fontSize: '13px' }}>英文原版</span>
            </button>
          </div>

          {/* Refresh Button */}
          <button
            className="btn-secondary"
            onClick={handleForceRefresh}
            disabled={isRefreshing}
            style={{ padding: '10px 14px' }}
            title="强制重抓重译"
          >
            <RefreshCw size={16} className={isRefreshing ? 'spinner' : ''} />
            <span style={{ fontSize: '13px' }}>重新翻译</span>
          </button>

        </div>
      </div>

      {/* 2 & 3. Memoized Problem Content (Reader Columns, Samples, Notes) */}
      <ProblemContent
        problemData={problemData}
        viewMode={viewMode}
        hasNote={hasNote}
        onShowToast={onShowToast}
      />

      {/* 4. Direct Codeforces Submission Panel (Premium Notion Style) */}
      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '32px', boxShadow: 'var(--shadow-premium)', marginTop: '24px' }}>
        <h2 className="panel-title" style={{ fontSize: '18px', borderBottom: 'none', paddingBottom: 0, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          🚀 提交解答至官网 (Submit Solution to Codeforces)
        </h2>
        
        {cfUser === null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '16px', backgroundColor: 'var(--bg-hover)', borderRadius: '10px', fontSize: '14px', color: 'var(--text-secondary)' }}>
            <RefreshCw size={16} className="spinner" />
            <span>正在检测您的 Codeforces 会话状态...</span>
          </div>
        ) : !cfUser.cf_cookies_configured ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', backgroundColor: 'var(--warning-bg)', border: '1px solid HSL(38, 92%, 85%)', borderRadius: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--warning)', fontWeight: 600 }}>
              <AlertTriangle size={20} />
              <span>尚未配置 Codeforces 登录凭证</span>
            </div>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              您尚未在镜像站录入您的 Codeforces Cookie 和 Handle，无法通过本镜像站直接向 Codeforces 官方评测机提交代码。
            </p>
            <div style={{ marginTop: '4px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                请前往左侧边栏的 <strong>「管理后台 (设置)」</strong> 录入您的 Cookie，录入后即可在此页直接提交。
              </span>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Account Bind Meta */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', backgroundColor: 'var(--primary-light)', borderRadius: '10px', border: '1px solid HSL(221, 83%, 92%)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                <span style={{ color: 'var(--primary)', fontWeight: 700 }}>●</span>
                <span style={{ color: 'var(--text-secondary)' }}>Codeforces 账号已授权连接:</span>
                <strong style={{ color: 'var(--primary)', fontFamily: 'var(--font-sans)', fontWeight: 700 }}>{cfUser.cf_handle}</strong>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                官网同步就绪
              </span>
            </div>

            {/* Form control: Compiler select */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                选择编译器语言 (预选并自动带入官网页面)
              </label>
              <select
                value={compilerId}
                onChange={(e) => {
                  const val = e.target.value;
                  setCompilerId(val);
                  localStorage.setItem('cf_compiler_id', val);
                }}
                className="submit-select"
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--bg-main)',
                  color: 'var(--text-primary)',
                  fontWeight: 600,
                  outline: 'none',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)'
                }}
              >
                {COMPILERS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Jump Action Button */}
            <button
              onClick={() => window.open(`https://codeforces.com/contest/${problemData.contest_id}/submit?submittedProblemIndex=${problemData.index}&programTypeId=${compilerId}`, '_blank')}
              className="search-button"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '14px',
                width: '100%',
                fontSize: '15px',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              <Send size={16} />
              立即前往官网提交本题 (Submit Solution on Codeforces)
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
