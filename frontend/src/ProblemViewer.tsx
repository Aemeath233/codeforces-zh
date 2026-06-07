import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, BookOpen, Layers, Languages, Copy, Check, Clock, Cpu, FileText, Send } from 'lucide-react';
import DOMPurify from 'dompurify';
import { API_BASE } from './api';

interface SampleLine {
  text: string;
  class: 'even' | 'odd' | 'none';
}

interface Sample {
  input: string;
  output: string;
  input_lines?: SampleLine[];
  output_lines?: SampleLine[];
}

export interface ProblemData {
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

interface SampleCopyButtonProps {
  text: string;
  type: 'input' | 'output';
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

const SampleCopyButton: React.FC<SampleCopyButtonProps> = ({ text, type, onShowToast }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    onShowToast(`已复制样例${type === 'input' ? '输入' : '输出'}到剪贴板！`, 'success');
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <button className="sample-copy-btn" onClick={handleCopy}>
      {copied ? (
        <>
          <Check size={12} />
          <span>已复制</span>
        </>
      ) : (
        <>
          <Copy size={12} />
          <span>{type === 'input' ? '复制输入' : '复制输出'}</span>
        </>
      )}
    </button>
  );
};

interface InteractiveSampleProps {
  input: string;
  output: string;
  inputLinesData?: SampleLine[];
  outputLinesData?: SampleLine[];
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

interface Block {
  lines: string[];
  class: 'even' | 'odd' | 'none';
}

const InteractiveSample: React.FC<InteractiveSampleProps> = ({
  input,
  output,
  inputLinesData,
  outputLinesData,
  onShowToast
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const parseLines = (text: string) => {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l, i, arr) => {
      if (i === arr.length - 1 && l.trim() === '') return false;
      return true;
    });
  };

