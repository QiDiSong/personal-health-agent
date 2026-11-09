"""API behavior against real SQLite, or a disposable PostgreSQL TEST_DATABASE_URL."""

import json
import os

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

TOKEN = "local-test-token-with-more-than-32-characters"
DAY = "2026-11-09"


def settings_for_test(tmp_path):
    from sqlalchemy import create_engine

    from health_agent.config import Settings
    from health_agent.models import Base

    url = os.environ.get("TEST_DATABASE_URL", f"sqlite:///{tmp_path}/health.db")
    settings = Settings(_env_file=None, api_token=TOKEN, database_url=url, timezone="Asia/Shanghai")
    # TEST_DATABASE_URL explicitly opts into resetting our tables in a disposable test DB.
    engine = create_engine(settings.database_url)
    Base.metadata.drop_all(engine)
    engine.dispose()
    return settings


@pytest.fixture
def app(tmp_path):
    from health_agent.api import create_app

    application = create_app(settings_for_test(tmp_path))
    yield application
    application.state.engine.dispose()


@pytest.fixture
def client(app):
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as api:
        yield api


def meal(**changes):
    return {
        "eaten_at": "2026-11-09T12:30:00+08:00",
        "description": "用户确认的午餐估算",
        "calories_kcal": 600,
        "protein_g": 30,
        "carbs_g": 70,
        "fat_g": 20,
        "client_request_id": "meal-1",
        **changes,
    }


def sync(client, source="apple_health", observations=None):
    return client.post(
        "/v1/sync",
        json={
            "source": source,
            "observations": observations or [{"date": DAY, "metric": "steps", "value": 5000}],
        },
    )


def summary(client, day=DAY):
    response = client.get("/v1/summary", params={"day": day})
    assert response.status_code == 200, response.text
    return response.json()


def test_health_is_public_but_all_data_routes_require_bearer(app):
    with TestClient(app) as api:
        assert api.get("/healthz").json() == {"status": "ok"}
        for route in ["/docs", "/redoc", "/openapi.json"]:
            assert api.get(route).status_code == 404
        for method, route in [
            ("get", "/v1/profile"),
            ("patch", "/v1/profile"),
            ("get", "/v1/meals"),
            ("post", "/v1/meals"),
            ("patch", "/v1/meals/1"),
            ("delete", "/v1/meals/1"),
            ("post", "/v1/sync"),
            ("get", "/v1/summary"),
            ("get", "/v1/trends"),
        ]:
            response = getattr(api, method)(route)
            assert response.status_code == 401
            assert response.headers["www-authenticate"] == "Bearer"
        for header in ["Bearer wrong", f"Basic {TOKEN}", f"Bearer {TOKEN}x"]:
            assert api.get("/v1/profile", headers={"Authorization": header}).status_code == 401


def test_settings_require_strong_token_and_valid_timezone(monkeypatch):
    from health_agent.config import Settings

    monkeypatch.delenv("HEALTH_API_TOKEN", raising=False)
    for changes in [
        {},
        {"api_token": "short"},
        {"api_token": " " * 40},
        {"api_token": "密码" * 20},
        {"api_token": "x" * 31 + "\x00"},
        {"api_token": TOKEN, "timezone": "Mars/Olympus"},
        {"api_token": TOKEN, "database_url": "https://database.example"},
    ]:
        with pytest.raises(ValidationError):
            Settings(_env_file=None, **changes)
    monkeypatch.setenv("HEALTH_API_TOKEN", TOKEN)
    monkeypatch.setenv("HEALTH_TIMEZONE", "America/New_York")
    settings = Settings(_env_file=None)
    assert settings.timezone == "America/New_York"
    assert TOKEN not in repr(settings)


def test_cli_configuration_failure_exits_without_secret_traceback(monkeypatch):
    from health_agent.api import run

    monkeypatch.setenv("HEALTH_API_TOKEN", "DO_NOT_PRINT_SECRET")
    with pytest.raises(SystemExit) as error:
        run()
    assert error.value.code
    assert "DO_NOT_PRINT_SECRET" not in str(error.value)


