"""Transactional writes and provenance-preserving local-day calculations."""

import hashlib
import json
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from health_agent.db import upsert_insert
from health_agent.models import DailyObservation, Meal, Profile
from health_agent.schemas import MealCreate, MealUpdate, Metric, ProfileUpdate, SyncRequest

NUTRITION_FIELDS = ("calories_kcal", "protein_g", "carbs_g", "fat_g")
GOAL_FIELDS = (
    "calorie_goal_kcal",
    "protein_goal_g",
    "steps_goal",
    "sleep_goal_minutes",
    "target_weight_kg",
)
MEAL_FIELDS = ("eaten_at", "description", *NUTRITION_FIELDS, "client_request_id")


def get_profile(session: Session) -> Profile:
    return session.get(Profile, 1)


def profile_json(profile: Profile) -> dict:
    return {"timezone": profile.timezone, **{key: getattr(profile, key) for key in GOAL_FIELDS}}


def update_profile(session: Session, patch: ProfileUpdate) -> dict:
    profile = get_profile(session)
    for key, value in patch.model_dump(exclude_unset=True).items():
        setattr(profile, key, value)
    session.commit()
    return profile_json(profile)


def as_utc(value: datetime) -> datetime:
    # SQLite removes timezone metadata; every stored timestamp is normalized to UTC.
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def meal_json(meal: Meal) -> dict:
    return {
        "id": meal.id,
        **{key: getattr(meal, key) for key in MEAL_FIELDS},
        "eaten_at": as_utc(meal.eaten_at).isoformat().replace("+00:00", "Z"),
    }


def request_fingerprint(payload: MealCreate) -> str:
    data = payload.model_dump(mode="json")
    data["eaten_at"] = as_utc(payload.eaten_at).isoformat()
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def check_retry(existing: Meal, fingerprint: str) -> dict:
    if existing.deleted_at is not None:
        raise HTTPException(409, "client_request_id belongs to a deleted meal")
    if existing.request_fingerprint != fingerprint:
        raise HTTPException(409, "client_request_id was already used for a different meal payload")
    return meal_json(existing)


def create_meal(session: Session, payload: MealCreate) -> tuple[dict, bool]:
    fingerprint = request_fingerprint(payload)
    existing = session.scalar(
        select(Meal).where(Meal.client_request_id == payload.client_request_id)
    )
    if existing is not None:
        return check_retry(existing, fingerprint), False
    record = Meal(
        **{**payload.model_dump(), "eaten_at": as_utc(payload.eaten_at)},
        request_fingerprint=fingerprint,
    )
    session.add(record)
    try:
        session.commit()
    except IntegrityError:
        # A concurrent retry may win the unique constraint after our first read.
        session.rollback()
        existing = session.scalar(
            select(Meal).where(Meal.client_request_id == payload.client_request_id)
        )
        if existing is None:
            raise
        return check_retry(existing, fingerprint), False
    return meal_json(record), True


def existing_meal(session: Session, meal_id: int) -> Meal:
    record = session.get(Meal, meal_id)
    if record is None or record.deleted_at is not None:
        raise HTTPException(404, "meal not found")
    return record


def update_meal(session: Session, meal_id: int, patch: MealUpdate) -> dict:
    record = existing_meal(session, meal_id)
    for key, value in patch.model_dump(exclude_unset=True).items():
        setattr(record, key, as_utc(value) if key == "eaten_at" else value)
    session.commit()
    return meal_json(record)


def delete_meal(session: Session, meal_id: int) -> None:
    record = existing_meal(session, meal_id)
    record.deleted_at = datetime.now(UTC)
    session.commit()


def validate_date_range(start: date, end: date) -> tuple[date, date]:
    if start > end:
        raise HTTPException(422, "start must be on or before end")
    if not 1900 <= start.year <= end.year <= 9998:
        raise HTTPException(422, "date years must be between 1900 and 9998")
    if (end - start).days >= 366:
        raise HTTPException(422, "date range may contain at most 366 inclusive days")
    return start, end


def local_today(timezone: str) -> date:
    return datetime.now(ZoneInfo(timezone)).date()


def local_boundaries(start: date, end: date, timezone: str) -> tuple[datetime, datetime]:
    validate_date_range(start, end)
    zone = ZoneInfo(timezone)
    return (
        datetime.combine(start, time.min, zone).astimezone(UTC),
        datetime.combine(end + timedelta(days=1), time.min, zone).astimezone(UTC),
    )


