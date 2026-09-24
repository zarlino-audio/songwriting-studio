FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

WORKDIR /app

# numpy/scipy/av wheels carry everything the service needs (PyAV ships FFmpeg).
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8080

# The container sleeps when idle (see sleepAfter in the Container class), so the
# healthcheck only runs while an instance is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status==200 else 1)"

CMD ["python", "-m", "app.server", "--host", "0.0.0.0", "--port", "8080"]
