"""FastAPI application factory + uvicorn entry for the crop-ml sidecar."""
from __future__ import annotations

import uvicorn
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from .config import Settings, load_settings, validate_settings
from .models import (
    AssessPlotRequest,
    AssessPlotResponse,
    HealthScoreRequest,
    HealthScoreResponse,
    ReadyResponse,
    SeasonalityRequest,
    SeasonalityResponse,
)
from .providers.base import ImageryProvider, ImageryProviderError
from .providers.live import LiveImageryProvider
from .providers.stub import StubImageryProvider
from . import service
from .telemetry import setup_telemetry

API_VERSION = "1.0.0"


def build_provider(settings: Settings) -> ImageryProvider | None:
    if settings.imagery_provider == "stub":
        return StubImageryProvider()
    if not settings.live_configured:
        return None
    return LiveImageryProvider(settings)


def create_app(
    settings: Settings | None = None,
    provider: ImageryProvider | None = None,
    *,
    validate_config: bool = True,
) -> FastAPI:
    settings = settings if settings is not None else load_settings()
    if validate_config:
        validate_settings(settings)
    if provider is None:
        provider = build_provider(settings)

    app = FastAPI(title="crop-ml", version=API_VERSION)
    app.state.settings = settings
    app.state.provider = provider
    # OpenTelemetry: no-op-safe (never fatal, collector may be absent).
    app.state.otel_shutdown = setup_telemetry(app, service_name="crop-ml")

    @app.exception_handler(ImageryProviderError)
    async def _provider_error(_: Request, exc: ImageryProviderError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": {"code": exc.code, "message": exc.message}},
        )

    @app.exception_handler(ValueError)
    async def _value_error(_: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": {"code": "UNPROCESSABLE_SERIES", "message": str(exc)}},
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "version": API_VERSION}

    @app.get("/readyz", response_model=ReadyResponse)
    async def readyz() -> ReadyResponse:
        current: ImageryProvider | None = app.state.provider
        if current is None:
            return ReadyResponse(
                status="misconfigured",
                provider={
                    "mode": app.state.settings.imagery_provider,
                    "circuit": "n/a",
                    "detail": "provider selected but not configured; refusing traffic",
                },
            )
        return ReadyResponse(
            status="ready",
            provider={"mode": current.name, "circuit": current.circuit_state()},
        )

    @app.post("/v1/crop/seasonality", response_model=SeasonalityResponse)
    async def seasonality(req: SeasonalityRequest) -> SeasonalityResponse:
        return service.seasonality_analysis(req.plot_id, req.series, req.reference)

    @app.post("/v1/crop/health-score", response_model=HealthScoreResponse)
    async def health_score(req: HealthScoreRequest) -> HealthScoreResponse:
        return service.health_score_analysis(req.plot_id, req.current, req.baseline)

    @app.post("/v1/crop/assess-plot", response_model=AssessPlotResponse)
    async def assess_plot(req: AssessPlotRequest) -> AssessPlotResponse:
        current: ImageryProvider | None = app.state.provider
        if current is None:
            raise ImageryProviderError(
                "IMAGERY_MISCONFIGURED",
                "imagery provider is not configured; see /readyz",
            )
        return service.assess_plot(current, req.plot_id, req.season, req.geometry)

    return app


app = create_app()

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=load_settings().port,
    )
