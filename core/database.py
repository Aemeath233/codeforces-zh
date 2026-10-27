import datetime
import os
import sqlite3

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    event,
    inspect,
    text,
)
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .paths import get_data_path


class Base(DeclarativeBase):
    pass

# In source mode this stays at CF/cf_mirror.db. In a frozen desktop
# build it moves to a writable user data directory so the database persists.
db_path = str(get_data_path("cf_mirror.db"))
db_url_path = db_path.replace("\\", "/")
DATABASE_URL = f"sqlite:///{db_url_path}"


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
    batch_cooldown = Column(Integer, nullable=True, default=60)
    problemset_updated_at = Column(DateTime, nullable=True)

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

class ProblemTag(Base):
    __tablename__ = "problem_tag"
    problem_id = Column(String(50), primary_key=True, index=True)
    tag = Column(String(100), primary_key=True, index=True)

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
    translation_status = Column(String(20), nullable=False, default="original")
    
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), index=True)

class ContestCache(Base):
    __tablename__ = "contest_cache"
    id = Column(Integer, primary_key=True, default=1)
    data_json = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None))


class UserStatusCache(Base):
    __tablename__ = "user_status_cache"
    handle = Column(String(100), primary_key=True)
    status_json = Column(Text, nullable=False)
    updated_at = Column(DateTime, nullable=False)

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False, "timeout": 30}, pool_pre_ping=True)


@event.listens_for(engine, "connect")
def configure_sqlite(connection, _):
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=30000")


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    if os.path.exists(db_path):
        backup_path = db_path + ".before-v02.db.bak"
        inspector = inspect(engine)
        if inspector.has_table("cached_problem") and not os.path.exists(backup_path):
            columns = {c["name"] for c in inspector.get_columns("cached_problem")}
            if "translation_status" not in columns:
                with sqlite3.connect(db_path) as source, sqlite3.connect(backup_path) as backup:
                    source.backup(backup)
    Base.metadata.create_all(bind=engine)
    
    # Inspect first: do not hide unrelated migration or database errors.
    with engine.begin() as conn:
        migrations = {
            "system_config": {"cf_handle": "VARCHAR(100)", "batch_cooldown": "INTEGER DEFAULT 60",
                              "cf_cookies": "TEXT", "problemset_updated_at": "DATETIME"},
            "cached_problem": {"translation_status": "VARCHAR(20) NOT NULL DEFAULT 'translated'"},
        }
        for table, columns in migrations.items():
            existing = {c["name"] for c in inspect(conn).get_columns(table)}
            for name, definition in columns.items():
                if name not in existing:
                    conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {definition}'))
        # Preserve original statements while retiring misleading legacy mock translations.
        conn.execute(text("""UPDATE cached_problem SET translation_status='original',
            translated_title=NULL, translated_description_html=NULL, translated_input_spec_html=NULL,
            translated_output_spec_html=NULL, translated_note_html=NULL
            WHERE translated_description_html IS NULL OR translated_description_html = ''
            OR instr(translated_description_html, '(模拟描述)') > 0
            OR instr(translated_description_html, '模拟翻译模式') > 0"""))
            
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
            # Create FTS5 virtual table for problem names
            conn.execute(text("CREATE VIRTUAL TABLE IF NOT EXISTS problem_fts USING fts5(problem_id UNINDEXED, name);"))
    finally:
        db.close()

# get_db() generator removed — was FastAPI legacy, unused in Flask.

def get_flask_db():
    from flask import g
    if 'db' not in g:
        g.db = SessionLocal()
    return g.db


def create_cached_problem(problem_id, contest_id, index, scraped_data, translated_data):
    """Factory function for constructing a CachedProblem from scraped + translated dicts."""
    return CachedProblem(
        id=problem_id,
        contest_id=contest_id,
        index=index,
        title=scraped_data["title"],
        time_limit=scraped_data["time_limit"],
        memory_limit=scraped_data["memory_limit"],
        input_file=scraped_data["input_file"],
        output_file=scraped_data["output_file"],
        description_html=scraped_data["description_html"],
        input_spec_html=scraped_data["input_spec_html"],
        output_spec_html=scraped_data["output_spec_html"],
        samples_json=scraped_data["samples_json"],
        note_html=scraped_data["note_html"],
        translated_title=translated_data.get("translated_title"),
        translated_description_html=translated_data.get("translated_description_html"),
        translated_input_spec_html=translated_data.get("translated_input_spec_html"),
        translated_output_spec_html=translated_data.get("translated_output_spec_html"),
        translated_note_html=translated_data.get("translated_note_html"),
        translation_status="translated" if translated_data else "original"
    )
