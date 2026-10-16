FROM node:24-alpine
WORKDIR /app
COPY server.ts package.json ./
COPY src ./src
COPY public ./public
ENV FREEPOST_HOST=0.0.0.0 FREEPOST_DATA=/data
VOLUME /data
EXPOSE 8700
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8700/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.ts"]
