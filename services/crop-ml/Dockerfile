FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

# Dependencies first for layer caching. No system packages needed:
# no rasterio/GDAL — the service consumes band statistics, not rasters.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --system --uid 10001 --home /srv cropml \
    && chown -R cropml:cropml /srv
USER cropml

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/healthz')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
