FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend modules + the static frontend it serves.
COPY backend/main.py backend/verify_ls.py backend/corrections_store.py ./
COPY frontend ./frontend

# Cloud Run / most platforms inject PORT; default to 8000 locally.
ENV PORT=8000
EXPOSE 8000

# main.py adds its own dir to sys.path, so `main:app` resolves the siblings.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
