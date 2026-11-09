"""Database initialization shared by SQLite development and PostgreSQL deployment."""

from sqlalchemy import create_engine, event
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from health_agent.config import Settings
from health_agent.models import Base, Profile


def upsert_insert(table, dialect: str):
    return (sqlite_insert if dialect == "sqlite" else postgres_insert)(table)


def initialize_database(settings: Settings):
    options = {"pool_pre_ping": True, "hide_parameters": True}
    if settings.database_url.startswith("sqlite"):
        options["connect_args"] = {"check_same_thread": False, "timeout": 30}
        if settings.database_url.endswith(":memory:") or settings.database_url in {
            "sqlite://",
            "sqlite+pysqlite://",
        }:
            options["poolclass"] = StaticPool
    engine = create_engine(settings.database_url, **options)
    if engine.dialect.name == "sqlite":

        @event.listens_for(engine, "connect")
        def configure_sqlite(connection, _record):
            connection.execute("PRAGMA busy_timeout=30000")

    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory.begin() as session:
        statement = upsert_insert(Profile, engine.dialect.name).values(
            id=1, timezone=settings.timezone
        )
        session.execute(statement.on_conflict_do_nothing(index_elements=["id"]))
    return engine, factory