def test_database_error_diagnostics_hide_health_parameters(app):
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    with pytest.raises(DBAPIError) as error, app.state.engine.connect() as connection:
        connection.execute(
            text("SELECT * FROM missing_health_table WHERE description = :description"),
            {"description": "PRIVATE_HEALTH_PARAMETER"},
        )
    assert "PRIVATE_HEALTH_PARAMETER" not in str(error.value)
    assert app.state.engine.hide_parameters is True


def test_profile_defaults_patch_and_explicit_goal_clear(client):
    original = client.get("/v1/profile").json()
    assert original == {
        "timezone": "Asia/Shanghai",
        "calorie_goal_kcal": None,
        "protein_goal_g": None,
        "steps_goal": None,
        "sleep_goal_minutes": None,
        "target_weight_kg": None,
    }
    changed = client.patch(
        "/v1/profile", json={"calorie_goal_kcal": 2200, "protein_goal_g": 100, "steps_goal": 8000}
    )
    assert changed.status_code == 200
    assert changed.json()["calorie_goal_kcal"] == 2200
    assert (
        client.patch("/v1/profile", json={"protein_goal_g": None}).json()["protein_goal_g"] is None
    )
    assert client.get("/v1/profile").json()["steps_goal"] == 8000


@pytest.mark.parametrize(
    "patch",
    [
        {"timezone": "bad/zone"},
        {"timezone": None},
        {"calorie_goal_kcal": -1},
        {"steps_goal": 1.5},
        {"steps_goal": True},
        {"sleep_goal_minutes": 1441},
        {"target_weight_kg": 501},
        {"extra": "no"},
    ],
)
def test_invalid_profile_patch_is_atomic(client, patch):
    before = client.get("/v1/profile").json()
    response = client.patch("/v1/profile", json={"protein_goal_g": 100, **patch})
    assert response.status_code == 422
    assert client.get("/v1/profile").json() == before


def test_meal_retry_correction_and_delete(client):
    first = client.post("/v1/meals", json=meal())
    assert first.status_code == 201
    record = first.json()
    assert isinstance(record["id"], int)
    assert record["description"] == "用户确认的午餐估算"
    retry = client.post("/v1/meals", json=meal())
    assert retry.status_code == 200
    assert retry.json() == record
    equivalent = client.post("/v1/meals", json=meal(eaten_at="2026-11-09T04:30:00Z"))
    assert equivalent.json() == record
    assert client.post("/v1/meals", json=meal(calories_kcal=700)).status_code == 409
    updated = client.patch(
        f"/v1/meals/{record['id']}", json={"calories_kcal": 650, "protein_g": None}
    )
    assert updated.status_code == 200
    assert updated.json()["calories_kcal"] == 650
    assert updated.json()["protein_g"] is None
    assert client.post("/v1/meals", json=meal()).json()["id"] == record["id"]
    listed = client.get("/v1/meals", params={"start": DAY, "end": DAY}).json()
    assert len(listed) == 1
    assert listed[0]["calories_kcal"] == 650
    assert client.delete(f"/v1/meals/{record['id']}").status_code == 204
    assert client.get("/v1/meals", params={"start": DAY, "end": DAY}).json() == []
    assert client.post("/v1/meals", json=meal()).status_code == 409
    assert client.patch(f"/v1/meals/{record['id']}", json={"calories_kcal": 1}).status_code == 404


@pytest.mark.parametrize(
    "changes",
    [
        {"eaten_at": "2026-11-09T12:30:00"},
        {"eaten_at": 1794198600},
        {"description": " "},
        {"calories_kcal": -1},
        {"protein_g": -1},
        {"calories_kcal": True},
        {"client_request_id": ""},
        {"unexpected": 1},
    ],
)
def test_invalid_meals_are_rejected_without_records(client, changes):
    assert client.post("/v1/meals", json=meal(**changes)).status_code == 422
    assert summary(client)["meals"] == []


