# Multi-stage Dockerfile for County LLM DLP AWS Backend (ECS Fargate)
FROM python:3.12-slim as base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_DIR=/opt/dlp

WORKDIR ${APP_DIR}

RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    sqlite3 \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements_aws.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements_aws.txt

COPY . ${APP_DIR}/

RUN useradd --system --home ${APP_DIR} --shell /usr/sbin/nologin dlpuser && \
    mkdir -p /var/lib/dlp /var/log/dlp/reports && \
    chown -R dlpuser:dlpuser ${APP_DIR} /var/lib/dlp /var/log/dlp/reports

USER dlpuser

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8787/health || exit 1

CMD ["python3", "-m", "uvicorn", "receiver_aws:app", "--host", "0.0.0.0", "--port", "8787"]