  const groupLines = (lines: SampleLine[]): Block[] => {
    if (lines.length === 0) return [];
    const blocks: Block[] = [];
    let currentBlock: Block = {
      lines: [lines[0].text],
      class: lines[0].class
    };

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.class === currentBlock.class && line.class !== 'none') {
        currentBlock.lines.push(line.text);
      } else {
        blocks.push(currentBlock);
        currentBlock = {
          lines: [line.text],
          class: line.class
        };
      }
    }
    blocks.push(currentBlock);
    return blocks;
  };

  const hasStructuredLines =
    inputLinesData &&
    outputLinesData &&
    inputLinesData.length > 0 &&
    outputLinesData.length > 0;

  let isMatched = false;
  let tLine: string | null = null;
  let inputBlocks: Block[] = [];
  let outputBlocks: Block[] = [];

  if (hasStructuredLines) {
    const tRaw = inputLinesData[0]?.text.trim() || '';
    const t = /^\d+$/.test(tRaw) ? parseInt(tRaw, 10) : NaN;

    if (!isNaN(t) && t > 0 && inputLinesData.length > 1) {
      tLine = inputLinesData[0].text;
      const remainingInputLines = inputLinesData.slice(1);
      const groupedInput = groupLines(remainingInputLines);
      const groupedOutput = groupLines(outputLinesData);

      if (groupedInput.length === t && groupedOutput.length === t) {
        inputBlocks = groupedInput;
        outputBlocks = groupedOutput;
        isMatched = true;
      }
    } else {
      const groupedInput = groupLines(inputLinesData);
      const groupedOutput = groupLines(outputLinesData);

      if (groupedInput.length === groupedOutput.length && groupedInput.length > 0) {
        inputBlocks = groupedInput;
        outputBlocks = groupedOutput;
        isMatched = true;
      }
    }
  }

  // Fallback to older division logic if structured data is absent or unmatched
  if (!isMatched) {
    const inputLines = parseLines(input);
    const outputLines = parseLines(output);
    const tRaw = inputLines[0]?.trim();
    const t = /^\d+$/.test(tRaw) ? parseInt(tRaw, 10) : NaN;

    if (!isNaN(t) && t > 0 && inputLines.length > 1) {
      const remainingInputLines = inputLines.length - 1;
      if (remainingInputLines % t === 0 && outputLines.length % t === 0) {
        const kIn = remainingInputLines / t;
        const kOut = outputLines.length / t;

        tLine = inputLines[0];
        inputBlocks = Array.from({ length: t }).map((_, tcIdx) => {
          const startLine = 1 + tcIdx * kIn;
          return {
            lines: inputLines.slice(startLine, startLine + kIn),
            class: tcIdx % 2 === 0 ? 'odd' : 'even'
          };
        });
        outputBlocks = Array.from({ length: t }).map((_, tcIdx) => {
          const startLine = tcIdx * kOut;
          return {
            lines: outputLines.slice(startLine, startLine + kOut),
            class: tcIdx % 2 === 0 ? 'odd' : 'even'
          };
        });
        isMatched = true;
      }
    }
  }

  if (!isMatched) {
    return (
      <div className="sample-grid">
        <div className="sample-input-cell">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="sample-cell-title">输入 (Input)</div>
            <SampleCopyButton text={input} type="input" onShowToast={onShowToast} />
          </div>
          <pre className="sample-pre">{input}</pre>
        </div>
        <div className="sample-output-cell">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="sample-cell-title">输出 (Output)</div>
            <SampleCopyButton text={output} type="output" onShowToast={onShowToast} />
          </div>
          <pre className="sample-pre">{output}</pre>
        </div>
      </div>
    );
  }

  const renderInputBlock = () => {
    return (
      <div className="interactive-pre">
        {/* Render t on the first line */}
        {tLine !== null && (
          <div className="interactive-line-wrapper">
            <div className="interactive-gutter"></div>
            <div className="interactive-content-line first-line">{tLine}</div>
          </div>
        )}
        {/* Render test cases */}
        {inputBlocks.map((block, tcIdx) => {
          const isHovered = hoveredIdx === tcIdx;

          return (
            <div
              key={tcIdx}
              className={`interactive-tc-block ${block.class} ${isHovered ? 'hovered' : ''}`}
              onMouseEnter={() => setHoveredIdx(tcIdx)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div className="interactive-gutter">
                {isHovered ? <span className="tc-num-marker">{tcIdx + 1}</span> : null}
              </div>
              <div className="interactive-content-block">
                {block.lines.map((line, lIdx) => (
                  <div key={lIdx} className="interactive-content-line">{line || ' '}</div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderOutputBlock = () => {
    return (
      <div className="interactive-pre">
        {/* Render test cases */}
        {outputBlocks.map((block, tcIdx) => {
          const isHovered = hoveredIdx === tcIdx;

          return (
            <div
              key={tcIdx}
              className={`interactive-tc-block ${block.class} ${isHovered ? 'hovered' : ''}`}
              onMouseEnter={() => setHoveredIdx(tcIdx)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div className="interactive-gutter">
                {isHovered ? <span className="tc-num-marker">{tcIdx + 1}</span> : null}
              </div>
              <div className="interactive-content-block">
                {block.lines.map((line, lIdx) => (
                  <div key={lIdx} className="interactive-content-line">{line || ' '}</div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="sample-grid">
      <div className="sample-input-cell">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="sample-cell-title">输入 (Input)</div>
          <SampleCopyButton text={input} type="input" onShowToast={onShowToast} />
        </div>
        {renderInputBlock()}
      </div>
      <div className="sample-output-cell">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="sample-cell-title">输出 (Output)</div>
          <SampleCopyButton text={output} type="output" onShowToast={onShowToast} />
        </div>
        {renderOutputBlock()}
      </div>
    </div>
  );
};

interface AICopyButtonProps {
  problemData: ProblemData;
  hasNote: boolean;
  lang: 'zh' | 'en';
  viewMode: 'bilingual' | 'chinese' | 'english';
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

const AICopyButton: React.FC<AICopyButtonProps> = ({ problemData, hasNote, lang, viewMode, onShowToast }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const cleanHtmlToText = (html: string) => {
      if (!html) return '';
      let text = html;
      text = text.replace(/<p[^>]*>/gi, '\n');
      text = text.replace(/<\/p>/gi, '\n');
      text = text.replace(/<br\s*\/?>/gi, '\n');
      text = text.replace(/<li[^>]*>/gi, '\n* ');
      text = text.replace(/<\/li>/gi, '');
      text = text.replace(/<ul[^>]*>/gi, '');
      text = text.replace(/<\/ul>/gi, '\n');
      text = text.replace(/<pre[^>]*><code[^>]*>/gi, '\n```\n');
      text = text.replace(/<\/code><\/pre>/gi, '\n```\n');
      text = text.replace(/<code[^>]*>/gi, '`');
      text = text.replace(/<\/code>/gi, '`');
      text = text.replace(/<[^>]+>/g, '');

      const entities: { [key: string]: string } = {
        '&quot;': '"',
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&nbsp;': ' ',
        '&apos;': "'",
        '&middot;': '·',
        '&ldquo;': '“',
        '&rdquo;': '”',
        '&hellip;': '…'
      };
      text = text.replace(/&[a-z0-9#]+;/gi, (match) => entities[match] || match);

      return text.split('\n').map(line => line.trim()).filter((line, i, arr) => line !== '' || arr[i-1] !== '').join('\n');
    };

    if (lang === 'zh') {
      const title = problemData.translated.title || problemData.title;
      let cleanDescHtml = problemData.translated.description_html || '';
      cleanDescHtml = cleanDescHtml.replace(/^<div style=['"]background:\s*#(eff6ff|fee2e2|fef08a)[^>]*>([\s\S]*?)<\/div>/i, '');
      cleanDescHtml = cleanDescHtml.replace(/^<div style=['"][^'"]*['"]>\s*.*?(?:智能加速翻译|系统提示|多API回退告警|智能翻译节点).*?<\/div>/i, '');

      const desc = cleanHtmlToText(cleanDescHtml);
      const inputSpec = cleanHtmlToText(problemData.translated.input_spec_html);
      const outputSpec = cleanHtmlToText(problemData.translated.output_spec_html);
      const note = cleanHtmlToText(problemData.translated.note_html || problemData.note_html);

      let fullMarkdown = `# 题目: ${title}\n`;
      fullMarkdown += `**时间限制**: ${problemData.time_limit} | **内存限制**: ${problemData.memory_limit}\n\n`;
      fullMarkdown += `## 题目描述\n${desc}\n\n`;

      if (inputSpec) {
        fullMarkdown += `## 输入格式说明\n${inputSpec}\n\n`;
      }
      if (outputSpec) {
        fullMarkdown += `## 输出格式说明\n${outputSpec}\n\n`;
      }
      if (note && hasNote) {
        fullMarkdown += `## 提示与说明\n${note}\n\n`;
      }

      if (problemData.samples && problemData.samples.length > 0) {
        fullMarkdown += `## 评测样例数据 (Examples)\n`;
        problemData.samples.forEach((sample, idx) => {
          fullMarkdown += `### 样例 #${idx + 1}\n`;
          fullMarkdown += `**输入 (INPUT)**:\n\`\`\`\n${sample.input}\n\`\`\`\n`;
          fullMarkdown += `**输出 (OUTPUT)**:\n\`\`\`\n${sample.output}\n\`\`\`\n\n`;
        });
      }

      navigator.clipboard.writeText(fullMarkdown.trim());
      setCopied(true);
      onShowToast('中文题面（含格式化 Markdown）已一键复制到剪贴板！', 'success');
    } else {
      const title = problemData.title;
      const desc = cleanHtmlToText(problemData.description_html);
      const inputSpec = cleanHtmlToText(problemData.input_spec_html);
      const outputSpec = cleanHtmlToText(problemData.output_spec_html);
      const note = cleanHtmlToText(problemData.note_html);

      let fullMarkdown = `# Problem: ${title}\n`;
      fullMarkdown += `**Time Limit**: ${problemData.time_limit} | **Memory Limit**: ${problemData.memory_limit}\n\n`;
      fullMarkdown += `## Description\n${desc}\n\n`;

      if (inputSpec) {
        fullMarkdown += `## Input\n${inputSpec}\n\n`;
      }
      if (outputSpec) {
        fullMarkdown += `## Output\n${outputSpec}\n\n`;
      }
      if (note && hasNote) {
        fullMarkdown += `## Note\n${note}\n\n`;
      }

      if (problemData.samples && problemData.samples.length > 0) {
        fullMarkdown += `## Examples\n`;
        problemData.samples.forEach((sample, idx) => {
          fullMarkdown += `### Example #${idx + 1}\n`;
          fullMarkdown += `**Input**:\n\`\`\`\n${sample.input}\n\`\`\`\n`;
          fullMarkdown += `**Output**:\n\`\`\`\n${sample.output}\n\`\`\`\n\n`;
        });
      }

      navigator.clipboard.writeText(fullMarkdown.trim());
      setCopied(true);
      onShowToast('Original English problem (formatted Markdown) copied!', 'success');
    }

    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const topOffset = viewMode === 'bilingual' ? '12px' : '20px';

  return (
    <button
      onClick={handleCopy}
      style={{
        position: 'absolute',
        top: topOffset,
        right: '20px',
        zIndex: 10
      }}
      className="copy-ai-btn"
      title={lang === 'zh' ? '一键复制完整中文题面及样例数据' : 'Copy complete English problem statement and sample data'}
    >
      {copied ? (
        <>
          <Check size={13} />
          <span>{lang === 'zh' ? '已复制' : 'Copied'}</span>
        </>
      ) : (
        <>
          <Copy size={13} />
          <span>{lang === 'zh' ? '一键复制问AI' : 'Copy for AI'}</span>
        </>
      )}
    </button>
  );
};

interface MathJaxHtmlProps {
  html: string;
  className?: string;
}

interface MathJaxWindow extends Window {
  MathJax?: {
    typesetClear?: (elements: (HTMLElement | null)[]) => void;
    typesetPromise?: (elements: (HTMLElement | null)[]) => Promise<void>;
  };
}

const MathJaxHtml: React.FC<MathJaxHtmlProps> = React.memo(({ html, className }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const sanitizedHtml = React.useMemo(() => {
    return DOMPurify.sanitize(html || '');
  }, [html]);

  useEffect(() => {
    let isMounted = true;
    let pollCount = 0;
    const maxPolls = 100; // Poll for up to 5 seconds (50ms * 100)
    let pollInterval: number | undefined = undefined;

    const runTypeset = () => {
      const mathJax = (window as unknown as MathJaxWindow).MathJax;
      if (mathJax && mathJax.typesetPromise && containerRef.current) {
        try {
          if (mathJax.typesetClear) {
            mathJax.typesetClear([containerRef.current]);
          }
        } catch (e) {
          console.warn('MathJax typesetClear warning:', e);
        }

        mathJax.typesetPromise([containerRef.current])?.catch((err: unknown) => {
          console.error('MathJax rendering error:', err);
        });

        if (pollInterval) {
          clearInterval(pollInterval);
        }
        return true;
      }
      return false;
    };

    // Run immediately or start polling
    const success = runTypeset();
    if (!success) {
      pollInterval = window.setInterval(() => {
        if (!isMounted) {
          clearInterval(pollInterval);
          return;
        }
        pollCount++;
        runTypeset();
        if (pollCount >= maxPolls) {
          if (pollInterval) clearInterval(pollInterval);
        }
      }, 50);
    }

    return () => {
      isMounted = false;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [sanitizedHtml]);

  return <div ref={containerRef} className={className} dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
}, (prevProps, nextProps) => {
  return prevProps.html === nextProps.html;
});


interface ProblemContentProps {
  problemData: ProblemData;
  viewMode: 'bilingual' | 'chinese' | 'english';
  hasNote: boolean;
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

const ProblemContent = React.memo(({ problemData, viewMode, hasNote, onShowToast }: ProblemContentProps) => {
  return (
    <div className="tex2jax_process" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* 2. Reader Body */}
      <div className={`problem-reader-split ${viewMode !== 'bilingual' ? 'single-column' : ''}`}>

        {/* Chinese Content Column */}
        {(viewMode === 'bilingual' || viewMode === 'chinese') && (
          <div className="reader-column" style={{ position: 'relative' }}>
            {viewMode === 'bilingual' && <div className="column-header-tab">中文智能翻译</div>}

            <AICopyButton
              problemData={problemData}
              hasNote={hasNote}
              lang="zh"
              viewMode={viewMode}
              onShowToast={onShowToast}
            />

            {/* Title */}
            <div className="problem-html">
              <h2 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '16px', color: 'var(--primary)' }}>
                {problemData.translated.title}
              </h2>

              {/* Description */}
              <MathJaxHtml html={problemData.translated.description_html} />

              {/* Input format */}
              {problemData.translated.input_spec_html && (
                <>
                  <div className="section-subtitle">输入格式说明</div>
                  <MathJaxHtml html={problemData.translated.input_spec_html} />
                </>
              )}

              {/* Output format */}
              {problemData.translated.output_spec_html && (
                <>
                  <div className="section-subtitle">输出格式说明</div>
                  <MathJaxHtml html={problemData.translated.output_spec_html} />
                </>
              )}

              {/* Note/Hint */}
              {viewMode === 'chinese' && hasNote && (
                <>
                  <div className="section-subtitle">提示与说明</div>
                  <MathJaxHtml html={problemData.translated.note_html || problemData.note_html} />
                </>
              )}
            </div>
          </div>
        )}

        {/* English Content Column */}
        {(viewMode === 'bilingual' || viewMode === 'english') && (
          <div className="reader-column" style={{ position: 'relative' }}>
            {viewMode === 'bilingual' && <div className="column-header-tab en">Original English</div>}

            <AICopyButton
              problemData={problemData}
              hasNote={hasNote}
              lang="en"
              viewMode={viewMode}
              onShowToast={onShowToast}
            />

            <div className="problem-html">
              <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '16px', color: 'var(--text-primary)' }}>
                {problemData.title}
              </h2>

              <MathJaxHtml html={problemData.description_html} />

              {problemData.input_spec_html && (
                <>
                  <div className="section-subtitle" style={{ borderColor: 'var(--text-secondary)' }}>Input</div>
                  <MathJaxHtml html={problemData.input_spec_html} />
                </>
              )}

              {problemData.output_spec_html && (
                <>
                  <div className="section-subtitle" style={{ borderColor: 'var(--text-secondary)' }}>Output</div>
                  <MathJaxHtml html={problemData.output_spec_html} />
                </>
              )}

              {viewMode === 'english' && hasNote && (
                <>
                  <div className="section-subtitle" style={{ borderColor: 'var(--text-secondary)' }}>Note</div>
                  <MathJaxHtml html={problemData.note_html} />
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

                  <InteractiveSample
                    input={sample.input}
                    output={sample.output}
                    inputLinesData={sample.input_lines}
                    outputLinesData={sample.output_lines}
                    onShowToast={onShowToast}
                  />
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
                <MathJaxHtml html={problemData.translated.note_html || problemData.note_html} />
              </div>
              {/* English Note */}
              <div className="problem-html">
                <div className="column-header-tab en" style={{ marginBottom: '12px' }}>Original Note</div>
                <MathJaxHtml html={problemData.note_html} />
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
         prevProps.problemData === nextProps.problemData;
});

interface ProblemViewerProps {
  problemData: ProblemData;
  onRefresh: (newData?: ProblemData) => void;
  onShowToast: (message: string, type: 'success' | 'error') => void;
}

export const ProblemViewer: React.FC<ProblemViewerProps> = ({ problemData, onRefresh, onShowToast }) => {
  const [viewMode, setViewMode] = useState<'bilingual' | 'chinese' | 'english'>('chinese');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Submission / AC Sync States
  const [cfUser, setCfUser] = useState<{ cf_handle: string; cf_cookies_configured: boolean; ac_sync_configured?: boolean } | null>(null);
  const [compilerId, setCompilerId] = useState(() => localStorage.getItem('cf_compiler_id') || '89'); // Default to C++20 or memorized choice

  const handleForceRefresh = async () => {
    setIsRefreshing(true);
    onShowToast('正在为您重构并重新翻译题面，请稍候...', 'success');
    try {
      const response = await fetch(
        `${API_BASE}/api/problem/${problemData.contest_id}/${problemData.index}?force_refresh=true`
      );
      if (response.ok) {
        const newData = await response.json();
        onShowToast('重新翻译成功！已更新题面。', 'success');
        onRefresh(newData); // Directly update parent state with new data
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

  const checkUserConfig = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/config/user`);
      if (response.ok) {
        const data = await response.json();
        setCfUser(data);
      }
    } catch (error) {
      console.error('Failed to check user config:', error);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      checkUserConfig();
    }, 0);
    return () => clearTimeout(timer);
  }, [problemData, checkUserConfig]);

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
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Account Bind Meta */}
            {cfUser.cf_handle ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', backgroundColor: 'var(--primary-light)', borderRadius: '10px', border: '1px solid HSL(221, 83%, 92%)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                  <span style={{ color: 'var(--primary)', fontWeight: 700 }}>●</span>
                  <span style={{ color: 'var(--text-secondary)' }}>Codeforces 账号已连接:</span>
                  <strong style={{ color: 'var(--primary)', fontFamily: 'var(--font-sans)', fontWeight: 700 }}>{cfUser.cf_handle}</strong>
                </div>
                <span style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  已激活做题/AC状态同步
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px', backgroundColor: 'var(--bg-hover)', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>○</span>
                  <span>当前未配置 Codeforces 账号 (无法自动同步已 AC 状态)。</span>
                </div>
                <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                  您仍可正常使用下方按钮前往官网提交。如需在列表中同步您的做题记录与 AC 标记，请前往左侧边栏的 <strong>「管理后台 (设置)」</strong> 录入您的 Codeforces Handle。
                </span>
              </div>
            )}

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