def test_invalid_meal_correction_changes_nothing(client):
    record = client.post("/v1/meals", json=meal()).json()
    for patch in [
        {"calories_kcal": None},
        {"eaten_at": None},
        {"description": None},
        {"calories_kcal": -1},
        {"client_request_id": "different"},
    ]:
        assert client.patch(f"/v1/meals/{record['id']}", json=patch).status_code == 422
    assert summary(client)["meals"] == [record]
    assert client.delete("/v1/meals/999999").status_code == 404


@pytest.mark.parametrize("meal_id", [-1, 0, 2147483648, 10**30])
def test_out_of_database_range_meal_ids_are_rejected(client, meal_id):
    record = client.post("/v1/meals", json=meal()).json()
    assert client.patch(f"/v1/meals/{meal_id}", json={"calories_kcal": 1}).status_code == 422
    assert client.delete(f"/v1/meals/{meal_id}").status_code == 422
    assert summary(client)["meals"] == [record]


def test_largest_supported_meal_id_is_valid_but_missing(client):
    assert client.patch("/v1/meals/2147483647", json={"calories_kcal": 1}).status_code == 404
    assert client.delete("/v1/meals/2147483647").status_code == 404


@pytest.mark.parametrize(
    "changes",
    [
        {"description": "PRIVATE_DESCRIPTION\x00DETAIL"},
        {"client_request_id": "PRIVATE_REQUEST\x00ID"},
    ],
)
def test_nul_text_is_rejected_before_database_without_echoing_input(client, caplog, changes):
    response = client.post("/v1/meals", json=meal(**changes))
    assert response.status_code == 422
    assert "PRIVATE_" not in response.text
    assert "PRIVATE_" not in caplog.text
    assert summary(client)["meals"] == []


def test_nul_description_correction_is_rejected_without_changing_meal(client, caplog):
    record = client.post("/v1/meals", json=meal()).json()
    response = client.patch(
        f"/v1/meals/{record['id']}",
        json={
            "description": "PRIVATE_CORRECTION\x00DETAIL",
            "calories_kcal": 1,
        },
    )
    assert response.status_code == 422
    assert "PRIVATE_" not in response.text
    assert "PRIVATE_" not in caplog.text
    assert summary(client)["meals"] == [record]


def test_inclusive_local_days_convert_offsets_and_follow_profile_timezone(client):
    for request_id, timestamp in [
        ("before", "2026-11-08T15:59:59Z"),
        ("start", "2026-11-08T16:00:00Z"),
        ("last", "2026-11-09T15:59:59.999999Z"),
        ("after", "2026-11-09T16:00:00Z"),
    ]:
        assert (
            client.post(
                "/v1/meals", json=meal(client_request_id=request_id, eaten_at=timestamp)
            ).status_code
            == 201
        )
    selected = client.get("/v1/meals", params={"start": DAY, "end": DAY}).json()
    assert [m["client_request_id"] for m in selected] == ["start", "last"]
    client.patch("/v1/profile", json={"timezone": "UTC"})
    assert [m["client_request_id"] for m in summary(client)["meals"]] == ["last", "after"]


def test_dst_day_uses_local_midnights_instead_of_24_hours(client):
    client.patch("/v1/profile", json={"timezone": "America/New_York"})
    for request_id, timestamp in [
        ("start", "2026-11-01T04:00:00Z"),
        ("extra-hour", "2026-11-02T04:30:00Z"),
        ("next", "2026-11-02T05:00:00Z"),
    ]:
        client.post("/v1/meals", json=meal(client_request_id=request_id, eaten_at=timestamp))
    assert [m["client_request_id"] for m in summary(client, "2026-11-01")["meals"]] == [
        "start",
        "extra-hour",
    ]


