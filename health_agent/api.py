"""Authenticated single-user FastAPI boundary; no health data is public."""

import secrets
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Path, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from health_agent import service
from health_agent.config import Settings
from health_agent.db import initialize_database
from health_agent.schemas import (
    ISODate,
    MealCreate,
    MealUpdate,
    ProfileUpdate,
    SyncRequest,
    TrendMetric,
)

MealId = Annotated[int, Path(ge=1, le=2147483647)]


def create_app(settings: Settings) -> FastAPI:
    engine, factory = initialize_database(settings)
    app = FastAPI(
        title="Private Personal Health Agent",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.engine = engine
    app.state.session_factory = factory
    app.state.settings = settings
    bearer = HTTPBearer(auto_error=False)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, error: RequestValidationError):
        # Pydantic errors normally echo request inputs, which may contain private health data.
        detail = [
            {key: item[key] for key in ("type", "loc", "msg") if key in item}
            for item in error.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": detail})

    def authenticated(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        if (
            credentials is None
            or credentials.scheme.lower() != "bearer"
            or not secrets.compare_digest(
                credentials.credentials.encode("utf-8"),
                settings.api_token.get_secret_value().encode("utf-8"),
            )
        ):
            raise HTTPException(
                401, "invalid or missing bearer token", headers={"WWW-Authenticate": "Bearer"}
            )

    def session():
        with factory() as database_session:
            yield database_session

    database = Annotated[Session, Depends(session)]
    protected = [Depends(authenticated)]

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/v1/profile", dependencies=protected)
    def profile_get(db: database):
        return service.profile_json(service.get_profile(db))

    @app.patch("/v1/profile", dependencies=protected)
    def profile_patch(patch: ProfileUpdate, db: database):
        return service.update_profile(db, patch)

    @app.get("/v1/meals", dependencies=protected)
    def meals_get(db: database, start: ISODate | None = None, end: ISODate | None = None):
        profile = service.get_profile(db)
        start = start or end or service.local_today(profile.timezone)
        end = end or start
        return service.list_meals(db, start, end, profile.timezone)

    @app.post("/v1/meals", dependencies=protected)
    def meal_post(payload: MealCreate, db: database, response: Response):
        result, created = service.create_meal(db, payload)
        response.status_code = 201 if created else 200
        return result

    @app.patch("/v1/meals/{meal_id}", dependencies=protected)
    def meal_patch(meal_id: MealId, payload: MealUpdate, db: database):
        return service.update_meal(db, meal_id, payload)

    @app.delete("/v1/meals/{meal_id}", dependencies=protected, status_code=204)
    def meal_delete(meal_id: MealId, db: database):
        service.delete_meal(db, meal_id)
        return Response(status_code=204)

    @app.post("/v1/sync", dependencies=protected)
    def sync_post(payload: SyncRequest, db: database):
        return service.sync_observations(db, payload)

    @app.get("/v1/summary", dependencies=protected)
    def summary_get(db: database, day: ISODate | None = None):
        day = day or service.local_today(service.get_profile(db).timezone)
        return service.daily_summary(db, day)

    @app.get("/v1/trends", dependencies=protected)
    def trends_get(metric: TrendMetric, start: ISODate, end: ISODate, db: database):
        return service.trends(db, metric.value, start, end)

    return app


def run():
    import uvicorn

    try:
        settings = Settings()
        app = create_app(settings)
    except (ValidationError, SQLAlchemyError):
        raise SystemExit(
            "Health service configuration or database connection is invalid; check HEALTH_ settings."
        ) from None
    uvicorn.run(app, host=settings.host, port=settings.port, access_log=False)


if __name__ == "__main__":
    run()
