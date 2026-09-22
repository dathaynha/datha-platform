# API default: uvicorn. Worker: same image, override command to `python -m app.worker`.
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini .
COPY alembic ./alembic
COPY app ./app

EXPOSE 8050
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8050"]