def test_sync_replaces_snapshots_and_chooses_sources_without_double_counting(client):
    assert sync(client, "z_watch").status_code == 200
    assert (
        sync(client, "a_watch", [{"date": DAY, "metric": "steps", "value": 3000}]).status_code
        == 200
    )
    assert summary(client)["metrics"]["steps"] == 3000
    assert summary(client)["sources"]["steps"] == "a_watch"
    sync(client, "manual", [{"date": DAY, "metric": "steps", "value": 4000}])
    assert summary(client)["metrics"]["steps"] == 4000
    sync(client, "apple_health", [{"date": DAY, "metric": "steps", "value": 6000}])
    for _ in range(2):
        response = sync(client, "apple_health", [{"date": DAY, "metric": "steps", "value": 6500}])
        assert response.json() == {"source": "apple_health", "upserted": 1}
    actual = summary(client)
    assert actual["metrics"]["steps"] == 6500
    assert actual["sources"]["steps"] == "apple_health"
    assert actual["metrics"]["weight_kg"] is None


@pytest.mark.parametrize(
    "observation",
    [
        {"date": DAY, "metric": "unsupported", "value": 1},
        {"date": DAY, "metric": "steps", "value": -1},
        {"date": DAY, "metric": "steps", "value": 1.5},
        {"date": DAY, "metric": "steps", "value": True},
        {"date": DAY, "metric": "weight_kg", "value": 0},
        {"date": DAY, "metric": "sleep_minutes", "value": 1441},
        {"date": DAY, "metric": "resting_heart_rate_bpm", "value": 10},
        {"date": DAY, "metric": "active_energy_kcal", "value": 30001},
        {"date": DAY, "metric": "workout_minutes", "value": 1441},
    ],
)
def test_invalid_sync_batch_is_atomic(client, observation):
    sync(client)
    response = sync(
        client, observations=[{"date": DAY, "metric": "steps", "value": 7000}, observation]
    )
    assert response.status_code == 422
    assert summary(client)["metrics"]["steps"] == 5000


def test_duplicate_snapshots_and_invalid_source_and_oversized_batches_are_rejected(client):
    observation = {"date": DAY, "metric": "steps", "value": 12}
    for payload in [
        {"source": "apple_health", "observations": [observation, observation]},
        {"source": "../../unsafe", "observations": [observation]},
        {"source": "apple_health", "observations": []},
        {"source": "apple_health", "observations": [observation] * 1001},
    ]:
        assert client.post("/v1/sync", json=payload).status_code == 422
    assert summary(client)["metrics"]["steps"] is None


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity"])
def test_nonfinite_input_rejected_without_echoing_raw_input(client, value):
    raw = json.dumps(
        {
            "source": "apple_health",
            "observations": [{"date": DAY, "metric": "steps", "value": "REPLACE"}],
        }
    ).replace('"REPLACE"', value)
    response = client.post("/v1/sync", content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]


def test_private_invalid_fields_are_not_echoed_in_errors(client):
    response = client.post("/v1/meals", json=meal(unexpected="PRIVATE_MEDICAL_DETAIL"))
    assert response.status_code == 422
    assert "PRIVATE_MEDICAL_DETAIL" not in response.text
    assert TOKEN not in response.text


def test_sync_date_requires_iso_date_without_numeric_timestamp(client):
    response = sync(client, observations=[{"date": 1794182400, "metric": "steps", "value": 5000}])
    assert response.status_code == 422
    assert summary(client)["metrics"]["steps"] is None


def test_query_dates_require_iso_date_strings(client):
    assert client.get("/v1/summary", params={"day": "1794182400"}).status_code == 422
    assert client.get("/v1/meals", params={"start": "1794182400"}).status_code == 422
    assert (
        client.get(
            "/v1/trends",
            params={
                "metric": "steps",
                "start": "1794182400",
                "end": DAY,
            },
        ).status_code
        == 422
    )