def list_meals(session: Session, start: date, end: date, timezone: str) -> list[dict]:
    first, after_last = local_boundaries(start, end, timezone)
    query = (
        select(Meal)
        .where(Meal.deleted_at.is_(None), Meal.eaten_at >= first, Meal.eaten_at < after_last)
        .order_by(Meal.eaten_at, Meal.id)
    )
    return [meal_json(item) for item in session.scalars(query)]


def sync_observations(session: Session, payload: SyncRequest) -> dict:
    values = [
        {
            "source": payload.source,
            "date": item.date,
            "metric": item.metric.value,
            "value": item.value,
        }
        for item in payload.observations
    ]
    statement = upsert_insert(DailyObservation, session.bind.dialect.name).values(values)
    session.execute(
        statement.on_conflict_do_update(
            index_elements=["source", "date", "metric"],
            set_={"value": statement.excluded.value},
        )
    )
    session.commit()
    return {"source": payload.source, "upserted": len(values)}


def source_priority(source: str) -> tuple[int, str]:
    return {"apple_health": 0, "manual": 1}.get(source, 2), source


def chosen_observations(session: Session, start: date, end: date) -> dict:
    query = select(DailyObservation).where(
        DailyObservation.date >= start, DailyObservation.date <= end
    )
    result = {}
    for observation in session.scalars(query):
        key = (observation.date, observation.metric)
        current = result.get(key)
        if current is None or source_priority(observation.source) < source_priority(current.source):
            result[key] = observation
    return result


def nutrition_totals(meals: list[dict]) -> dict:
    return {
        key: round(sum(meal[key] for meal in meals), 6)
        if meals and all(meal[key] is not None for meal in meals)
        else None
        for key in NUTRITION_FIELDS
    }


def goal_remaining(goal: float | None, actual: float | None) -> float | None:
    return None if goal is None or actual is None else max(round(goal - actual, 6), 0)


def daily_summary(session: Session, day: date) -> dict:
    profile = get_profile(session)
    meals = list_meals(session, day, day, profile.timezone)
    nutrition = nutrition_totals(meals)
    chosen = chosen_observations(session, day, day)
    metrics = {
        metric.value: chosen[(day, metric)].value if (day, metric) in chosen else None
        for metric in Metric
    }
    sources = {
        metric.value: chosen[(day, metric)].source if (day, metric) in chosen else None
        for metric in Metric
    }
    remaining = {
        "calories_kcal": goal_remaining(profile.calorie_goal_kcal, nutrition["calories_kcal"]),
        "protein_g": goal_remaining(profile.protein_goal_g, nutrition["protein_g"]),
        "steps": goal_remaining(profile.steps_goal, metrics["steps"]),
        "sleep_minutes": goal_remaining(profile.sleep_goal_minutes, metrics["sleep_minutes"]),
        "weight_kg_to_target": None
        if profile.target_weight_kg is None or metrics["weight_kg"] is None
        else round(metrics["weight_kg"] - profile.target_weight_kg, 6),
    }
    return {
        "date": day.isoformat(),
        "timezone": profile.timezone,
        "meals": meals,
        "nutrition": nutrition,
        "goals": {key: getattr(profile, key) for key in GOAL_FIELDS},
        "remaining": remaining,
        "metrics": metrics,
        "sources": sources,
    }


def trends(session: Session, metric: str, start: date, end: date) -> dict:
    validate_date_range(start, end)
    profile = get_profile(session)
    by_day = {}
    if metric in NUTRITION_FIELDS:
        for meal in list_meals(session, start, end, profile.timezone):
            meal_day = (
                datetime.fromisoformat(meal["eaten_at"])
                .astimezone(ZoneInfo(profile.timezone))
                .date()
            )
            by_day.setdefault(meal_day, []).append(meal)
    else:
        chosen = chosen_observations(session, start, end)
    points = []
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        if metric in NUTRITION_FIELDS:
            value = nutrition_totals(by_day.get(day, []))[metric]
            source = "meal_log" if value is not None else None
        else:
            observation = chosen.get((day, metric))
            value = observation.value if observation is not None else None
            source = observation.source if observation is not None else None
        points.append({"date": day.isoformat(), "value": value, "source": source})
    return {"metric": metric, "start": start.isoformat(), "end": end.isoformat(), "points": points}
