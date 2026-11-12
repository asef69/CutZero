"""Run history. PostgreSQL when DATABASE_URL is set, otherwise a local SQLite file."""

from __future__ import annotations

import datetime as dt
import os
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, create_engine, func, select 
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        return f"sqlite:///{Path(__file__).resolve().parents[1] / 'cutzero.db'}"
    # Hosting platforms hand out postgres:// URLs; SQLAlchemy needs an explicit driver.
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://") :]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


DATABASE_URL = _database_url()
_engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: dt.datetime.now(dt.timezone.utc), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    preset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    piece_count: Mapped[int] = mapped_column(Integer)
    roll_width_mm: Mapped[float] = mapped_column(Float)
    kerf_mm: Mapped[float] = mapped_column(Float)
    fabric_gsm: Mapped[float] = mapped_column(Float)
    batch_count: Mapped[int] = mapped_column(Integer)
    co2_factor: Mapped[float] = mapped_column(Float)
    max_iterations: Mapped[int] = mapped_column(Integer)
    allowed_rotations_deg: Mapped[list[float]] = mapped_column(JSON)
    baseline_length_mm: Mapped[float] = mapped_column(Float)
    optimized_length_mm: Mapped[float] = mapped_column(Float)
    baseline_utilization_pct: Mapped[float] = mapped_column(Float)
    optimized_utilization_pct: Mapped[float] = mapped_column(Float)
    linear_saved_m: Mapped[float] = mapped_column(Float)
    waste_saved_kg_per_batch: Mapped[float] = mapped_column(Float)
    co2_saved_kg_per_batch: Mapped[float] = mapped_column(Float)
    solve_ms: Mapped[float] = mapped_column(Float)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    min_clearance_mm: Mapped[float | None] = mapped_column(Float, nullable=True)
    pieces: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    baseline_layout: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    optimized_layout: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON)


SUMMARY_FIELDS = (
    "id",
    "name",
    "preset_id",
    "piece_count",
    "roll_width_mm",
    "kerf_mm",
    "fabric_gsm",
    "batch_count",
    "max_iterations",
    "allowed_rotations_deg",
    "baseline_length_mm",
    "optimized_length_mm",
    "baseline_utilization_pct",
    "optimized_utilization_pct",
    "linear_saved_m",
    "waste_saved_kg_per_batch",
    "co2_saved_kg_per_batch",
    "solve_ms",
    "verified",
    "min_clearance_mm",
)


def init_db() -> None:
    Base.metadata.create_all(_engine)


def job_summary(job: Job) -> dict[str, Any]:
    out = {name: getattr(job, name) for name in SUMMARY_FIELDS}
    out["created_at"] = job.created_at.isoformat()
    return out


def job_full(job: Job) -> dict[str, Any]:
    out = job_summary(job)
    out.update(
        co2_factor=job.co2_factor,
        pieces=job.pieces,
        baseline_layout=job.baseline_layout,
        optimized_layout=job.optimized_layout,
        stats=job.stats,
    )
    return out


def save_job(fields: dict[str, Any]) -> str:
    with SessionLocal() as session:
        job = Job(**fields)
        session.add(job)
        session.commit()
        return job.id


def get_job(job_id: str) -> dict[str, Any] | None:
    with SessionLocal() as session:
        job = session.get(Job, job_id)
        return job_full(job) if job else None


def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    with SessionLocal() as session:
        rows = session.scalars(select(Job).order_by(Job.created_at.desc()).limit(limit)).all()
        return [job_summary(j) for j in rows]


def aggregate_stats() -> dict[str, Any]:
    with SessionLocal() as session:
        row = session.execute(
            select(
                func.count(Job.id),
                func.coalesce(func.sum(Job.waste_saved_kg_per_batch), 0.0),
                func.coalesce(func.sum(Job.co2_saved_kg_per_batch), 0.0),
                func.coalesce(func.avg(Job.optimized_utilization_pct - Job.baseline_utilization_pct), 0.0),
            )
        ).one()
    return {
        "runs": row[0],
        "waste_saved_kg": row[1],
        "co2_saved_kg": row[2],
        "avg_utilization_gain_pct": row[3],
        "backend": "postgresql" if DATABASE_URL.startswith("postgresql") else "sqlite",
    }
