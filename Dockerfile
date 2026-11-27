FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLANS_DIR=/data/plans

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --create-home planner && mkdir -p /data/plans && chown -R planner /data
USER planner

EXPOSE 8000
VOLUME ["/data/plans"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
