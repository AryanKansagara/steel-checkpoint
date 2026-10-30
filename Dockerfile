FROM python:3.11-slim
WORKDIR /app
COPY checkpoint /app/checkpoint
CMD ["python", "-m", "checkpoint", "demo"]
