# Dockerfile for ouro-mini nodes
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm i || true
COPY . .
EXPOSE 4001 4002 4003 5001 5002 5003
CMD ["sh", "-c", "npm run node1 & npm run node2 & npm run node3 && wait"]
