import os
from pathlib import Path
from typing import Optional

from sqlmodel import SQLModel, create_engine, Session


def _normalize_db_url(url: str) -> str:
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://") and not url.startswith("postgresql+psycopg://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def get_engine():
    database_url: Optional[str] = os.getenv("DATABASE_URL")
    if database_url:
        url = _normalize_db_url(database_url)
        connect_args = {}
    else:
        db_path = Path(os.getenv("API_DB_PATH", "data/app.db"))
        db_path.parent.mkdir(parents=True, exist_ok=True)
        url = f"sqlite:///{db_path}"
        connect_args = {"check_same_thread": False}
    return create_engine(url, connect_args=connect_args, pool_pre_ping=True)


engine = get_engine()


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