def test_unknown_is_distinct_from_zero_and_remaining_is_based_on_explicit_goals(client):
    empty = summary(client)
    assert all(value is None for value in empty["metrics"].values())
    assert all(value is None for value in empty["nutrition"].values())
    assert all(value is None for value in empty["remaining"].values())
    client.patch(
        "/v1/profile",
        json={
            "calorie_goal_kcal": 2200,
            "protein_goal_g": 100,
            "steps_goal": 8000,
            "sleep_goal_minutes": 480,
            "target_weight_kg": 65,
        },
    )
    sync(
        client,
        observations=[
            {"date": DAY, "metric": "steps", "value": 0},
            {"date": DAY, "metric": "sleep_minutes", "value": 420},
            {"date": DAY, "metric": "weight_kg", "value": 70},
        ],
    )
    client.post("/v1/meals", json=meal())
    actual = summary(client)
    assert actual["nutrition"] == {
        "calories_kcal": 600,
        "protein_g": 30,
        "carbs_g": 70,
        "fat_g": 20,
    }
    assert actual["metrics"]["steps"] == 0
    assert actual["remaining"] == {
        "calories_kcal": 1600,
        "protein_g": 70,
        "steps": 8000,
        "sleep_minutes": 60,
        "weight_kg_to_target": 5,
    }
    client.post("/v1/meals", json=meal(client_request_id="unknown-macros", protein_g=None))
    assert summary(client)["nutrition"]["protein_g"] is None
    assert summary(client)["remaining"]["protein_g"] is None


def test_trends_cover_each_inclusive_day_with_provenance_and_nutrition(client):
    sync(client)
    client.post("/v1/meals", json=meal())
    for metric, expected_value, expected_source in [
        ("steps", 5000, "apple_health"),
        ("calories_kcal", 600, "meal_log"),
    ]:
        response = client.get(
            "/v1/trends", params={"metric": metric, "start": "2026-11-08", "end": "2026-11-10"}
        )
        assert response.status_code == 200
        assert response.json() == {
            "metric": metric,
            "start": "2026-11-08",
            "end": "2026-11-10",
            "points": [
                {"date": "2026-11-08", "value": None, "source": None},
                {"date": DAY, "value": expected_value, "source": expected_source},
                {"date": "2026-11-10", "value": None, "source": None},
            ],
        }


@pytest.mark.parametrize(
    "start,end",
    [
        ("2026-11-10", DAY),
        ("2025-01-01", "2026-01-02"),
        ("invalid", DAY),
        ("9999-12-31", "9999-12-31"),
    ],
)
def test_invalid_or_unrepresentable_date_ranges_are_rejected(client, start, end):
    assert client.get("/v1/meals", params={"start": start, "end": end}).status_code == 422
    assert (
        client.get("/v1/trends", params={"metric": "steps", "start": start, "end": end}).status_code
        == 422
    )


def test_full_366_day_range_is_allowed(client):
    response = client.get(
        "/v1/trends", params={"metric": "weight_kg", "start": "2024-01-01", "end": "2024-12-31"}
    )
    assert response.status_code == 200
    assert len(response.json()["points"]) == 366
    assert response.json()["points"][-1]["date"] == "2024-12-31"


def test_data_survives_new_application_instance(tmp_path):
    from health_agent.api import create_app

    settings = settings_for_test(tmp_path)
    first = create_app(settings)
    with TestClient(first, headers={"Authorization": f"Bearer {TOKEN}"}) as api:
        api.patch("/v1/profile", json={"steps_goal": 9000})
        api.post("/v1/meals", json=meal())
        sync(api)
    first.state.engine.dispose()
    second = create_app(settings)
    with TestClient(second, headers={"Authorization": f"Bearer {TOKEN}"}) as api:
        result = summary(api)
        assert result["goals"]["steps_goal"] == 9000
        assert len(result["meals"]) == 1
        assert result["metrics"]["steps"] == 5000
    second.state.engine.dispose()
