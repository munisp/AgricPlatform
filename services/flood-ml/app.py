"""
IBM Granite Geospatial ML Service
FastAPI application for running Granite model inference
"""
import os
import json
from datetime import datetime, timedelta
from typing import Literal, Optional

try:
    import redis
except ImportError:
    redis = None
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from dotenv import load_dotenv
    # Load environment variables
    load_dotenv()
except ImportError:
    pass

# Import custom modules. The model wrapper is imported separately from the
# Sentinel Hub preprocessing stack so the model's pure helpers (severity /
# alert text) stay usable even when the satellite client deps are missing.
try:
    from models.flood_detection import FloodDetectionModel, ModelLoadError
    FLOOD_MODEL_AVAILABLE = True
except ImportError as e:
    print(f"Warning: Could not import flood detection model: {e}")
    FLOOD_MODEL_AVAILABLE = False

try:
    from preprocessing.sentinel_hub import (
        SentinelHubClient,
        NoImageryAvailableError,
        create_time_range,
    )
    from preprocessing.image_processing import GranitePreprocessor, PostProcessor
    PREPROCESSING_AVAILABLE = True
except ImportError as e:
    print(f"Warning: Could not import preprocessing modules: {e}")
    PREPROCESSING_AVAILABLE = False

    class NoImageryAvailableError(ValueError):
        """Fallback so the except-clauses below work when the preprocessing
        stack is not installed (never raised in that case)."""

