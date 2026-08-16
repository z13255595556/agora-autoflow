FROM python:3.11-slim
WORKDIR /app
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./server/
COPY --chmod=755 deploy/load-db-secret.sh /usr/local/bin/load-db-secret
# 迁移文件要进镜像：服务启动时自动跑
ENV PYTHONPATH=/app/server
EXPOSE 8791
ENTRYPOINT ["/usr/local/bin/load-db-secret"]
CMD ["python", "-m", "uvicorn", "sql_service.main:app", "--host", "0.0.0.0", "--port", "8791", "--app-dir", "server"]
