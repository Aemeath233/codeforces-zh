import React, { useState, useEffect, useCallback } from 'react';
import { Save, Plus, Trash2, Edit2, Play, CheckCircle2, AlertCircle, ToggleLeft, ToggleRight, User, ShieldCheck } from 'lucide-react';
import { API_BASE } from './api';

interface LLMConfig {
  id?: number;
  name: string;
  api_key_masked?: string;
  api_key_configured?: boolean;
  api_key?: string;
  base_url: string;
  model: string;
  priority: number;
  is_active: boolean;
}

interface AdminSettingsProps {
  onShowToast: (message: string, type: 'success' | 'error') => void;
  onUserConfigSaved?: () => void;
}

export const AdminSettings: React.FC<AdminSettingsProps> = ({ onShowToast, onUserConfigSaved }) => {
  const [llmConfigs, setLlmConfigs] = useState<LLMConfig[]>([]);
  const [systemPrompt, setSystemPrompt] = useState('');

  // Codeforces user account states
  const [cfHandle, setCfHandle] = useState('');
  const [cfCookies, setCfCookies] = useState('');
  const [cfCookiesConfigured, setCfCookiesConfigured] = useState(false);
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Form states for creating / editing an LLM node
  const [editingNode, setEditingNode] = useState<LLMConfig | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  // Single node form states
  const [formName, setFormName] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formPriority, setFormPriority] = useState(1);
  const [formIsActive, setFormIsActive] = useState(true);

  // Connection testing states per node ID
  const [testStatus, setTestStatus] = useState<{ [key: number]: { loading: boolean; success?: boolean; reply?: string } }>({});

  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const [isSavingNode, setIsSavingNode] = useState(false);

  const fetchSystemPrompt = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/config/system_prompt`);
      if (response.ok) {
        const data = await response.json();
        setSystemPrompt(data.system_prompt || '');
      }
    } catch (e) {
      console.error(e);
      onShowToast('获取系统提示词失败', 'error');
    }
  }, [onShowToast]);

  const fetchLLMConfigs = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/config/llm`);
      if (response.ok) {
        const data = await response.json();
        setLlmConfigs(data || []);
      }
    } catch (e) {
      console.error(e);
      onShowToast('获取 API 节点列表失败', 'error');
    }
  }, [onShowToast]);

  const fetchUserAuth = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/config/user`);
      if (response.ok) {
        const data = await response.json();
        setCfHandle(data.cf_handle || '');
        setCfCookiesConfigured(data.cf_cookies_configured || false);
        setCfCookies(data.cf_cookies_configured ? '****' : '');
      }
    } catch (e) {
      console.error(e);
      onShowToast('获取用户登录状态失败', 'error');
    }
  }, [onShowToast]);

  const fetchData = useCallback(async () => {
    await fetchSystemPrompt();
    await fetchLLMConfigs();
    await fetchUserAuth();
  }, [fetchSystemPrompt, fetchLLMConfigs, fetchUserAuth]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchData();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchData]);

  const handleSavePrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingPrompt(true);
    try {
      const response = await fetch(`${API_BASE}/api/config/system_prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_prompt: systemPrompt })
      });
      if (response.ok) {
        onShowToast('系统翻译提示词保存成功！', 'success');
      } else {
        onShowToast('系统提示词保存失败', 'error');
      }
    } catch (e) {
      console.error(e);
      onShowToast('网络错误，无法保存提示词', 'error');
    } finally {
      setIsSavingPrompt(false);
    }
  };

  const handleSaveUserAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cfHandle) {
      onShowToast('用户名 (Handle) 不能为空！', 'error');
      return;
    }

    setIsSavingUser(true);
    try {
      const response = await fetch(`${API_BASE}/api/config/user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cf_handle: cfHandle,
          cf_cookies: cfCookies === '****' ? null : cfCookies
        })
      });
      if (response.ok) {
        onShowToast('Codeforces 登录凭证保存成功！做题状态同步功能已激活。', 'success');
        fetchUserAuth();
        if (onUserConfigSaved) {
          onUserConfigSaved();
        }
      } else {
        onShowToast('保存登录凭证失败', 'error');
      }
    } catch (e) {
      console.error(e);
      onShowToast('网络错误，保存凭证失败', 'error');
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleOpenAddForm = () => {
    setEditingNode(null);
    setFormName('');
    setFormApiKey('');
    setFormBaseUrl('https://api.openai.com/v1');
    setFormModel('gpt-4o-mini');
    setFormPriority(llmConfigs.length + 1);
    setFormIsActive(true);
    setIsFormOpen(true);
  };

  const handleOpenEditForm = (node: LLMConfig) => {
    setEditingNode(node);
    setFormName(node.name);
    setFormApiKey(node.api_key_configured ? '****' : '');
    setFormBaseUrl(node.base_url);
    setFormModel(node.model);
    setFormPriority(node.priority);
    setFormIsActive(node.is_active);
    setIsFormOpen(true);
  };

  const handleSaveNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName) {
      onShowToast('请填写节点标识名称！', 'error');
      return;
    }

    setIsSavingNode(true);
    try {
      const response = await fetch(`${API_BASE}/api/config/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingNode?.id || null,
          name: formName,
          api_key: formApiKey === '****' ? null : formApiKey,
          base_url: formBaseUrl,
          model: formModel,
          priority: formPriority,
          is_active: formIsActive
        })
      });

      if (response.ok) {
        onShowToast(editingNode ? 'API 节点已更新！' : 'API 节点添加成功！', 'success');
        setIsFormOpen(false);
        fetchLLMConfigs();
      } else {
        onShowToast('保存 API 节点失败', 'error');
      }
    } catch (e) {
      console.error(e);
      onShowToast('网络错误，保存节点失败', 'error');
    } finally {
      setIsSavingNode(false);
    }
  };

  const handleDeleteNode = async (id: number) => {
    if (!window.confirm('您确定要删除这个 API 节点吗？')) return;
    try {
      const response = await fetch(`${API_BASE}/api/config/llm/${id}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        onShowToast('API 节点已成功移除！', 'success');
        fetchLLMConfigs();
      } else {
        onShowToast('移除 API 节点失败', 'error');
      }
    } catch (e) {
      console.error(e);
      onShowToast('网络错误，删除失败', 'error');
    }
  };

  const handleToggleActive = async (node: LLMConfig) => {
    try {
      const response = await fetch(`${API_BASE}/api/config/llm`, {
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
        onShowToast(`${node.name} 已${!node.is_active ? '启用' : '禁用'}`, 'success');
        fetchLLMConfigs();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTestNode = async (node: LLMConfig) => {
    if (!node.id) return;

    setTestStatus((prev) => ({
      ...prev,
      [node.id!]: { loading: true }
    }));
    onShowToast(`正在向 ${node.name} 发送轻量级 token 测试连接...`, 'success');

    try {
      const response = await fetch(`${API_BASE}/api/config/test`, {
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
        setTestStatus((prev) => ({
          ...prev,
          [node.id!]: { loading: false, success: true, reply: data.reply }
        }));
        onShowToast(`测试成功！大模型已成功响应。`, 'success');
      } else {
        setTestStatus((prev) => ({
          ...prev,
          [node.id!]: { loading: false, success: false, reply: data.detail || '接口连接失败，请检查配置' }
        }));
        onShowToast(`测试失败：${data.detail || '无法连接'}`, 'error');
      }
    } catch (e) {
      console.error(e);
      setTestStatus((prev) => ({
        ...prev,
        [node.id!]: { loading: false, success: false, reply: '网络错误，无法连接接口' }
      }));
      onShowToast('连接测试失败，请检查本地后端状态。', 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

      {/* Page Header */}
      <div className="page-header">
        <h1 className="page-title">管理后台 (控制与配置)</h1>
        <p className="page-subtitle">配置您的多个大模型 API 以及 Codeforces 登录凭证，开启无缝翻译与做题状态/AC状态自动同步体验。</p>
      </div>

      {/* Codeforces Account Form */}
      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '32px', boxShadow: 'var(--shadow-premium)' }}>
        <h2 className="panel-title" style={{ border: 'none', padding: 0, marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <User size={20} style={{ color: 'var(--primary)' }} />
          Codeforces 账户导入与登录凭证设置 (用于同步做题/AC状态)
        </h2>

        <form onSubmit={handleSaveUserAuth} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="form-group" style={{ maxWidth: '400px' }}>
              <label className="form-label" htmlFor="cfHandle">
                CF 用户名 (Handle) *
              </label>
              <input
                id="cfHandle"
                type="text"
                className="form-input"
                placeholder="例如: tourist"
                value={cfHandle}
                onChange={(e) => setCfHandle(e.target.value)}
                required
              />
              <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', display: 'inline-block' }}>
                仅需填写用户名即可自动同步并标记已通过的题目，无需输入密码或 Cookie。
              </span>
            </div>

            {/* Advanced Section Toggle */}
            <div style={{ marginTop: '4px' }}>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="btn-secondary"
                style={{ padding: '6px 12px', fontSize: '12.5px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                {showAdvanced ? '隐藏高级设置 (Cookie)' : '显示高级设置 (Cookie 保留用途)'}
              </button>
            </div>

            {showAdvanced && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                  padding: '20px',
                  backgroundColor: 'var(--bg-hover)',
                  borderRadius: '12px',
                  border: '1px solid var(--border-color)',
                  marginTop: '4px'
                }}
              >
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label" htmlFor="cfCookies">
                    浏览器登录 Cookies (高级保留用途 - 默认留空)
                  </label>
                  <input
                    id="cfCookies"
                    type="password"
                    className="form-input"
                    placeholder={cfCookiesConfigured ? `已导入 Cookies: **** (粘贴新值可进行覆盖)` : "通常留空即可。如需保留以作未来接口代理提交等高级用途，请粘贴您的 Cookie"}
                    value={cfCookies}
                    onChange={(e) => setCfCookies(e.target.value)}
                  />
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  💡 <b>两步教您如何快速获取 Cookies 字符串：</b>
                  <ol style={{ marginLeft: '20px', marginTop: '6px' }}>
                    <li>用 Chrome/Edge 浏览器打开并登录 <a href="https://codeforces.com" target="_blank" rel="noreferrer" style={{ color: 'var(--primary)', fontWeight: 600 }}>codeforces.com</a>。</li>
                    <li>按键盘 <b>F12</b> 键打开开发者工具 &rarr; 切换到顶部的 <b>“控制台 (Console)”</b> &rarr; 输入 <code>document.cookie</code> 回车 &rarr; **复制返回的整段带引号的字符串文本**，直接贴到上面的输入框即可！</li>
                  </ol>
                  {cfCookiesConfigured && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--success)', marginTop: '8px', fontWeight: 600 }}>
                      <ShieldCheck size={16} /> 本地 Cookie 凭证已导入（目前代理提交默认关闭，Cookie 仅作为高级用途保留）。
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <button type="submit" disabled={isSavingUser} className="search-button" style={{ width: 'fit-content', padding: '10px 24px' }}>
            {isSavingUser ? '正在保存凭证...' : '保存登录凭证'}
          </button>
        </form>
      </div>

      {/* LLM Node list and active controls */}
      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '32px', boxShadow: 'var(--shadow-premium)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h2 className="panel-title" style={{ border: 'none', padding: 0, marginBottom: 0 }}>
            🔗 智能翻译大模型节点链 (API Fallback Chain)
          </h2>
          <button className="search-button" onClick={handleOpenAddForm} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 18px' }}>
            <Plus size={16} />
            添加 API 节点
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {llmConfigs.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-color)', borderRadius: '10px' }}>
              当前暂未配置任何大模型 API 节点。请点击右上角按钮添加。
            </div>
          ) : (
            llmConfigs.map((node) => (
              <div key={node.id} style={{ border: '1px solid var(--border-color)', borderRadius: '10px', padding: '20px', backgroundColor: node.is_active ? 'var(--bg-card)' : 'var(--bg-hover)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button onClick={() => handleToggleActive(node)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: node.is_active ? 'var(--primary)' : 'var(--text-muted)' }}>
                      {node.is_active ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
                    </button>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, fontSize: '16px', color: node.is_active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                          {node.name}
                        </span>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'white', backgroundColor: 'var(--primary)', padding: '2px 8px', borderRadius: '4px' }}>
                          优先度: {node.priority}
                        </span>
                      </div>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        模型: <code>{node.model}</code> | 网关: <code>{node.base_url}</code>
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn-secondary"
                      onClick={() => handleTestNode(node)}
                      disabled={testStatus[node.id!]?.loading}
                      style={{ padding: '8px 12px' }}
                    >
                      <Play size={14} />
                      测试
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => handleOpenEditForm(node)}
                      style={{ padding: '8px 12px' }}
                    >
                      <Edit2 size={14} />
                      修改
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => handleDeleteNode(node.id!)}
                      style={{ padding: '8px 12px', color: 'var(--danger)', borderColor: 'var(--danger-bg)' }}
                    >
                      <Trash2 size={14} />
                      删除
                    </button>
                  </div>
                </div>

                {testStatus[node.id!] && (
                  <div style={{
                    padding: '12px 16px',
                    borderRadius: '6px',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    backgroundColor: testStatus[node.id!]?.loading
                      ? 'var(--bg-main)'
                      : testStatus[node.id!]?.success
                      ? 'var(--success-bg)'
                      : 'var(--danger-bg)',
                    color: testStatus[node.id!]?.loading
                      ? 'var(--text-primary)'
                      : testStatus[node.id!]?.success
                      ? 'var(--success)'
                      : 'var(--danger)',
                    border: '1px solid ' + (testStatus[node.id!]?.loading ? 'var(--border-color)' : testStatus[node.id!]?.success ? 'rgba(22, 101, 52, 0.2)' : 'rgba(153, 27, 27, 0.2)')
                  }}>
                    {testStatus[node.id!]?.loading ? (
                      <>
                        <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px' }}></div>
                        <span>正在发送轻量级 token 测试连接...</span>
                      </>
                    ) : testStatus[node.id!]?.success ? (
                      <>
                        <CheckCircle2 size={16} />
                        <span>连接成功！大模型响应内容: <b>“{testStatus[node.id!]?.reply}”</b> (连通性完美)</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle size={16} />
                        <span>连接失败！故障详情: <code>{testStatus[node.id!]?.reply}</code></span>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Add / Edit Node Popup inline Form */}
      {isFormOpen && (
        <form onSubmit={handleSaveNode} className="settings-form" style={{ border: '2px solid var(--primary)' }}>
          <h3 className="panel-title" style={{ border: 'none', padding: 0 }}>
            {editingNode ? '⚙️ 修改 API 节点参数' : '➕ 添加全新大模型 API 节点'}
          </h3>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="form-group">
              <label className="form-label">节点名称</label>
              <input
                type="text"
                className="form-input"
                placeholder="例如：主线 DeepSeek-V3 或 备用 Gemini"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">优先度 (数字越小越先尝试)</label>
              <input
                type="number"
                className="form-input"
                min="1"
                max="10"
                value={formPriority}
                onChange={(e) => setFormPriority(parseInt(e.target.value, 10) || 1)}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">API Key</label>
            <input
              type="password"
              className="form-input"
              placeholder={editingNode?.api_key_configured ? "已保存: **** (输入新密码将覆盖)" : "请输入该节点的 API Key (sk-...)"}
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="form-group">
              <label className="form-label">API Base URL</label>
              <input
                type="text"
                className="form-input"
                placeholder="https://api.openai.com/v1"
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">模型名称 (Model Name)</label>
              <input
                type="text"
                className="form-input"
                placeholder="gpt-4o-mini / deepseek-chat / gemini-2.5-flash"
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                required
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button type="submit" disabled={isSavingNode} className="search-button">
              {isSavingNode ? '正在保存...' : '确认并保存节点'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setIsFormOpen(false)} style={{ padding: '12px 20px' }}>
              取消
            </button>
          </div>
        </form>
      )}

      {/* Global prompt tuner */}
      <form onSubmit={handleSavePrompt} className="settings-form">
        <h2 className="panel-title" style={{ border: 'none', padding: 0, marginBottom: 0 }}>
          ⚙️ 算法题翻译系统提示词 (System Prompt)
        </h2>
        <div className="form-group">
          <textarea
            className="form-input textarea"
            style={{ minHeight: '180px' }}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            required
          />
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            此系统提示词规定了所有 API 节点的大模型在翻译题目时的指令，强制其**绝对保留 LaTeX 数学公式和 HTML 标签**，确保排版完美。
          </span>
        </div>
        <button type="submit" disabled={isSavingPrompt} className="search-button" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 18px', width: 'fit-content' }}>
          <Save size={16} />
          {isSavingPrompt ? '正在保存...' : '保存系统提示词'}
        </button>
      </form>
    </div>
  );
};
