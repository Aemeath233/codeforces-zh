import os
import datetime
import json
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, Boolean, Index, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from .paths import get_data_path

Base = declarative_base()

# In source mode this stays at CF/cf_mirror.db. In a frozen desktop
# build it moves to a writable user data directory so the database persists.
db_path = str(get_data_path("cf_mirror.db"))
DATABASE_URL = f"sqlite:///{db_path.replace('\\', '/')}"


class SystemConfig(Base):
    __tablename__ = "system_config"
    id = Column(Integer, primary_key=True, default=1)
    system_prompt = Column(Text, nullable=True, default=(
        "你是一个专业的算法竞赛翻译助手。你的任务是将 Codeforces 上的英文算法题翻译成专业、通俗易懂的中文题面。\n"
        "请严格遵守以下翻译规范：\n"
        "1. 严格保留所有的 LaTeX 数学公式（即被 $ 或 $$ 包裹的部分），绝对不要修改公式内部的任何字符，更不能删除或修改公式中的花括号 {} 和反斜杠 \\\\（例如，像 \\\\color{red}、\\\\color{green}、\\\\frac{a}{b} 这样的公式控制命令，必须保持原样，不能变成 \\\\colorred 或 \\\\colorgreen）。\n"
        "2. 保留段落的 HTML 标签（如 <p>, <ul>, <li>, <pre>, <code> 等）以保证排版格式不受损，只翻译标签内的英文文本。\n"
        "3. 翻译专业学术术语时要符合中文算法竞赛的习惯。例如：\n"
        "   - array -> 数组 / 序列\n"
        "   - string -> 字符串\n"
        "   - subsequence -> 子序列\n"
        "   - query -> 查询 / 询问\n"
        "   - graph -> 图\n"
        "   - tree -> 树\n"
        "   - dynamic programming -> 动态规划\n"
        "   - segment tree -> 线段树\n"
        "   - vertex / node -> 节点 / 顶点\n"
        "   - test case / testcase -> 测试用例 (请注意：在翻译提示说明(Note)时，绝对不要将 'test case' 翻译为 '样例'，因为 '样例' 专属代表 'Example' 模块。翻译为 '样例' 会使用户误以为遗漏了输入输出样例。请统一翻译为 '测试用例' 或 '测试数据')\n"
        "4. 输出风格要严谨、流畅，通俗易懂，符合中国选手的中文阅读习惯。"
    ))
    cf_handle = Column(String(100), nullable=True)  # User's Codeforces Username / Handle
    cf_cookies = Column(Text, nullable=True)        # Raw Codeforces Cookie string

class LLMConfig(Base):
    __tablename__ = "llm_config"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    api_key = Column(String(255), nullable=True)
    base_url = Column(String(255), nullable=True, default="https://api.openai.com/v1")
    model = Column(String(100), nullable=True, default="gpt-4o-mini")
    priority = Column(Integer, default=1)
    is_active = Column(Boolean, default=True)

class ProblemsetLibrary(Base):
    __tablename__ = "problemset_library"
    id = Column(String(50), primary_key=True)
    contest_id = Column(Integer, nullable=False, index=True)
    index = Column(String(10), nullable=False)
    name = Column(String(255), nullable=False, index=True)
    rating = Column(Integer, nullable=True, index=True)
    solved_count = Column(Integer, default=0)
    tags_json = Column(Text, default="[]")

    __table_args__ = (
        Index('idx_contest_index', 'contest_id', 'index'),
    )

class CachedProblem(Base):
    __tablename__ = "cached_problem"
    id = Column(String(50), primary_key=True)
    contest_id = Column(Integer, nullable=False)
    index = Column(String(10), nullable=False)
    
    # Original English content
    title = Column(String(255), nullable=False)
    time_limit = Column(String(100))
    memory_limit = Column(String(100))
    input_file = Column(String(100))
    output_file = Column(String(100))
    description_html = Column(Text)
    input_spec_html = Column(Text)
    output_spec_html = Column(Text)
    samples_json = Column(Text)
    note_html = Column(Text)
    
    # Translated Chinese content
    translated_title = Column(String(255))
    translated_description_html = Column(Text)
    translated_input_spec_html = Column(Text)
    translated_output_spec_html = Column(Text)
    translated_note_html = Column(Text)
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)

class ContestCache(Base):
    __tablename__ = "contest_cache"
    id = Column(Integer, primary_key=True, default=1)
    data_json = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    Base.metadata.create_all(bind=engine)
    
    # Safely migrate existing tables by adding missing columns if they do not exist
    with engine.begin() as conn:
        try:
            conn.execute(text("ALTER TABLE system_config ADD COLUMN cf_handle VARCHAR(100);"))
        except Exception:
            pass  # Already exists
        try:
            conn.execute(text("ALTER TABLE system_config ADD COLUMN cf_cookies TEXT;"))
        except Exception:
            pass  # Already exists
            
    db = SessionLocal()
    try:
        # Create default config if not exists
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            config = SystemConfig(id=1)
            db.add(config)
            
        # Create a default LLM config if table is empty
        llm_count = db.query(LLMConfig).count()
        if llm_count == 0:
            default_llm = LLMConfig(
                name="主线模型 (API A)",
                api_key="your_api_key_here",
                base_url="https://api.openai.com/v1",
                model="gpt-4o-mini",
                priority=1,
                is_active=True
            )
            db.add(default_llm)
            
        db.commit()

        # Safely create performance indexes using raw SQL for existing databases
        with engine.begin() as conn:
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_cached_problem_created_at ON cached_problem (created_at DESC);"))
            conn.execute(text('CREATE INDEX IF NOT EXISTS idx_problemset_library_contest_index ON problemset_library (contest_id DESC, "index" ASC);'))
    finally:
        db.close()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_flask_db():
    from flask import g
    if 'db' not in g:
        g.db = SessionLocal()
    return g.db