# Initialize FastAPI app
app = FastAPI(
    title="Granite Geospatial ML Service",
    description="AI-powered satellite imagery analysis for agriculture",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Redis client for caching (optional dependency)
redis_client = None
REDIS_AVAILABLE = False
if redis is not None:
    try:
        redis_client = redis.Redis(
            host=os.getenv("REDIS_HOST", "localhost"),
            port=int(os.getenv("REDIS_PORT", "6379")),
            decode_responses=True
        )
        redis_client.ping()
        REDIS_AVAILABLE = True
        print("Redis connection established")
    except Exception as e:
        print(f"Warning: Redis not available: {e}")
        redis_client = None
else:
    print("Warning: redis package not installed; result caching disabled")

# Global model instances (lazy loading)
flood_model = None
sentinel_client = None
preprocessor = None


# Request/Response Models
class FloodDetectionRequest(BaseModel):
    """Request model for flood detection"""
    latitude: float = Field(..., description="Latitude of center point")
    longitude: float = Field(..., description="Longitude of center point")
    bbox_size_km: float = Field(default=5.0, description="Size of bounding box in km")
    date: Optional[str] = Field(default=None, description="Date for imagery (ISO format)")
    days_back: int = Field(default=7, description="Days to look back for imagery")


class FloodDetectionResponse(BaseModel):
    """Response model for flood detection"""
    flood_detected: bool
    severity: str
    flood_percentage: float
    flood_area_km2: float
    avg_confidence: float
    timestamp: str
    location: dict
    message: str
    recommended_actions: list
    basis: Literal["live", "mock"] = Field(
        ...,
        description=(
            "Provenance of the result: 'live' = real model inference over "
            "satellite imagery, 'mock' = simulated fixture data"
        ),
    )


class HealthResponse(BaseModel):
    """Response model for health check"""
    status: str
    models_loaded: bool
    model_weights_loaded: bool
    sentinel_hub_configured: bool
    redis_available: bool


# Helper Functions
def get_flood_model():
    """Lazy load flood detection model.

    Fails closed: if the model weights cannot be loaded this raises
    HTTPException(503) — requests are never served fabricated predictions.
    """
    global flood_model
    if flood_model is None:
        if not FLOOD_MODEL_AVAILABLE:
            raise HTTPException(
                status_code=503,
                detail="ML modules not available. Please install dependencies."
            )
        try:
            flood_model = FloodDetectionModel()
        except ModelLoadError as e:
            print(f"Flood detection model failed to load: {e}")
            raise HTTPException(
                status_code=503,
                detail="Flood detection model unavailable: model weights failed to load"
            )
    return flood_model


def get_sentinel_client():
    """Lazy load Sentinel Hub client"""
    global sentinel_client
    if sentinel_client is None:
        if not PREPROCESSING_AVAILABLE:
            raise HTTPException(
                status_code=503,
                detail="Sentinel Hub client not available"
            )
        
        client_id = os.getenv("SENTINEL_HUB_CLIENT_ID")
        client_secret = os.getenv("SENTINEL_HUB_CLIENT_SECRET")
        instance_id = os.getenv("SENTINEL_HUB_INSTANCE_ID")
        
        if not all([client_id, client_secret]):
            raise HTTPException(
                status_code=503,
                detail="Sentinel Hub credentials not configured"
            )
        
        sentinel_client = SentinelHubClient(client_id, client_secret, instance_id)
    return sentinel_client


def get_preprocessor():
    """Lazy load preprocessor"""
    global preprocessor
    if preprocessor is None:
        if not PREPROCESSING_AVAILABLE:
            raise HTTPException(
                status_code=503,
                detail="Preprocessor not available"
            )
        preprocessor = GranitePreprocessor()
    return preprocessor


def create_bbox_from_coords(lat: float, lon: float, size_km: float):
    """Create bounding box from coordinates"""
    client = get_sentinel_client()
    return client.create_bbox(lat, lon, size_km)


# API Endpoints
@app.get("/", tags=["Root"])
async def root():
    """Root endpoint"""
    return {
        "service": "Granite Geospatial ML Service",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """Health check endpoint.

    Status is derived from the actual capability flags — it is only
    "healthy" when the model weights are genuinely loaded, Sentinel Hub is
    configured and Redis is reachable; otherwise "degraded" (or "unhealthy"
    when the model code cannot even be imported).
    """
    sentinel_configured = all([
        os.getenv("SENTINEL_HUB_CLIENT_ID"),
        os.getenv("SENTINEL_HUB_CLIENT_SECRET")
    ])

    # The model object existing is not proof of loaded weights — check the
    # flag the model sets only after a successful load.
    weights_loaded = bool(
        flood_model is not None and getattr(flood_model, "weights_loaded", False)
    )

    if not FLOOD_MODEL_AVAILABLE:
        status = "unhealthy"
    elif weights_loaded and sentinel_configured and REDIS_AVAILABLE:
        status = "healthy"
    else:
        status = "degraded"

    return HealthResponse(
        status=status,
        models_loaded=flood_model is not None,
        model_weights_loaded=weights_loaded,
        sentinel_hub_configured=sentinel_configured,
        redis_available=REDIS_AVAILABLE
    )


@app.post("/api/flood-detection", response_model=FloodDetectionResponse, tags=["Flood Detection"])
async def detect_flood(request: FloodDetectionRequest):
    """
    Detect flood in specified area using satellite imagery
    
    This endpoint:
    1. Fetches Sentinel-2 and Sentinel-1 satellite imagery
    2. Preprocesses the data for the Granite flood detection model
    3. Runs inference to detect flooded areas
    4. Returns detailed flood statistics and recommendations
    """
    # Check cache first
    cache_key = f"flood:{request.latitude}:{request.longitude}:{request.date}:{request.bbox_size_km}"
    if REDIS_AVAILABLE and redis_client:
        cached = redis_client.get(cache_key)
        if cached:
            print(f"Cache hit for {cache_key}")
            return FloodDetectionResponse(**json.loads(cached))
    
    try:
        # Load models and clients
        model = get_flood_model()
        client = get_sentinel_client()
        prep = get_preprocessor()
        
        # Create bounding box
        bbox = create_bbox_from_coords(
            request.latitude,
            request.longitude,
            request.bbox_size_km
        )
        
        # Determine time range
        if request.date:
            try:
                date = datetime.fromisoformat(request.date)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date format. Use ISO format (YYYY-MM-DD)")
        else:
            date = datetime.now()
        
        time_range = (date - timedelta(days=request.days_back), date)
        
        # Fetch satellite imagery
        print(f"Fetching Sentinel-2 imagery for {request.latitude}, {request.longitude}")
        sentinel2_data = client.get_sentinel2_imagery(bbox, time_range)
        
        print(f"Fetching Sentinel-1 SAR imagery for {request.latitude}, {request.longitude}")
        sentinel1_data = client.get_sentinel1_sar(bbox, time_range)
        
        # Preprocess
        print("Preprocessing imagery...")
        input_tensor = prep.prepare_flood_detection_input(sentinel2_data, sentinel1_data)
        
        # Run inference
        print("Running flood detection inference...")
        prediction_mask, probabilities = model.predict(input_tensor)
        
        # Calculate statistics
        statistics = model.get_flood_statistics(prediction_mask, probabilities)
        
        # Get severity and create alert
        severity = model.get_flood_severity(statistics['flood_percentage'])
        alert = model.create_flood_alert(
            statistics,
            {'latitude': request.latitude, 'longitude': request.longitude}
        )
        
        # Prepare response
        response = FloodDetectionResponse(
            flood_detected=statistics['flood_detected'],
            severity=severity,
            flood_percentage=statistics['flood_percentage'],
            flood_area_km2=statistics['flood_area_km2'],
            avg_confidence=statistics['avg_confidence'],
            timestamp=date.isoformat(),
            location={'latitude': request.latitude, 'longitude': request.longitude},
            message=alert['message'],
            recommended_actions=alert['recommended_actions'],
            basis="live"
        )

        # Cache result for 1 hour
        if REDIS_AVAILABLE and redis_client:
            redis_client.setex(cache_key, 3600, response.model_dump_json())

        return response

    except HTTPException:
        # Deliberate HTTP errors (503 model/sentinel unavailable, 400 bad
        # request, ...) must propagate unchanged — never mask them as 500.
        raise
    except NoImageryAvailableError as e:
        # The upstream provider has no observation for this window — that is
        # a service-availability problem, not a client error.
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Log internally but do not leak internal detail to the client.
        print(f"Error in flood detection: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/flood-detection/mock", response_model=FloodDetectionResponse, tags=["Flood Detection"])
async def mock_flood_detection(
    latitude: float,
    longitude: float,
    bbox_size_km: float = 5.0
):
    """
    Mock flood detection endpoint for testing without Sentinel Hub.
    Returns simulated flood detection results, explicitly labelled
    basis="mock". Disabled when FLOOD_ML_ENV=production.
    """
    # Simulated data must never be served in production.
    if os.getenv("FLOOD_ML_ENV", "").strip().lower() == "production":
        raise HTTPException(status_code=404, detail="Not found")

    if not FLOOD_MODEL_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="ML modules not available. Please install dependencies."
        )

    import numpy as np

    # Deterministic per-coordinate fixture without mutating global RNG state.
    seed = abs(int(latitude * 1000 + longitude * 1000))
    rng = np.random.default_rng(seed)
    flood_percentage = float(rng.uniform(0, 30))
    flood_area_km2 = (bbox_size_km * bbox_size_km) * (flood_percentage / 100)

    severity = FloodDetectionModel.get_flood_severity(flood_percentage)

    statistics = {
        'flood_detected': flood_percentage > 1.0,
        'flood_percentage': flood_percentage,
        'flood_area_km2': flood_area_km2,
        'avg_confidence': float(rng.uniform(0.7, 0.95))
    }

    alert = FloodDetectionModel.create_flood_alert(
        statistics,
        {'latitude': latitude, 'longitude': longitude}
    )

    return FloodDetectionResponse(
        flood_detected=statistics['flood_detected'],
        severity=severity,
        flood_percentage=flood_percentage,
        flood_area_km2=flood_area_km2,
        avg_confidence=statistics['avg_confidence'],
        timestamp=datetime.now().isoformat(),
        location={'latitude': latitude, 'longitude': longitude},
        message=alert['message'],
        recommended_actions=alert['recommended_actions'],
        basis="mock"
    )

# --- AgricPlatform additions (wave ML) -------------------------------------
# Canonical aliases so the platform API has a stable contract regardless of
# the upstream route layout: /healthz for liveness, /predict for inference.

@app.get("/healthz", response_model=HealthResponse, tags=["Health"])
async def healthz():
    """Liveness probe alias of /health (compose healthcheck target)."""
    return await health_check()


@app.post("/predict", response_model=FloodDetectionResponse, tags=["Flood Detection"])
async def predict(request: FloodDetectionRequest):
    """Canonical flood-detection inference endpoint (alias of /api/flood-detection)."""
    return await detect_flood(request)


# Run with: uvicorn app:app --host 0.0.0.0 --port 8001
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
