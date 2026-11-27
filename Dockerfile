# syntax=docker/dockerfile:1
#
# Self-contained deploy: this file is all you need. The app's code is cloned
# from GitHub at build time and updated with `git pull` on every container start.
#
#   docker build -t satisfactory-planner .
#   docker run -d --name planner -p 8080:8000 -v planner-plans:/data/plans --restart unless-stopped satisfactory-planner
#
# Restart the container to pick up the latest commit: docker restart planner
# Set GIT_PULL=false to stay on the current checkout; REPO_URL / REPO_BRANCH to use a fork.

FROM python:3.12-slim

ARG REPO_URL=https://github.com/frankseibel73/satisfactory-planner.git
ARG REPO_BRANCH=main

ENV REPO_URL=${REPO_URL} \
    REPO_BRANCH=${REPO_BRANCH} \
    GIT_PULL=true \
    PLANS_DIR=/data/plans \
    VIRTUAL_ENV=/srv/venv \
    PATH=/srv/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home planner \
 && mkdir -p /srv /data/plans \
 && chown -R planner /srv /data

COPY --chmod=755 <<'EOF' /usr/local/bin/start-planner
#!/bin/sh
set -e
cd /srv

if [ ! -d app/.git ]; then
  echo "Cloning $REPO_URL ($REPO_BRANCH)"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" app
elif [ "$GIT_PULL" = "true" ]; then
  echo "Updating from $REPO_URL ($REPO_BRANCH)"
  if git -C app fetch --depth 1 origin "$REPO_BRANCH"; then
    git -C app reset --hard FETCH_HEAD
  else
    echo "WARNING: git fetch failed; starting with the existing checkout" >&2
  fi
fi
echo "Running commit $(git -C app rev-parse --short HEAD)"

# Reinstall Python dependencies only when requirements.txt changes.
REQ_HASH=$(sha256sum app/requirements.txt | cut -d' ' -f1)
if [ "$REQ_HASH" != "$(cat venv/.requirements-hash 2>/dev/null)" ]; then
  echo "Installing Python dependencies"
  pip install --no-cache-dir -r app/requirements.txt
  echo "$REQ_HASH" > venv/.requirements-hash
fi

cd app
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
EOF

USER planner
WORKDIR /srv

# Pre-clone and install at build time so the first start is fast and works offline.
RUN python -m venv /srv/venv \
 && git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" app \
 && pip install --no-cache-dir -r app/requirements.txt \
 && sha256sum app/requirements.txt | cut -d' ' -f1 > venv/.requirements-hash

EXPOSE 8000
VOLUME ["/data/plans"]
CMD ["start-planner"]
