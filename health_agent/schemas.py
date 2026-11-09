"""Strict, bounded request contracts used by the API and local clients."""

import math
import re
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated

from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from health_agent.config import validate_timezone


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, hide_input_in_errors=True)


class Metric(StrEnum):
    WEIGHT_KG = "weight_kg"
    STEPS = "steps"
    ACTIVE_ENERGY_KCAL = "active_energy_kcal"
    SLEEP_MINUTES = "sleep_minutes"
    RESTING_HEART_RATE_BPM = "resting_heart_rate_bpm"
    WORKOUT_MINUTES = "workout_minutes"


class TrendMetric(StrEnum):
    WEIGHT_KG = "weight_kg"
    STEPS = "steps"
    ACTIVE_ENERGY_KCAL = "active_energy_kcal"
    SLEEP_MINUTES = "sleep_minutes"
    RESTING_HEART_RATE_BPM = "resting_heart_rate_bpm"
    WORKOUT_MINUTES = "workout_minutes"
    CALORIES_KCAL = "calories_kcal"
    PROTEIN_G = "protein_g"
    CARBS_G = "carbs_g"
    FAT_G = "fat_g"


METRIC_BOUNDS = {
    "weight_kg": (1, 500),
    "steps": (0, 200000),
    "active_energy_kcal": (0, 30000),
    "sleep_minutes": (0, 1440),
    "resting_heart_rate_bpm": (20, 250),
    "workout_minutes": (0, 1440),
}

Calories = Annotated[float, Field(strict=True, ge=0, le=30000)]
Protein = Annotated[float, Field(strict=True, ge=0, le=2000)]
Carbs = Annotated[float, Field(strict=True, ge=0, le=5000)]
Fat = Annotated[float, Field(strict=True, ge=0, le=2000)]
Description = Annotated[str, Field(strict=True, min_length=1, max_length=2000)]


def require_offset_timestamp(value):
    try:
        parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
        if not isinstance(parsed, datetime) or parsed.utcoffset() is None:
            raise ValueError
        if not 1900 <= parsed.year <= 9998:
            raise ValueError
    except (ValueError, TypeError, OverflowError):
        raise ValueError(
            "eaten_at must be an ISO timestamp with an explicit offset and supported year"
        ) from None
    return value


def require_iso_date(value):
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("date must use YYYY-MM-DD format")
    return value


ISODate = Annotated[date, BeforeValidator(require_iso_date)]


class MealCreate(RequestModel):
    eaten_at: AwareDatetime
    description: Description
    calories_kcal: Calories
    protein_g: Protein | None = None
    carbs_g: Carbs | None = None
    fat_g: Fat | None = None
    client_request_id: str = Field(strict=True, min_length=1, max_length=128, pattern=r"^\S+$")

    @field_validator("eaten_at", mode="before")
    @classmethod
    def explicit_offset(cls, value):
        return require_offset_timestamp(value)

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("description cannot contain NUL characters")
        value = value.strip()
        if not value:
            raise ValueError("description must contain text")
        return value

    @field_validator("client_request_id")
    @classmethod
    def valid_request_id(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("client_request_id cannot contain NUL characters")
        return value


class MealUpdate(RequestModel):
    eaten_at: AwareDatetime | None = None
    description: Description | None = None
    calories_kcal: Calories | None = None
    protein_g: Protein | None = None
    carbs_g: Carbs | None = None
    fat_g: Fat | None = None

    @field_validator("eaten_at", mode="before")
    @classmethod
    def explicit_offset(cls, value):
        return require_offset_timestamp(value)

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str | None) -> str | None:
        return MealCreate.clean_description(value) if value is not None else value

    @model_validator(mode="after")
    def nonnullable_fields(self):
        for name in ("eaten_at", "description", "calories_kcal"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class ProfileUpdate(RequestModel):
    timezone: str | None = Field(default=None, max_length=100)
    calorie_goal_kcal: Annotated[float, Field(strict=True, gt=0, le=30000)] | None = None
    protein_goal_g: Annotated[float, Field(strict=True, gt=0, le=2000)] | None = None
    steps_goal: Annotated[int, Field(strict=True, gt=0, le=200000)] | None = None
    sleep_goal_minutes: Annotated[float, Field(strict=True, gt=0, le=1440)] | None = None
    target_weight_kg: Annotated[float, Field(strict=True, ge=1, le=500)] | None = None

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("timezone cannot be null")
        return validate_timezone(value)


class Observation(RequestModel):
    date: ISODate
    metric: Metric
    value: float = Field(strict=True)

    @field_validator("date")
    @classmethod
    def supported_date(cls, value: date) -> date:
        if not 1900 <= value.year <= 9998:
            raise ValueError("date year must be between 1900 and 9998")
        return value

    @model_validator(mode="after")
    def bounded_value(self):
        minimum, maximum = METRIC_BOUNDS[self.metric]
        if not math.isfinite(self.value) or not minimum <= self.value <= maximum:
            raise ValueError("metric value is outside its supported finite range")
        if self.metric == Metric.STEPS and not self.value.is_integer():
            raise ValueError("steps must be a whole number")
        return self


class SyncRequest(RequestModel):
    source: str = Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    observations: list[Observation] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def unique_observations(self):
        keys = [(item.date, item.metric) for item in self.observations]
        if len(set(keys)) != len(keys):
            raise ValueError("each date/metric must occur only once in a sync batch")
        return self
