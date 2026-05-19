FROM node:20-slim
WORKDIR /app
COPY server.mjs ./server.mjs
COPY terms.html ./terms.html
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
