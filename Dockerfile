# Single image: compiles the C++20 engine, builds the studio, and serves both from FastAPI.

# ---- 1. React studio -------------------------------------------------------
FROM node:22.11-slim AS studio
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. C++20 engine + pybind11 module -------------------------------------
FROM python:3.12-slim AS engine
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ cmake make \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "pybind11>=2.13"
WORKDIR /src
COPY cpp_engine/ cpp_engine/
COPY scripts/build_cpp.py scripts/
RUN mkdir -p backend/app && python scripts/build_cpp.py
# Gate the image on the engine's own checks: zero overlaps and the MVP's +14 point gain on the shirt.
RUN ./cpp_engine/build/test_bench --dir cpp_engine/testdata --only mens_dress_shirt --require-gain 14

# ---- 3. Runtime ------------------------------------------------------------
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --extra postgres
COPY backend/app/ app/
COPY --from=engine /src/backend/app/_cutzero_core*.so app/
COPY --from=studio /src/frontend/dist /app/frontend/dist
ENV CUTZERO_STATIC_DIR=/app/frontend/dist PATH="/app/backend/.venv/bin:$PATH"
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
