import sys
import os

# Adjust path to find backend modules
sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))

try:
    from database import engine, SessionLocal, init_db, SystemConfig, LLMConfig, CachedProblem
    print("Imports succeeded.")
    
    # Try to initialize
    init_db()
    print("Database init_db() succeeded.")
    
    # Try to query
    db = SessionLocal()
    configs = db.query(SystemConfig).all()
    print(f"SystemConfig count: {len(configs)}")
    if len(configs) > 0:
        print(f"System Prompt preview: {configs[0].system_prompt[:50]}...")
        
    llms = db.query(LLMConfig).all()
    print(f"LLMConfig count: {len(llms)}")
    for l in llms:
        print(f" - LLM: {l.name}, Model: {l.model}, Priority: {l.priority}")
        
    db.close()
    print("Database schema check: SUCCESS")
except Exception as e:
    print(f"Database schema check: FAILED! Error: {str(e)}")
    # If the database is corrupted or has schema mismatch, let's delete the old SQLite file and re-init
    db_file = os.path.join("backend", "cf_mirror.db")
    if os.path.exists(db_file):
        print(f"Attempting to rebuild corrupted database: {db_file}")
        try:
            db.close()
        except:
            pass
        try:
            os.remove(db_file)
            print("Successfully deleted old database file.")
            from database import init_db
            init_db()
            print("Successfully re-initialized database with clean schemas!")
        except Exception as delete_err:
            print(f"Failed to delete/rebuild database: {str(delete_err)}")
