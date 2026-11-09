# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.lock ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      PIP_CERT=/run/secrets/proxy_ca pip install --no-cache-dir -r requirements.lock; \
    else pip install --no-cache-dir -r requirements.lock; fi
COPY pyproject.toml ./
COPY health_agent ./health_agent
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      PIP_CERT=/run/secrets/proxy_ca pip install --no-cache-dir --no-deps .; \
    else pip install --no-cache-dir --no-deps .; fi \
    && useradd --uid 10001 --create-home health
USER health
EXPOSE 8000
CMD ["health-agent"]
