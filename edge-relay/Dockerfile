FROM node:22-alpine

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy source
COPY src/ ./src/
COPY admin-ui/ ./admin-ui/

# Data directory
RUN mkdir -p /data/logs
ENV RELAY_DATA_DIR=/data
ENV LOG_LEVEL=info
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 18464

VOLUME /data

CMD ["node", "src/main.mjs"]
